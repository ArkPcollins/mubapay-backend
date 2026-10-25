'use strict';
/**
 * Workflow 2 (wallet end-to-end) and Workflow 7 (administration & compliance controls).
 */
const H = require('../helpers/harness');
const ledger = require('../../src/modules/ledger/ledger.service');
const { AuditEvent, Alert } = require('../../src/modules/audit/audit.model');
const { User } = require('../../src/modules/users/user.model');
const { Withdrawal } = require('../../src/modules/wallet/wallet.models');
const { ProviderEvent } = require('../../src/modules/payments/payment.models');
const webhooks = require('../../src/modules/webhooks/webhooks.service');
const recon = require('../../src/modules/reconciliation/reconciliation.service');

let fake;
let superA;
let superB;
let finance;
let controller;
let kyc;
beforeAll(async () => {
  await H.start();
  fake = H.fakePaystack();
  superA = await H.superadmin();
  superB = await H.superadmin();
  finance = await H.staffUser('finance_officer');
  controller = await H.staffUser('finance_controller');
  kyc = await H.staffUser('verification_officer');
});
afterAll(async () => {
  fake.uninstall();
  await H.stop();
});

const sendWebhook = (event, data) => {
  const body = fake.webhookBody(event, data);
  return H.api().post('/api/v1/webhooks/paystack').set('content-type', 'application/json').set('x-paystack-signature', fake.signature(body)).send(body);
};

test('Workflow 2: fund → verify → transfer → withdraw → approve → payout → webhook → reconcile', async () => {
  const a = await H.createUser({ firstName: 'Ama', lastName: 'Eke' });
  const b = await H.createUser();
  const fund = await H.as(a).post('/api/v1/wallet/fund').set('Idempotency-Key', H.idem()).send({ amountKobo: 500000 });
  fake.pay(fund.body.data.reference, { amount: 500000, fees: 7500 });
  await sendWebhook('charge.success', { id: fake.transactions.get(fund.body.data.reference).id, reference: fund.body.data.reference, status: 'success' });
  await webhooks.sweep(); // events older than a minute are swept; process directly as the queue would:
  for (const ev of await ProviderEvent.find({ status: 'received' })) await webhooks.processEvent(ev._id);
  const ov = await H.as(a).get('/api/v1/wallet');
  expect(ov.body.data.availableKobo).toBe(500000);
  await H.as(a).post('/api/v1/wallet/transfers').set('Idempotency-Key', H.idem()).send({ recipient: b.email, amountKobo: 100000, narration: 'Lunch' });
  fake.accountName = 'AMA EKE';
  const bank = await H.as(a).post('/api/v1/wallet/bank-accounts').send({ bankCode: '999', accountNumber: '0011223344' });
  const w = (await H.as(a).post('/api/v1/wallet/withdrawals').set('Idempotency-Key', H.idem()).send({ amountKobo: 200000, bankAccountId: bank.body.data.id })).body.data;
  expect((await H.as(a).get('/api/v1/wallet')).body.data).toMatchObject({ availableKobo: 200000, reservedForWithdrawalsKobo: 200000 });
  await H.as(finance).post(`/api/v1/admin/withdrawals/${w.reference}/approve`).send({ note: 'ok' });
  await H.as(finance).post(`/api/v1/admin/withdrawals/${w.reference}/payout`).send();
  fake.transfers.get(`${w.reference}-PO`).status = 'success';
  await sendWebhook('transfer.success', { reference: `${w.reference}-PO`, status: 'success', amount: 200000 });
  for (const ev of await ProviderEvent.find({ status: 'received' })) await webhooks.processEvent(ev._id);
  expect((await Withdrawal.findOne({ reference: w.reference })).status).toBe('completed');
  const tx = await H.as(a).get('/api/v1/wallet/transactions');
  expect(tx.body.data.map((t) => t.type)).toEqual(expect.arrayContaining(['wallet_funding', 'transfer', 'withdrawal_hold']));
  const stmt = await H.as(a).get('/api/v1/account/statements/wallet/csv');
  expect(stmt.status).toBe(200);
  expect(stmt.text).toMatch(/wallet_funding/);
  const pdf = await H.as(a).get('/api/v1/account/statements/wallet/pdf');
  expect(pdf.headers['content-type']).toBe('application/pdf');
  const run = await H.as(controller).post('/api/v1/admin/reconciliation/run').send({ type: 'paystack_payments' });
  expect(run.body.data.status).toBe('completed');
  const inv = await H.as(controller).post('/api/v1/admin/reconciliation/run').send({ type: 'ledger_invariants' });
  expect(inv.body.data.stats.ok).toBe(true);
});

test('staff permission changes require dual approval by a second superadmin', async () => {
  const target = await H.createUser();
  const init = await H.as(superA).post('/api/v1/admin/approvals').send({ action: 'staff.set_permissions', payload: { userId: String(target.user._id), makeAdmin: true, permissions: ['support.view', 'support.manage'] }, reason: 'New support hire starting Monday' });
  expect(init.status).toBe(201);
  expect((await User.findById(target.user._id)).roles).not.toContain('admin');
  expect((await H.as(superA).post(`/api/v1/admin/approvals/${init.body.data._id}/approve`).send({})).status).toBe(403);
  const ok = await H.as(superB).post(`/api/v1/admin/approvals/${init.body.data._id}/approve`).send({ note: 'confirmed with HR' });
  expect(ok.body.data.status).toBe('executed');
  const u = await User.findById(target.user._id);
  expect(u.roles).toContain('admin');
  expect(u.staffPermissions).toEqual(['support.view', 'support.manage']);
  const badPerm = await H.as(superA).post('/api/v1/admin/approvals').send({ action: 'staff.set_permissions', payload: { userId: String(target.user._id), permissions: ['flags.manage'] }, reason: 'try to grant superadmin-only permission' });
  expect(badPerm.status).toBe(422);
  const selfChange = await H.as(superA).post('/api/v1/admin/approvals').send({ action: 'staff.set_permissions', payload: { userId: String(superA.user._id), permissions: [] }, reason: 'self change attempt not allowed' });
  expect(selfChange.status).toBe(403);
});

test('identity verification review with private documents and audited access', async () => {
  const u = await H.createUser({ tier: 1 });
  const sub = await H.as(u).post('/api/v1/account/verification')
    .field('legalFirstName', 'Chioma').field('legalLastName', 'Nnaji').field('dateOfBirth', '1994-05-12').field('idType', 'national_id_card').field('idNumber', '12345678901')
    .attach('idDocument', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]), { filename: 'id.jpg', contentType: 'image/jpeg' })
    .attach('selfie', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1]), { filename: 's.png', contentType: 'image/png' });
  expect(sub.status).toBe(201);
  const disguised = await H.as(await H.createUser({ tier: 1 })).post('/api/v1/account/verification')
    .field('legalFirstName', 'X').field('legalLastName', 'Y').field('dateOfBirth', '1990-01-01').field('idType', 'national_id_card').field('idNumber', '999999999')
    .attach('idDocument', Buffer.from('<html>not an image</html>'), { filename: 'id.jpg', contentType: 'image/jpeg' })
    .attach('selfie', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), { filename: 's.jpg', contentType: 'image/jpeg' });
  expect(disguised.status).toBe(422);
  const q = await H.as(kyc).get('/api/v1/admin/verification/identity');
  const item = q.body.data.find((i) => i.id === sub.body.data.id);
  expect(item.documents).toHaveLength(2);
  expect(item).not.toHaveProperty('idNumber');
  const support = await H.staffUser('support_agent');
  expect((await H.as(support).get('/api/v1/admin/verification/identity')).status).toBe(403);
  expect((await H.as(support).post(`/api/v1/account/documents/${item.documents[0].id}/access`)).status).toBe(404);
  expect(await AuditEvent.exists({ action: 'document.access_denied', actorId: support.user._id })).toBeTruthy();
  const rv = await H.as(kyc).post(`/api/v1/admin/verification/identity/${item.id}/review`).send({ decision: 'approve', reviewerNotes: 'Matches selfie' });
  expect(rv.body.data.status).toBe('approved');
  const me = await User.findById(u.user._id);
  expect(me.verificationTier).toBe(2);
  expect(me.firstName).toBe('Chioma');
});

test('settings, fee caps, feature flags, later-phase modules and audit immutability', async () => {
  const over = await H.as(superA).patch('/api/v1/admin/settings/fees').send({ value: { marketplaceCommission: { type: 'percent', bp: 9000 } }, reason: 'testing cap enforcement' });
  expect(over.status).toBe(422);
  const adminTry = await H.as(finance).patch('/api/v1/admin/settings/fees').send({ value: {}, reason: 'not allowed' });
  expect(adminTry.status).toBe(403);
  const ok = await H.as(superA).patch('/api/v1/admin/settings/fees').send({ value: { marketplaceCommission: { type: 'percent', bp: 600 } }, reason: 'Board-approved commission change' });
  expect(ok.body.data.version).toBeGreaterThanOrEqual(1);
  const hist = await H.as(superA).get('/api/v1/admin/settings/fees/history');
  expect(hist.body.data[0].reason).toBe('Board-approved commission change');
  // compliance must go through dual approval
  expect((await H.as(superA).patch('/api/v1/admin/settings/compliance').send({ value: { walletOperationsAuthorized: true }, reason: 'try direct' })).status).toBe(403);
  // flags
  const u = await H.createUser();
  const off = await H.as(superA).put('/api/v1/admin/flags/transfers').send({ enabled: false, reason: 'Incident INC-42 mitigation' });
  expect(off.body.data.enabled).toBe(false);
  const blocked = await H.as(u).post('/api/v1/wallet/transfers').set('Idempotency-Key', H.idem()).send({ recipient: superB.email, amountKobo: 100 });
  expect(blocked.status).toBe(503);
  expect(blocked.body.error.code).toBe('FEATURE_DISABLED');
  await H.as(superA).put('/api/v1/admin/flags/transfers').send({ enabled: true, reason: 'Incident resolved' });
  expect((await H.as(superA).put('/api/v1/admin/flags/group_savings').send({ enabled: true, reason: 'try later phase' })).body.error.code).toBe('LATER_PHASE');
  expect((await H.as(finance).put('/api/v1/admin/flags/transfers').send({ enabled: false, reason: 'not permitted' })).status).toBe(403);
  // audit log is viewable but immutable
  const audit = await H.as(superA).get('/api/v1/admin/audit?action=feature_flag.set');
  expect(audit.body.data.length).toBeGreaterThanOrEqual(2);
  await expect(AuditEvent.updateOne({ action: 'feature_flag.set' }, { $set: { reason: 'tampered' } })).rejects.toThrow(/immutable/);
  await expect(AuditEvent.deleteMany({})).rejects.toThrow(/immutable/);
  expect((await H.as(superA).delete('/api/v1/admin/audit')).status).toBe(404);
});

test('alerts persist until acknowledged; acknowledging keeps history', async () => {
  const ops = await H.staffUser('operations_lead');
  const alerts = await H.as(ops).get('/api/v1/admin/alerts');
  const critical = alerts.body.data.find((a) => a.type === 'feature_flag.changed') || alerts.body.data[0];
  expect(critical).toBeTruthy();
  const ack = await H.as(ops).post(`/api/v1/admin/alerts/${critical._id}/acknowledge`).send({ note: 'Seen, expected change' });
  expect(ack.body.data.status).toBe('acknowledged');
  const stored = await Alert.findById(critical._id);
  expect(stored.history.map((h) => h.action)).toEqual(expect.arrayContaining(['raised', 'acknowledged']));
});

test('reports separate revenue from liabilities and volume; exports are permissioned and audited', async () => {
  const fin = await H.as(controller).get('/api/v1/admin/reports/financial');
  expect(fin.status).toBe(200);
  expect(fin.body.data).toHaveProperty('settledRevenue.totalKobo');
  expect(fin.body.data).toHaveProperty('liabilities.customerWalletsKobo');
  expect(fin.body.data.liabilities.customerWalletsKobo).toBeGreaterThan(0);
  expect(fin.body.data.transactionVolume.note).toMatch(/NOT platform revenue/);
  expect(fin.body.data.settledRevenue.totalKobo).toBeLessThan(fin.body.data.liabilities.customerWalletsKobo); // volume ≠ revenue
  const ops = await H.as(controller).get('/api/v1/admin/reports/operational');
  expect(ops.body.data).toHaveProperty('users.total');
  const dd = await H.as(controller).get(`/api/v1/admin/reports/drilldown?metric=account:${encodeURIComponent(ledger.SYS.PAYSTACK_BALANCE)}`);
  expect(dd.body.data.items.length).toBeGreaterThan(0);
  for (const fmt of ['csv', 'xlsx', 'pdf']) {
    const r = await H.as(controller).get(`/api/v1/admin/reports/export/financial/${fmt}`);
    expect(r.status).toBe(200);
  }
  expect(await AuditEvent.countDocuments({ action: 'report.exported', actorId: controller.user._id })).toBe(3);
  const support = await H.staffUser('support_agent');
  expect((await H.as(support).get('/api/v1/admin/reports/export/financial/csv')).status).toBe(403);
  const rs = require('../../src/modules/reports/reports.service');
  const sched = await rs.runScheduled('daily');
  expect(sched.id).toBeTruthy();
});

test('maintenance mode blocks customer writes but not webhooks, refresh or staff', async () => {
  await H.as(superA).post('/api/v1/admin/maintenance').send({ enabled: true, message: 'Upgrade', reason: 'Planned database upgrade' });
  const u = await H.createUser();
  const w = await H.as(u).post('/api/v1/wallet/fund').set('Idempotency-Key', H.idem()).send({ amountKobo: 10000 });
  expect(w.status).toBe(503);
  expect(w.body.error.code).toBe('MAINTENANCE');
  expect((await H.as(u).get('/api/v1/wallet')).status).toBe(200); // reads still work
  const wh = await sendWebhook('charge.success', { id: 1, reference: 'MAINT-REF', status: 'success' });
  expect(wh.status).toBe(200);
  const supportStaff = await H.staffUser('support_agent');
  expect((await H.as(supportStaff).post('/api/v1/admin/reconciliation/run').send({ type: 'ledger_invariants' })).status).toBe(403); // permission still enforced
  expect((await H.as(controller).post('/api/v1/admin/reconciliation/run').send({ type: 'ledger_invariants' })).status).toBe(200);
  await H.as(superA).post('/api/v1/admin/maintenance').send({ enabled: false, reason: 'Upgrade complete' });
  const settings = require('../../src/modules/settings/settings.service');
  settings.invalidate();
});

test('account closure is blocked while obligations remain, then anonymises but retains financial records', async () => {
  const u = await H.createUser();
  await H.fundWallet(u, fake, 10000);
  const check = await H.as(u).get('/api/v1/account/closure');
  expect(check.body.data.canClose).toBe(false);
  expect(check.body.data.blockers.map((b) => b.code)).toContain('wallet_balance');
  const exp = await H.as(u).get('/api/v1/account/export');
  expect(exp.status).toBe(200);
  expect(JSON.parse(exp.text).ledgerTransactions.length).toBeGreaterThan(0);
  const v = await H.createUser();
  const closed = await H.as(v).post('/api/v1/account/closure').send({ password: v.password, confirm: 'CLOSE MY ACCOUNT' });
  expect(closed.status).toBe(200);
  const after = await User.findById(v.user._id);
  expect(after.status).toBe('closed');
  expect(after.email).toMatch(/closed\.invalid$/);
  expect(await require('../../src/modules/ledger/ledger.models').LedgerAccount.countDocuments({ ownerId: v.user._id })).toBe(3); // retained
  expect((await H.as(v).get('/api/v1/auth/me')).status).toBe(401);
});
