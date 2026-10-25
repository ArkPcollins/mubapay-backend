'use strict';
const H = require('../helpers/harness');
const ledger = require('../../src/modules/ledger/ledger.service');
const { LedgerTransaction, LedgerEntry } = require('../../src/modules/ledger/ledger.models');
const { PaymentAttempt, ProviderEvent } = require('../../src/modules/payments/payment.models');
const payments = require('../../src/modules/payments/payments.service');
const webhooks = require('../../src/modules/webhooks/webhooks.service');
const recon = require('../../src/modules/reconciliation/reconciliation.service');
const { withTransaction } = require('../../src/lib/db');

let fake;
beforeAll(async () => {
  await H.start();
  fake = H.fakePaystack();
});
afterAll(async () => {
  fake.uninstall();
  await H.stop();
});

async function initFunding(actor, amountKobo, key = H.idem()) {
  const r = await H.as(actor).post('/api/v1/wallet/fund').set('Idempotency-Key', key).send({ amountKobo });
  expect(r.status).toBe(201);
  return r.body.data.reference;
}

function sendWebhook(event, data) {
  const body = fake.webhookBody(event, data);
  return H.api().post('/api/v1/webhooks/paystack').set('content-type', 'application/json').set('x-paystack-signature', fake.signature(body)).send(body);
}

describe('double-entry ledger', () => {
  test('postings balance, are immutable, and cannot overdraw', async () => {
    const a = await H.createUser();
    const b = await H.createUser();
    const ca = ledger.userCodes(a.user._id);
    const cb = ledger.userCodes(b.user._id);
    // overdraw is impossible
    await expect(withTransaction((s) => ledger.post({ reference: 'T-OVERDRAW', type: 'transfer', entries: [{ account: ca.wallet, direction: 'debit', amount: 100 }, { account: cb.wallet, direction: 'credit', amount: 100 }] }, s))).rejects.toMatchObject({ code: 'INSUFFICIENT_FUNDS' });
    expect(await LedgerTransaction.exists({ reference: 'T-OVERDRAW' })).toBeNull(); // rolled back atomically
    await withTransaction((s) => ledger.post({ reference: 'T-ADJ-1', type: 'adjustment', entries: [{ account: ledger.SYS.CORRECTIONS, direction: 'debit', amount: 5000 }, { account: ca.wallet, direction: 'credit', amount: 5000 }] }, s));
    // duplicate reference is rejected (idempotency at ledger level)
    await expect(withTransaction((s) => ledger.post({ reference: 'T-ADJ-1', type: 'adjustment', entries: [{ account: ledger.SYS.CORRECTIONS, direction: 'debit', amount: 5000 }, { account: ca.wallet, direction: 'credit', amount: 5000 }] }, s))).rejects.toBeInstanceOf(ledger.DuplicatePostingError);
    expect(await H.walletBalance(a.user._id)).toBe(5000);
    // immutability
    await expect(LedgerTransaction.updateOne({ reference: 'T-ADJ-1' }, { $set: { totalKobo: 1 } })).rejects.toThrow(/immutable/);
    await expect(LedgerEntry.deleteMany({})).rejects.toThrow(/immutable/);
    const inv = await ledger.checkInvariants();
    expect(inv.ok).toBe(true);
  });
});

describe('wallet funding via Paystack', () => {
  test('returning from checkout does NOT credit; only verified payment does', async () => {
    const u = await H.createUser();
    const ref = await initFunding(u, 250000);
    // customer "returns" — status poll while Paystack still ongoing
    const poll = await H.as(u).get(`/api/v1/wallet/payments/${ref}`);
    expect(poll.body.data.fulfilled).toBe(false);
    expect(await H.walletBalance(u.user._id)).toBe(0);
    fake.pay(ref, { amount: 250000, fees: 3750 });
    await new Promise((r) => setTimeout(r, 3100)); // client polls are throttled to protect the provider
    const poll2 = await H.as(u).get(`/api/v1/wallet/payments/${ref}`);
    expect(poll2.body.data.status).toBe('success');
    expect(await H.walletBalance(u.user._id)).toBe(250000);
    // provider fee recorded as platform expense, not taken from customer
    const tx = await LedgerTransaction.findOne({ reference: `PAY-${ref}` }).lean();
    const entries = await LedgerEntry.find({ transactionId: tx._id }).lean();
    expect(entries.find((e) => e.accountCode === ledger.SYS.PROVIDER_FEES).amount).toBe(3750);
  });

  test('duplicate and concurrent webhooks credit exactly once', async () => {
    const u = await H.createUser();
    const ref = await initFunding(u, 100000);
    fake.pay(ref, { amount: 100000 });
    const t = fake.transactions.get(ref);
    const results = await Promise.all([1, 2, 3].map(() => sendWebhook('charge.success', { id: t.id, reference: ref, status: 'success', amount: 100000, currency: 'NGN' })));
    results.forEach((r) => expect(r.status).toBe(200));
    expect(results.filter((r) => r.body.duplicate).length).toBe(2);
    // process the single stored event (and any retry) + race direct verification
    const evs = await ProviderEvent.find({ reference: ref });
    expect(evs).toHaveLength(1);
    expect(evs[0].receivedCount).toBe(3);
    await Promise.all([webhooks.processEvent(evs[0]._id), payments.verifyAndFulfil(ref), payments.verifyAndFulfil(ref)]);
    await webhooks.processEvent(evs[0]._id);
    expect(await H.walletBalance(u.user._id)).toBe(100000);
    expect(await LedgerTransaction.countDocuments({ reference: `PAY-${ref}` })).toBe(1);
  });

  test('invalid webhook signature is rejected and stored nothing', async () => {
    const body = fake.webhookBody('charge.success', { reference: 'FORGED', status: 'success', amount: 999999 });
    const r = await H.api().post('/api/v1/webhooks/paystack').set('content-type', 'application/json').set('x-paystack-signature', 'deadbeef').send(body);
    expect(r.status).toBe(401);
    expect(await ProviderEvent.exists({ reference: 'FORGED' })).toBeNull();
  });

  test('forged webhook with valid shape but no provider success does not credit (always re-verified)', async () => {
    const u = await H.createUser();
    const ref = await initFunding(u, 50000);
    // signature valid but Paystack itself says still ongoing → the webhook payload is not trusted
    const r = await sendWebhook('charge.success', { id: 1, reference: ref, status: 'success', amount: 50000 });
    expect(r.status).toBe(200);
    const ev = await ProviderEvent.findOne({ reference: ref });
    await webhooks.processEvent(ev._id);
    expect(await H.walletBalance(u.user._id)).toBe(0);
  });

  test('out-of-order: a late failure event cannot reverse a confirmed success', async () => {
    const u = await H.createUser();
    const ref = await initFunding(u, 70000);
    fake.pay(ref, { amount: 70000 });
    await payments.verifyAndFulfil(ref);
    fake.transactions.get(ref).status = 'failed'; // provider data later disagrees (should never happen; we must not regress)
    await payments.verifyAndFulfil(ref);
    const a = await PaymentAttempt.findOne({ reference: ref });
    expect(a.status).toBe('success');
    expect(await H.walletBalance(u.user._id)).toBe(70000);
  });

  test('network timeout is never treated as failure; later verification credits', async () => {
    const u = await H.createUser();
    const ref = await initFunding(u, 40000);
    fake.pay(ref, { amount: 40000 });
    fake.failNext['/transaction/verify/'] = 'timeout';
    const a1 = await payments.verifyAndFulfil(ref);
    expect(a1.status).not.toBe('failed');
    expect(a1.fulfilledAt).toBeFalsy();
    fake.failNext['/transaction/verify/'] = 500;
    const a2 = await payments.verifyAndFulfil(ref);
    expect(a2.status).not.toBe('failed');
    const a3 = await payments.verifyAndFulfil(ref);
    expect(a3.status).toBe('success');
    expect(await H.walletBalance(u.user._id)).toBe(40000);
  });

  test('invalid (non-JSON) provider response does not credit or fail the payment', async () => {
    const u = await H.createUser();
    const ref = await initFunding(u, 30000);
    fake.pay(ref, { amount: 30000 });
    fake.failNext['/transaction/verify/'] = 'garbage';
    const a = await payments.verifyAndFulfil(ref);
    expect(a.fulfilledAt).toBeFalsy();
    expect(a.status).toBe('pending');
  });

  test('amount mismatch is quarantined and raises a reconciliation exception', async () => {
    const u = await H.createUser();
    const ref = await initFunding(u, 60000);
    fake.pay(ref, { amount: 6000 }); // paid less than expected
    const a = await payments.verifyAndFulfil(ref);
    expect(a.status).toBe('amount_mismatch');
    expect(await H.walletBalance(u.user._id)).toBe(0);
    expect(await recon.ReconciliationException.exists({ reference: ref, type: 'amount_mismatch' })).toBeTruthy();
  });

  test('idempotency key replays the same result; reuse with different body is rejected', async () => {
    const u = await H.createUser();
    const key = H.idem();
    const r1 = await H.as(u).post('/api/v1/wallet/fund').set('Idempotency-Key', key).send({ amountKobo: 11100 });
    const r2 = await H.as(u).post('/api/v1/wallet/fund').set('Idempotency-Key', key).send({ amountKobo: 11100 });
    expect(r2.status).toBe(201);
    expect(r2.headers['idempotent-replayed']).toBe('true');
    expect(r2.body.data.reference).toBe(r1.body.data.reference);
    const r3 = await H.as(u).post('/api/v1/wallet/fund').set('Idempotency-Key', key).send({ amountKobo: 22200 });
    expect(r3.status).toBe(422);
    expect(await PaymentAttempt.countDocuments({ userId: u.user._id })).toBe(1);
    const missing = await H.as(u).post('/api/v1/wallet/fund').send({ amountKobo: 100 });
    expect(missing.status).toBe(400);
  });

  test('verification tier and limits are enforced server-side', async () => {
    const t0 = await H.createUser({ tier: 0 });
    const r0 = await H.as(t0).post('/api/v1/wallet/fund').set('Idempotency-Key', H.idem()).send({ amountKobo: 10000 });
    expect(r0.status).toBe(403);
    expect(r0.body.error.code).toBe('VERIFICATION_REQUIRED');
    const t1 = await H.createUser({ tier: 1 });
    const big = await H.as(t1).post('/api/v1/wallet/fund').set('Idempotency-Key', H.idem()).send({ amountKobo: 5000001 });
    expect(big.status).toBe(409);
    expect(big.body.error.code).toBe('LIMIT_EXCEEDED');
  });

  test('reconciliation recovers a missed webhook and flags provider-unknown references', async () => {
    const u = await H.createUser();
    const ref = await initFunding(u, 45000);
    fake.pay(ref, { amount: 45000 });
    fake.transactions.set('UNKNOWN-REF-1', { id: 1, reference: 'UNKNOWN-REF-1', amount: 100, currency: 'NGN', status: 'success' });
    const run = await recon.reconcilePaystack({});
    expect(run.status).toBe('completed');
    expect(run.stats.recoveredFulfilments).toBeGreaterThanOrEqual(1);
    expect(await H.walletBalance(u.user._id)).toBe(45000);
    expect(await recon.ReconciliationException.exists({ reference: 'UNKNOWN-REF-1', type: 'unmatched_provider_reference' })).toBeTruthy();
    const inv = await recon.checkLedger({});
    expect(inv.stats.ok).toBe(true);
  });

  test('Paystack not configured → clear 503, no fake success', async () => {
    const config = require('../../src/config');
    const prev = process.env.PAYSTACK_SECRET_KEY;
    delete process.env.PAYSTACK_SECRET_KEY;
    config.__reload();
    const u = await H.createUser();
    const r = await H.as(u).post('/api/v1/wallet/fund').set('Idempotency-Key', H.idem()).send({ amountKobo: 10000 });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('INTEGRATION_NOT_CONFIGURED');
    process.env.PAYSTACK_SECRET_KEY = prev;
    config.__reload();
  });
});
