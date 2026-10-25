'use strict';
/** Workflow 3: personal savings end to end (plans → enrol → contributions → missed → early exit → maturity). */
const H = require('../helpers/harness');
const ledger = require('../../src/modules/ledger/ledger.service');
const { SavingsAccount, SavingsContribution, SavingsPayout } = require('../../src/modules/savings/savings.models');
const savings = require('../../src/modules/savings/savings.service');
const payments = require('../../src/modules/payments/payments.service');

let fake;
let staff;
let flexiblePlan;
let scheduledPlan;
beforeAll(async () => {
  await H.start();
  fake = H.fakePaystack();
  staff = await H.staffUser(['savings.view', 'savings.manage_plans']);
});
afterAll(async () => {
  fake.uninstall();
  await H.stop();
});

test('staff create plans within permitted penalty caps; later-phase products are refused', async () => {
  const tooHigh = await H.as(staff).post('/api/v1/admin/savings/plans').send({ name: 'Greedy', contributionMode: 'flexible', minDurationDays: 30, maxDurationDays: 365, earlyExit: { type: 'percent', bp: 5000 } });
  expect(tooHigh.status).toBe(422);
  const f = await H.as(staff).post('/api/v1/admin/savings/plans').send({ name: 'Flexible', contributionMode: 'flexible', minDurationDays: 30, maxDurationDays: 365, minContributionKobo: 1000, earlyExit: { type: 'percent', bp: 250 } });
  expect(f.status).toBe(201);
  flexiblePlan = f.body.data;
  const s = await H.as(staff).post('/api/v1/admin/savings/plans').send({ name: 'Scheduled', contributionMode: 'scheduled', minDurationDays: 30, maxDurationDays: 730, allowedFrequencies: ['weekly', 'monthly'], minContributionKobo: 1000, earlyExit: { type: 'fixed', fixedKobo: 5000 } });
  scheduledPlan = s.body.data;
  const customer = await H.createUser();
  expect((await H.as(customer).post('/api/v1/admin/savings/plans').send({ name: 'x', contributionMode: 'flexible', minDurationDays: 30, maxDurationDays: 60 })).status).toBe(403);
  const plans = await H.api().get('/api/v1/savings/plans');
  expect(plans.body.data.find((p) => p.name === 'Flexible').disclosures.penalty).toMatch(/2.50%/);
  expect(plans.body.data[0].disclosures.interest).toMatch(/No interest/);
});

test('enrolment requires explicit confirmation of terms, and snapshots them', async () => {
  const u = await H.createUser();
  const noConfirm = await H.as(u).post('/api/v1/savings/accounts').send({ planId: flexiblePlan._id, durationDays: 60, confirmTerms: false });
  expect(noConfirm.status).toBe(422);
  const ok = await H.as(u).post('/api/v1/savings/accounts').send({ planId: flexiblePlan._id, durationDays: 60, name: 'Rent fund', confirmTerms: true });
  expect(ok.status).toBe(201);
  // plan terms change later → existing enrolment keeps its accepted penalty
  await H.as(staff).patch(`/api/v1/admin/savings/plans/${flexiblePlan._id}`).send({ earlyExit: { type: 'percent', bp: 900 } });
  const acc = await SavingsAccount.findById(ok.body.data.id);
  expect(acc.terms.earlyExit.bp).toBe(250);
  const tier0 = await H.createUser({ tier: 0 });
  expect((await H.as(tier0).post('/api/v1/savings/accounts').send({ planId: flexiblePlan._id, durationDays: 60, confirmTerms: true })).status).toBe(403);
});

test('wallet contributions, early-exit penalty disclosure and exact accounting', async () => {
  const u = await H.createUser();
  await H.fundWallet(u, fake, 100000);
  const acc = (await H.as(u).post('/api/v1/savings/accounts').send({ planId: flexiblePlan._id, durationDays: 90, confirmTerms: true })).body.data;
  const d = await H.as(u).post(`/api/v1/savings/accounts/${acc.id}/deposits`).set('Idempotency-Key', H.idem()).send({ amountKobo: 80000, source: 'wallet' });
  expect(d.status).toBe(201);
  const tooMuch = await H.as(u).post(`/api/v1/savings/accounts/${acc.id}/deposits`).set('Idempotency-Key', H.idem()).send({ amountKobo: 80000, source: 'wallet' });
  expect(tooMuch.body.error.code).toBe('INSUFFICIENT_FUNDS');
  expect(await H.walletBalance(u.user._id)).toBe(20000);
  const quote = await H.as(u).get(`/api/v1/savings/accounts/${acc.id}/early-exit`);
  // this enrolment happened after the plan moved to 9%, so the 9% terms were the ones accepted
  expect(quote.body.data).toMatchObject({ balanceKobo: 80000, penaltyKobo: 7200, payoutKobo: 72800 });
  const wrongConfirm = await H.as(u).post(`/api/v1/savings/accounts/${acc.id}/early-exit`).send({ confirmPenaltyKobo: 0 });
  expect(wrongConfirm.body.error.code).toBe('CONFIRMATION_MISMATCH');
  const exit = await H.as(u).post(`/api/v1/savings/accounts/${acc.id}/early-exit`).send({ confirmPenaltyKobo: 7200 });
  expect(exit.status).toBe(200);
  expect(exit.body.data.status).toBe('closed_early');
  expect(await H.walletBalance(u.user._id)).toBe(92800);
  expect(await ledger.getBalance(ledger.SYS.REVENUE_PENALTY)).toBeGreaterThanOrEqual(7200);
  const payout = await SavingsPayout.findOne({ accountId: acc.id });
  expect(payout).toMatchObject({ kind: 'early_exit', penaltyKobo: 7200, payoutKobo: 72800 });
  expect((await H.as(u).post(`/api/v1/savings/accounts/${acc.id}/early-exit`).send({ confirmPenaltyKobo: 0 })).status).toBe(409);
});

test('scheduled contributions: success, failure within grace, missed after grace, pause after limit', async () => {
  const u = await H.createUser();
  await H.fundWallet(u, fake, 10000);
  const acc = (await H.as(u).post('/api/v1/savings/accounts').send({ planId: scheduledPlan._id, durationDays: 120, frequency: 'weekly', amountKobo: 6000, fundingSource: 'wallet', confirmTerms: true })).body.data;
  await SavingsAccount.updateOne({ _id: acc.id }, { $set: { 'schedule.nextDueAt': new Date(Date.now() - 1000), 'terms.maxConsecutiveMissedBeforePause': 2 } });
  await savings.runDueContributions();
  let contributions = await SavingsContribution.find({ accountId: acc.id }).sort({ createdAt: 1 });
  expect(contributions).toHaveLength(1);
  expect(contributions[0].status).toBe('success');
  expect(await ledger.getBalance(ledger.savingsCode(acc.id))).toBe(6000);
  // running the job again for the same due date does not duplicate
  await SavingsAccount.updateOne({ _id: acc.id }, { $set: { 'schedule.nextDueAt': contributions[0].dueAt } });
  await savings.runDueContributions();
  expect(await SavingsContribution.countDocuments({ accountId: acc.id })).toBe(1);
  // next due: wallet only has ₦40 left → failure (in grace) — NOT recorded as a contribution
  await SavingsAccount.updateOne({ _id: acc.id }, { $set: { 'schedule.nextDueAt': new Date(Date.now() - 500) } });
  await savings.runDueContributions();
  contributions = await SavingsContribution.find({ accountId: acc.id }).sort({ createdAt: 1 });
  expect(contributions[1].status).toBe('failed');
  expect(await ledger.getBalance(ledger.savingsCode(acc.id))).toBe(6000);
  // grace expires → missed, no fee
  await SavingsContribution.updateOne({ _id: contributions[1]._id }, { $set: { graceEndsAt: new Date(Date.now() - 1000) } });
  await savings.runDueContributions();
  expect((await SavingsContribution.findById(contributions[1]._id)).status).toBe('missed');
  // one more missed → paused per accepted terms
  await SavingsAccount.updateOne({ _id: acc.id }, { $set: { 'schedule.nextDueAt': new Date(Date.now() - 500) } });
  await savings.runDueContributions();
  const third = (await SavingsContribution.find({ accountId: acc.id }).sort({ createdAt: 1 }))[2];
  await SavingsContribution.updateOne({ _id: third._id }, { $set: { graceEndsAt: new Date(Date.now() - 1000) } });
  await savings.runDueContributions();
  expect((await SavingsAccount.findById(acc.id)).status).toBe('paused');
  expect(await H.walletBalance(u.user._id)).toBe(4000); // nothing charged for missed contributions
  const resumed = await H.as(u).post(`/api/v1/savings/accounts/${acc.id}/resume`);
  expect(resumed.body.data.status).toBe('active');
});

test('card contribution via Paystack (labelled test payment) saves the card for scheduled charges', async () => {
  const u = await H.createUser();
  const acc = (await H.as(u).post('/api/v1/savings/accounts').send({ planId: flexiblePlan._id, durationDays: 60, confirmTerms: true })).body.data;
  const r = await H.as(u).post(`/api/v1/savings/accounts/${acc.id}/deposits`).set('Idempotency-Key', H.idem()).send({ amountKobo: 15000, source: 'card', saveCard: true });
  expect(r.status).toBe(201);
  expect(await ledger.getBalance(ledger.savingsCode(acc.id))).toBe(0); // not credited until verified
  fake.pay(r.body.data.paymentReference, { amount: 15000 });
  await payments.verifyAndFulfil(r.body.data.paymentReference);
  expect(await ledger.getBalance(ledger.savingsCode(acc.id))).toBe(15000);
  const cards = await H.as(u).get('/api/v1/wallet/cards');
  expect(cards.body.data).toHaveLength(1);
  // a failed card payment never becomes a contribution
  const r2 = await H.as(u).post(`/api/v1/savings/accounts/${acc.id}/deposits`).set('Idempotency-Key', H.idem()).send({ amountKobo: 5000, source: 'card' });
  fake.pay(r2.body.data.paymentReference, { status: 'failed', amount: 5000 });
  await payments.verifyAndFulfil(r2.body.data.paymentReference);
  expect((await SavingsContribution.findOne({ reference: r2.body.data.reference })).status).toBe('failed');
  expect(await ledger.getBalance(ledger.savingsCode(acc.id))).toBe(15000);
});

test('maturity validates records, credits the wallet, and records the payout decision', async () => {
  const u = await H.createUser();
  await H.fundWallet(u, fake, 50000);
  const acc = (await H.as(u).post('/api/v1/savings/accounts').send({ planId: flexiblePlan._id, durationDays: 60, confirmTerms: true })).body.data;
  await H.as(u).post(`/api/v1/savings/accounts/${acc.id}/deposits`).set('Idempotency-Key', H.idem()).send({ amountKobo: 50000, source: 'wallet' });
  await SavingsAccount.updateOne({ _id: acc.id }, { $set: { maturityDate: new Date(Date.now() - 1000) } });
  const r = await savings.runMaturities();
  expect(r.matured).toBeGreaterThanOrEqual(1);
  const after = await SavingsAccount.findById(acc.id);
  expect(after.status).toBe('matured');
  expect(await H.walletBalance(u.user._id)).toBe(50000);
  expect(await ledger.getBalance(ledger.savingsCode(acc.id))).toBe(0);
  const p = await SavingsPayout.findOne({ accountId: acc.id });
  expect(p).toMatchObject({ kind: 'maturity', penaltyKobo: 0, payoutKobo: 50000 });
  // idempotent
  await savings.runMaturities();
  expect(await H.walletBalance(u.user._id)).toBe(50000);
  expect((await ledger.checkInvariants()).ok).toBe(true);
});
