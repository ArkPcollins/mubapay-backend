'use strict';
const H = require('../helpers/harness');
const ledger = require('../../src/modules/ledger/ledger.service');
const { LedgerTransaction } = require('../../src/modules/ledger/ledger.models');
const { Withdrawal, Transfer } = require('../../src/modules/wallet/wallet.models');
const wallet = require('../../src/modules/wallet/wallet.service');
const settings = require('../../src/modules/settings/settings.service');

let fake;
let finance;
let finance2;
let controller;
let superA;
beforeAll(async () => {
  await H.start();
  fake = H.fakePaystack();
  finance = await H.staffUser('finance_officer');
  finance2 = await H.staffUser('finance_officer');
  controller = await H.staffUser('finance_controller');
  superA = await H.superadmin();
  // test amounts are small; the ₦1,000 production minimum is lowered through the audited settings API
  await settings.update('limits', { minWithdrawalKobo: 1000 }, { actor: superA.user, reason: 'test configuration' });
});
afterAll(async () => {
  fake.uninstall();
  await H.stop();
});

async function addBank(actor) {
  fake.accountName = `${actor.user.firstName} ${actor.user.lastName}`.toUpperCase(); // resolved name must match verified name
  const r = await H.as(actor).post('/api/v1/wallet/bank-accounts').send({ bankCode: '999', bankName: 'Test Bank', accountNumber: '0123456789' });
  expect(r.status).toBe(201);
  return r.body.data.id;
}

describe('transfers', () => {
  test('concurrent transfers can never spend more than the available balance', async () => {
    const sender = await H.createUser({ firstName: 'Ada', lastName: 'Okafor' });
    const recipient = await H.createUser();
    await H.fundWallet(sender, fake, 100000); // ₦1,000
    const attempts = Array.from({ length: 10 }, () => H.as(sender).post('/api/v1/wallet/transfers').set('Idempotency-Key', H.idem()).send({ recipient: recipient.email, amountKobo: 30000 }));
    const res = await Promise.all(attempts);
    const okCount = res.filter((r) => r.status === 201).length;
    const insufficient = res.filter((r) => r.body?.error?.code === 'INSUFFICIENT_FUNDS').length;
    expect(okCount).toBe(3);
    expect(insufficient).toBe(7);
    expect(await H.walletBalance(sender.user._id)).toBe(10000);
    expect(await H.walletBalance(recipient.user._id)).toBe(90000);
    expect((await ledger.checkInvariants()).ok).toBe(true);
  });

  test('same idempotency key → one transfer even when sent concurrently', async () => {
    const s = await H.createUser();
    const r = await H.createUser();
    await H.fundWallet(s, fake, 50000);
    const key = H.idem();
    const res = await Promise.all([1, 2, 3, 4].map(() => H.as(s).post('/api/v1/wallet/transfers').set('Idempotency-Key', key).send({ recipient: r.email, amountKobo: 10000 })));
    expect(res.every((x) => [201, 409].includes(x.status))).toBe(true);
    expect(await Transfer.countDocuments({ senderId: s.user._id })).toBe(1);
    expect(await H.walletBalance(r.user._id)).toBe(10000);
  });

  test('self-transfer, unknown recipient and tier-0 sender are rejected', async () => {
    const s = await H.createUser();
    await H.fundWallet(s, fake, 20000);
    expect((await H.as(s).post('/api/v1/wallet/transfers').set('Idempotency-Key', H.idem()).send({ recipient: s.email, amountKobo: 100 })).status).toBe(400);
    expect((await H.as(s).post('/api/v1/wallet/transfers').set('Idempotency-Key', H.idem()).send({ recipient: 'nobody@nowhere.test', amountKobo: 100 })).status).toBe(404);
    const t0 = await H.createUser({ tier: 0 });
    expect((await H.as(t0).post('/api/v1/wallet/transfers').set('Idempotency-Key', H.idem()).send({ recipient: s.email, amountKobo: 100 })).status).toBe(403);
  });

  test('large transfers are held for review; held funds are not spendable; review is audited', async () => {
    const s = await H.createUser();
    const r = await H.createUser();
    await settings.update('risk', { holdTransferAboveKobo: 300000 }, { actor: superA.user, reason: 'test threshold' });
    await H.fundWallet(s, fake, 400000);
    await H.fundWallet(s, fake, 100000);
    const res = await H.as(s).post('/api/v1/wallet/transfers').set('Idempotency-Key', H.idem()).send({ recipient: r.email, amountKobo: 350000 });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('held');
    expect(await H.walletBalance(s.user._id)).toBe(150000);
    expect(await ledger.getBalance(ledger.userCodes(s.user._id).hold)).toBe(350000);
    expect(await H.walletBalance(r.user._id)).toBe(0);
    // a finance officer without risk.review on a *different* preset can't review
    const support = await H.staffUser('support_agent');
    expect((await H.as(support).post(`/api/v1/admin/finance/transfers/${res.body.data.reference}/review`).send({ decision: 'approve', note: 'looks fine to me' })).status).toBe(403);
    const ok = await H.as(finance).post(`/api/v1/admin/finance/transfers/${res.body.data.reference}/review`).send({ decision: 'approve', note: 'Verified with customer by phone' });
    expect(ok.status).toBe(200);
    expect(await H.walletBalance(r.user._id)).toBe(350000);
    expect(await ledger.getBalance(ledger.userCodes(s.user._id).hold)).toBe(0);
    const again = await H.as(finance).post(`/api/v1/admin/finance/transfers/${res.body.data.reference}/review`).send({ decision: 'reject', note: 'double decision attempt' });
    expect(again.status).toBe(409);
    await settings.update('risk', { holdTransferAboveKobo: 30000000 }, { actor: superA.user, reason: 'reset threshold' });
  });
});

describe('withdrawals', () => {
  test('bank account whose resolved name does not match the verified name cannot be used', async () => {
    const u = await H.createUser();
    await H.fundWallet(u, fake, 20000);
    fake.accountName = 'SOMEONE ELSE ENTIRELY';
    const b = await H.as(u).post('/api/v1/wallet/bank-accounts').send({ bankCode: '999', accountNumber: '0123456780' });
    expect(b.body.data.nameMatchStatus).toBe('mismatch');
    const r = await H.as(u).post('/api/v1/wallet/withdrawals').set('Idempotency-Key', H.idem()).send({ amountKobo: 10000, bankAccountId: b.body.data.id });
    expect(r.body.error.code).toBe('BANK_NAME_MISMATCH');
  });

  test('tier 1 cannot withdraw; tier 2 request reserves funds', async () => {
    const t1 = await H.createUser({ tier: 1 });
    await H.fundWallet(t1, fake, 20000);
    const bank1 = await addBank(t1);
    const r1 = await H.as(t1).post('/api/v1/wallet/withdrawals').set('Idempotency-Key', H.idem()).send({ amountKobo: 10000, bankAccountId: bank1 });
    expect(r1.status).toBe(403);
    const u = await H.createUser();
    await H.fundWallet(u, fake, 200000);
    const bank = await addBank(u);
    const r = await H.as(u).post('/api/v1/wallet/withdrawals').set('Idempotency-Key', H.idem()).send({ amountKobo: 150000, bankAccountId: bank });
    expect(r.status).toBe(201);
    expect(r.body.data.status).toBe('pending_review');
    expect(await H.walletBalance(u.user._id)).toBe(50000);
    expect(await ledger.getBalance(ledger.userCodes(u.user._id).hold)).toBe(150000);
  });

  test('concurrent withdrawal requests cannot reserve more than the balance', async () => {
    const u = await H.createUser();
    await H.fundWallet(u, fake, 100000);
    const bank = await addBank(u);
    const res = await Promise.all(Array.from({ length: 6 }, () => H.as(u).post('/api/v1/wallet/withdrawals').set('Idempotency-Key', H.idem()).send({ amountKobo: 40000, bankAccountId: bank })));
    expect(res.filter((x) => x.status === 201).length).toBe(2);
    expect(await H.walletBalance(u.user._id)).toBe(20000);
    expect(await Withdrawal.countDocuments({ userId: u.user._id })).toBe(2);
  });

  test('approval → automated payout → timeout = uncertain (not failed) → verified success', async () => {
    const u = await H.createUser();
    await H.fundWallet(u, fake, 120000);
    const bank = await addBank(u);
    const w = (await H.as(u).post('/api/v1/wallet/withdrawals').set('Idempotency-Key', H.idem()).send({ amountKobo: 100000, bankAccountId: bank })).body.data;
    // customers cannot approve
    expect((await H.as(u).post(`/api/v1/admin/withdrawals/${w.reference}/approve`).send({})).status).toBe(403);
    const ap = await H.as(finance).post(`/api/v1/admin/withdrawals/${w.reference}/approve`).send({ note: 'KYC and history checked' });
    expect(ap.body.data.status).toBe('approved');
    fake.failNext['/transfer'] = 'timeout';
    const po = await H.as(finance).post(`/api/v1/admin/withdrawals/${w.reference}/payout`).send();
    expect(po.status).toBe(200);
    expect(po.body.data.status).toBe('payout_uncertain'); // never marked failed or successful on a timeout
    expect(await ledger.getBalance(ledger.userCodes(u.user._id).hold)).toBe(100000);
    // the provider eventually shows the transfer (it was created) and it succeeds
    fake.transfers.set(`${w.reference}-PO`, { reference: `${w.reference}-PO`, amount: 100000, status: 'success', transfer_code: 'TRF_x' });
    await wallet.checkPayout(w.reference);
    const done = await Withdrawal.findOne({ reference: w.reference });
    expect(done.status).toBe('completed');
    expect(await ledger.getBalance(ledger.userCodes(u.user._id).hold)).toBe(0);
    expect(await H.walletBalance(u.user._id)).toBe(20000);
    // re-checking / duplicate success webhooks don't double-settle
    await wallet.checkPayout(w.reference);
    await wallet.handleTransferEvent('transfer.success', { reference: `${w.reference}-PO` });
    expect(await LedgerTransaction.countDocuments({ reference: `${w.reference}-PAID` })).toBe(1);
  });

  test('accepted (pending) payout is not success; failure releases funds; reversal returns funds', async () => {
    const u = await H.createUser();
    await H.fundWallet(u, fake, 100000);
    const bank = await addBank(u);
    const mk = async () => (await H.as(u).post('/api/v1/wallet/withdrawals').set('Idempotency-Key', H.idem()).send({ amountKobo: 30000, bankAccountId: bank })).body.data;
    const w1 = await mk();
    await H.as(finance).post(`/api/v1/admin/withdrawals/${w1.reference}/approve`).send({});
    fake.transferInitialStatus = 'pending';
    const p1 = await H.as(finance).post(`/api/v1/admin/withdrawals/${w1.reference}/payout`).send();
    expect(p1.body.data.status).toBe('payout_processing');
    fake.transfers.get(`${w1.reference}-PO`).status = 'failed';
    await wallet.handleTransferEvent('transfer.failed', { reference: `${w1.reference}-PO` });
    expect((await Withdrawal.findOne({ reference: w1.reference })).status).toBe('failed');
    expect(await H.walletBalance(u.user._id)).toBe(100000 - 0); // fully released
    const w2 = await mk();
    await H.as(finance).post(`/api/v1/admin/withdrawals/${w2.reference}/approve`).send({});
    await H.as(finance).post(`/api/v1/admin/withdrawals/${w2.reference}/payout`).send();
    fake.transfers.get(`${w2.reference}-PO`).status = 'success';
    await wallet.handleTransferEvent('transfer.success', { reference: `${w2.reference}-PO` });
    expect((await Withdrawal.findOne({ reference: w2.reference })).status).toBe('completed');
    fake.transfers.get(`${w2.reference}-PO`).status = 'reversed';
    await wallet.handleTransferEvent('transfer.reversed', { reference: `${w2.reference}-PO` });
    expect((await Withdrawal.findOne({ reference: w2.reference })).status).toBe('reversed');
    expect(await H.walletBalance(u.user._id)).toBe(100000);
    fake.transferInitialStatus = undefined;
  });

  test('rejection releases funds; staff cannot approve their own withdrawal', async () => {
    const u = await H.createUser();
    await H.fundWallet(u, fake, 50000);
    const bank = await addBank(u);
    const w = (await H.as(u).post('/api/v1/wallet/withdrawals').set('Idempotency-Key', H.idem()).send({ amountKobo: 20000, bankAccountId: bank })).body.data;
    const rj = await H.as(finance).post(`/api/v1/admin/withdrawals/${w.reference}/reject`).send({ reason: 'Bank name does not match' });
    expect(rj.body.data.status).toBe('rejected');
    expect(await H.walletBalance(u.user._id)).toBe(50000);
    // finance officer's own withdrawal
    await H.fundWallet(finance, fake, 30000);
    const fb = await addBank(finance);
    const own = (await H.as(finance).post('/api/v1/wallet/withdrawals').set('Idempotency-Key', H.idem()).send({ amountKobo: 10000, bankAccountId: fb })).body.data;
    const self = await H.as(finance).post(`/api/v1/admin/withdrawals/${own.reference}/approve`).send({});
    expect(self.status).toBe(403);
  });

  test('large withdrawals need two DIFFERENT approvers', async () => {
    const u = await H.createUser();
    await settings.update('risk', { dualApprovalWithdrawalAboveKobo: 100000 }, { actor: superA.user, reason: 'test threshold' });
    await H.fundWallet(u, fake, 300000);
    const bank = await addBank(u);
    const w = (await H.as(u).post('/api/v1/wallet/withdrawals').set('Idempotency-Key', H.idem()).send({ amountKobo: 250000, bankAccountId: bank })).body.data;
    const a1 = await H.as(finance).post(`/api/v1/admin/withdrawals/${w.reference}/approve`).send({ note: 'first' });
    expect(a1.body.data.status).toBe('pending_review');
    const dup = await H.as(finance).post(`/api/v1/admin/withdrawals/${w.reference}/approve`).send({ note: 'again' });
    expect(dup.status).toBe(409);
    const a2 = await H.as(finance2).post(`/api/v1/admin/withdrawals/${w.reference}/approve`).send({ note: 'second' });
    expect(a2.body.data.status).toBe('approved');
    expect(a2.body.data.approvals).toHaveLength(2);
    await settings.update('risk', { dualApprovalWithdrawalAboveKobo: 100000000 }, { actor: superA.user, reason: 'reset threshold' });
  });

  test('manual payout requires evidence and a different confirmer', async () => {
    const u = await H.createUser();
    await H.fundWallet(u, fake, 80000);
    const bank = await addBank(u);
    const w = (await H.as(u).post('/api/v1/wallet/withdrawals').set('Idempotency-Key', H.idem()).send({ amountKobo: 50000, bankAccountId: bank })).body.data;
    await H.as(finance).post(`/api/v1/admin/withdrawals/${w.reference}/approve`).send({});
    await H.as(finance).post(`/api/v1/admin/withdrawals/${w.reference}/manual`).send({ note: 'sent via bank portal' });
    const sameStaff = await H.as(finance).post(`/api/v1/admin/withdrawals/${w.reference}/manual/confirm`).send({ bankReference: 'FT26293XYZ' });
    expect(sameStaff.status).toBe(403);
    const noEvidence = await H.as(finance2).post(`/api/v1/admin/withdrawals/${w.reference}/manual/confirm`).send({});
    expect(noEvidence.status).toBe(422);
    const ok = await H.as(finance2).post(`/api/v1/admin/withdrawals/${w.reference}/manual/confirm`).send({ bankReference: 'FT26293XYZ' });
    expect(ok.body.data.status).toBe('completed');
    expect(await ledger.getBalance(ledger.userCodes(u.user._id).hold)).toBe(0);
    expect((await ledger.checkInvariants()).ok).toBe(true);
  });
});

describe('financial corrections (dual approval)', () => {
  test('initiator cannot approve; approved correction posts a compensating entry exactly once', async () => {
    const u = await H.createUser();
    const ref = await H.fundWallet(u, fake, 10000);
    const init = await H.as(finance).post('/api/v1/admin/approvals').send({ action: 'ledger.wallet_adjustment', payload: { userId: String(u.user._id), direction: 'credit', amountKobo: 2500, relatedReference: `PAY-${ref}` }, reason: 'Customer was undercharged a promised cashback per ticket TCK-1' });
    expect(init.status).toBe(201);
    const id = init.body.data._id;
    expect((await H.as(finance).post(`/api/v1/admin/approvals/${id}/approve`).send({})).status).toBe(403);
    const support = await H.staffUser('support_agent');
    expect((await H.as(support).post(`/api/v1/admin/approvals/${id}/approve`).send({})).status).toBe(403);
    const ok = await H.as(controller).post(`/api/v1/admin/approvals/${id}/approve`).send({ note: 'Verified against ticket' });
    expect(ok.status).toBe(200);
    expect(ok.body.data.status).toBe('executed');
    expect(await H.walletBalance(u.user._id)).toBe(12500);
    const again = await H.as(controller).post(`/api/v1/admin/approvals/${id}/approve`).send({});
    expect(again.status).toBe(409);
    expect(await H.walletBalance(u.user._id)).toBe(12500);
    // there is no endpoint to edit balances directly
    const direct = await H.as(superA).patch(`/api/v1/admin/finance/accounts/${ledger.userCodes(u.user._id).wallet}`).send({ balance: 999999 });
    expect(direct.status).toBe(404);
  });

  test('a customer cannot initiate corrections', async () => {
    const u = await H.createUser();
    const r = await H.as(u).post('/api/v1/admin/approvals').send({ action: 'ledger.wallet_adjustment', payload: {}, reason: 'I would like more money please' });
    expect(r.status).toBe(403);
  });
});
