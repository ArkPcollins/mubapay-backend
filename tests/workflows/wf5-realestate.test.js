'use strict';
/** Workflow 5: role application → listing → moderation → search → messaging → viewing → fee → cancellation / no-show. */
const H = require('../helpers/harness');
const ledger = require('../../src/modules/ledger/ledger.service');
const { ViewingAppointment, Property } = require('../../src/modules/realestate/realestate.models');
const appointments = require('../../src/modules/realestate/appointments.service');
const { AuditEvent } = require('../../src/modules/audit/audit.model');

let fake;
let kyc;
let moderator;
beforeAll(async () => {
  await H.start();
  fake = H.fakePaystack();
  kyc = await H.staffUser('verification_officer');
  moderator = await H.staffUser('moderator');
});
afterAll(async () => {
  fake.uninstall();
  await H.stop();
});

const listingBody = (extra = {}) => ({
  title: '3-bedroom bungalow in Amawbia', description: 'Spacious bungalow with POP ceilings, fenced compound, borehole and prepaid meter. Close to the expressway.',
  listingType: 'rent', propertyType: 'bungalow', priceKobo: 150000000, rentPeriod: 'yearly',
  location: { area: 'Amawbia', city: 'Awka', state: 'Anambra', addressPrivate: '7 Hidden Close, Amawbia' }, lat: 6.21, lng: 7.06,
  bedrooms: 3, bathrooms: 3, amenities: ['borehole', 'prepaid meter', 'fenced'], furnishing: 'unfurnished', viewingFee: { required: true, amountKobo: 300000 }, ...extra,
});

async function approvedLandlord() {
  const u = await H.createUser();
  const app = await H.as(u).post('/api/v1/account/role-applications').field('role', 'landlord').field('statement', 'I own two properties in Awka.').attach('documents', Buffer.from('%PDF-1.4 ownership deed'), { filename: 'deed.pdf', contentType: 'application/pdf' });
  expect(app.status).toBe(201);
  const rv = await H.as(kyc).post(`/api/v1/admin/verification/roles/${app.body.data._id}/review`).send({ decision: 'approve', reviewerNotes: 'Deed verified' });
  expect(rv.status).toBe(200);
  const fresh = await require('../../src/modules/users/user.model').User.findById(u.user._id);
  return { ...u, user: fresh };
}

test('landlord/agent capability requires an approved application; listings require review before publication', async () => {
  const notLandlord = await H.createUser();
  expect((await H.as(notLandlord).post('/api/v1/realestate/listings').send(listingBody())).status).toBe(403);
  const unverified = await H.createUser({ tier: 1 });
  const app = await H.as(unverified).post('/api/v1/account/role-applications').field('role', 'landlord');
  expect(app.status).toBe(403); // identity verification first
  const landlord = await approvedLandlord();
  const created = await H.as(landlord).post('/api/v1/realestate/listings').send(listingBody());
  expect(created.status).toBe(201);
  expect(created.body.data.status).toBe('pending_review');
  expect((await H.api().get(`/api/v1/realestate/properties/${created.body.data.slug}`)).status).toBe(404);
  const noConfirm = await H.as(moderator).post(`/api/v1/admin/moderation/properties/${created.body.data._id}`).send({ decision: 'approve' });
  expect(noConfirm.status).toBe(422);
  const ok = await H.as(moderator).post(`/api/v1/admin/moderation/properties/${created.body.data._id}`).send({ decision: 'approve', authorityVerified: true });
  expect(ok.body.data.status).toBe('published');
  const pub = await H.api().get(`/api/v1/realestate/properties/${created.body.data.slug}`);
  expect(pub.status).toBe(200);
  expect(pub.body.data.location.address).toBeUndefined(); // private address hidden from the public
  expect(pub.body.data.mediaTypes).toEqual([]); // no viewers offered for media that doesn't exist
});

test('agents cannot edit listings they are not authorised for; owners can authorise agents', async () => {
  const landlord = await approvedLandlord();
  const p = (await H.as(landlord).post('/api/v1/realestate/listings').send(listingBody({ title: 'Duplex for sale in GRA', listingType: 'sale', propertyType: 'duplex', viewingFee: { required: false, amountKobo: 0 } }))).body.data;
  const agent = await H.createUser({ roles: ['customer', 'agent'], capabilities: { agent: true } });
  const denied = await H.as(agent).patch(`/api/v1/realestate/listings/${p._id}`).send({ priceKobo: 100 });
  expect(denied.status).toBe(404);
  expect(await AuditEvent.exists({ action: 'property.edit_denied', actorId: agent.user._id })).toBeTruthy();
  await H.as(landlord).post(`/api/v1/realestate/listings/${p._id}/agents`).send({ agentEmail: agent.email });
  const allowed = await H.as(agent).patch(`/api/v1/realestate/listings/${p._id}`).send({ priceKobo: 9000000000 });
  expect(allowed.status).toBe(200);
  await H.as(landlord).post(`/api/v1/realestate/listings/${p._id}/agents`).send({ agentEmail: agent.email, revoke: true });
  expect((await H.as(agent).patch(`/api/v1/realestate/listings/${p._id}`).send({ priceKobo: 5000000 })).status).toBe(404);
});

test('search filters, enquiry messaging with contact masking, viewing with fee, late customer cancellation releases fee', async () => {
  const landlord = await approvedLandlord();
  const p = (await H.as(landlord).post('/api/v1/realestate/listings').send(listingBody({ title: 'Searchable flat Ifite' }))).body.data;
  await H.as(moderator).post(`/api/v1/admin/moderation/properties/${p._id}`).send({ decision: 'approve', authorityVerified: true });
  const s = await H.api().get('/api/v1/realestate/properties?listingType=rent&state=Anambra&bedrooms=3&viewingFee=required&amenities=borehole');
  expect(s.body.data.items.some((x) => x.slug === p.slug)).toBe(true);
  const none = await H.api().get('/api/v1/realestate/properties?state=Anambra&bedrooms=9');
  expect(none.body.data.items.some((x) => x.slug === p.slug)).toBe(false);
  const customer = await H.createUser();
  const enq = await H.as(customer).post(`/api/v1/realestate/properties/${p._id}/enquiries`).send({ message: 'Is it available? Call me on 08031234567' });
  expect(enq.status).toBe(201);
  const thread = await H.as(landlord).get(`/api/v1/messages/${enq.body.data.conversationId}`);
  expect(thread.body.data.messages[0].body).toMatch(/\[phone hidden\]/);
  const stranger = await H.createUser();
  expect((await H.as(stranger).get(`/api/v1/messages/${enq.body.data.conversationId}`)).status).toBe(404);
  // viewing
  const slot = new Date(Date.now() + 3 * 3600e3).toISOString();
  const req = await H.as(customer).post(`/api/v1/realestate/properties/${p._id}/viewings`).send({ slots: [slot] });
  expect(req.status).toBe(201);
  const conf = await H.as(landlord).post(`/api/v1/realestate/appointments/${req.body.data.id}/respond`).send({ action: 'confirm', slot });
  expect(conf.body.data.status).toBe('awaiting_payment');
  await H.fundWallet(customer, fake, 500000);
  const pay = await H.as(customer).post(`/api/v1/realestate/appointments/${req.body.data.id}/pay`).set('Idempotency-Key', H.idem()).send({ method: 'wallet' });
  expect(pay.body.data.status).toBe('confirmed');
  expect(await ledger.getBalance(ledger.SYS.VIEWING_CLEARING)).toBeGreaterThanOrEqual(300000);
  // address now revealed to the confirmed viewer only
  expect((await H.as(customer).get(`/api/v1/realestate/properties/${p.slug}`)).body.data.location.address).toBe('7 Hidden Close, Amawbia');
  // customer cancels < 24h before → no refund; fee released to landlord net of 10% commission
  const cx = await H.as(customer).post(`/api/v1/realestate/appointments/${req.body.data.id}/cancel`).send({ reason: 'Something came up' });
  expect(cx.body.data.cancellation.policyApplied).toBe('late_customer_cancellation_no_refund');
  expect(await H.walletBalance(customer.user._id)).toBe(200000);
  expect(await H.walletBalance(landlord.user._id)).toBe(270000);
});

test('provider no-show → full refund; early customer cancellation → full refund; paystack fee path', async () => {
  const landlord = await approvedLandlord();
  const p = (await H.as(landlord).post('/api/v1/realestate/listings').send(listingBody({ title: 'No-show flat' }))).body.data;
  await H.as(moderator).post(`/api/v1/admin/moderation/properties/${p._id}`).send({ decision: 'approve', authorityVerified: true });
  const customer = await H.createUser();
  await H.fundWallet(customer, fake, 300000);
  const slot = new Date(Date.now() + 48 * 3600e3).toISOString();
  const a = (await H.as(customer).post(`/api/v1/realestate/properties/${p._id}/viewings`).send({ slots: [slot] })).body.data;
  await H.as(landlord).post(`/api/v1/realestate/appointments/${a.id}/respond`).send({ action: 'confirm', slot });
  await H.as(customer).post(`/api/v1/realestate/appointments/${a.id}/pay`).set('Idempotency-Key', H.idem()).send({ method: 'wallet' });
  // ≥ 24h before: full refund
  const early = await H.as(customer).post(`/api/v1/realestate/appointments/${a.id}/cancel`).send({ reason: 'Found another place' });
  expect(early.body.data.cancellation.refundKobo).toBe(300000);
  expect(await H.walletBalance(customer.user._id)).toBe(300000);
  // second viewing paid by Paystack, provider doesn't show up
  const slot2 = new Date(Date.now() + 5 * 3600e3).toISOString();
  const b = (await H.as(customer).post(`/api/v1/realestate/properties/${p._id}/viewings`).send({ slots: [slot2] })).body.data;
  await H.as(landlord).post(`/api/v1/realestate/appointments/${b.id}/respond`).send({ action: 'confirm', slot: slot2 });
  const ps = await H.as(customer).post(`/api/v1/realestate/appointments/${b.id}/pay`).set('Idempotency-Key', H.idem()).send({ method: 'paystack' });
  expect(ps.body.data.authorizationUrl).toBeTruthy();
  fake.pay(ps.body.data.paymentReference, { amount: 300000 });
  await require('../../src/modules/payments/payments.service').verifyAndFulfil(ps.body.data.paymentReference);
  expect((await ViewingAppointment.findById(b.id)).status).toBe('confirmed');
  await ViewingAppointment.updateOne({ _id: b.id }, { $set: { scheduledAt: new Date(Date.now() - 3600e3) } });
  const ns = await H.as(customer).post(`/api/v1/realestate/appointments/${b.id}/no-show`).send({ note: 'Nobody came' });
  expect(ns.body.data.status).toBe('no_show_provider');
  expect(await H.walletBalance(customer.user._id)).toBe(600000); // refunded to wallet by default
  await appointments.runReleases();
  expect(await H.walletBalance(landlord.user._id)).toBe(0);
  expect((await ledger.checkInvariants()).ok).toBe(true);
});

test('completed viewing fee is released after the window; property documents are private', async () => {
  const landlord = await approvedLandlord();
  const p = (await H.as(landlord).post('/api/v1/realestate/listings').send(listingBody({ title: 'Release flat' }))).body.data;
  const doc = await H.as(landlord).post(`/api/v1/realestate/listings/${p._id}/documents`).field('category', 'ownership').attach('file', Buffer.from('%PDF-1.4 C of O'), { filename: 'cofo.pdf', contentType: 'application/pdf' });
  expect(doc.status).toBe(201);
  const outsider = await H.createUser();
  expect((await H.as(outsider).post(`/api/v1/account/documents/${doc.body.data.id}/access`)).status).toBe(404);
  const support = await H.staffUser('support_agent');
  expect((await H.as(support).post(`/api/v1/account/documents/${doc.body.data.id}/access`)).status).toBe(404);
  const grant = await H.as(kyc).post(`/api/v1/account/documents/${doc.body.data.id}/access`);
  expect(grant.status).toBe(200);
  const dl = await H.as(kyc).get(`/api/v1/account/documents/download/${grant.body.data.token}`);
  expect(dl.status).toBe(200);
  expect(dl.headers['cache-control']).toMatch(/no-store/);
  expect((await H.as(outsider).get(`/api/v1/account/documents/download/${grant.body.data.token}`)).status).toBe(403); // token bound to the requester
  expect(await AuditEvent.exists({ action: 'document.downloaded', actorId: kyc.user._id, sensitiveRead: true })).toBeTruthy();
  await H.as(moderator).post(`/api/v1/admin/moderation/properties/${p._id}`).send({ decision: 'approve', authorityVerified: true });
  const customer = await H.createUser();
  await H.fundWallet(customer, fake, 300000);
  const slot = new Date(Date.now() + 3 * 3600e3).toISOString();
  const a = (await H.as(customer).post(`/api/v1/realestate/properties/${p._id}/viewings`).send({ slots: [slot] })).body.data;
  await H.as(landlord).post(`/api/v1/realestate/appointments/${a.id}/respond`).send({ action: 'confirm', slot });
  await H.as(customer).post(`/api/v1/realestate/appointments/${a.id}/pay`).set('Idempotency-Key', H.idem()).send({ method: 'wallet' });
  await ViewingAppointment.updateOne({ _id: a.id }, { $set: { scheduledAt: new Date(Date.now() - 30 * 3600e3) } });
  await H.as(customer).post(`/api/v1/realestate/appointments/${a.id}/attendance`);
  await appointments.runReleases();
  expect(await H.walletBalance(landlord.user._id)).toBe(270000);
  await appointments.runReleases(); // idempotent
  expect(await H.walletBalance(landlord.user._id)).toBe(270000);
  expect((await Property.findById(p._id)).stats.viewingRequests).toBe(1);
});
