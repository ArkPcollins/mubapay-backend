'use strict';
const crypto = require('crypto');
const { SavingsPlan, SavingsAccount, SavingsContribution, SavingsPayout } = require('./savings.models');
const { SavedCard, PaymentAttempt } = require('../payments/payment.models');
const { User } = require('../users/user.model');
const { LedgerAccount } = require('../ledger/ledger.models');
const ledger = require('../ledger/ledger.service');
const payments = require('../payments/payments.service');
const limits = require('../payments/limits.service');
const paystack = require('../../providers/paystack/paystack.adapter');
const settings = require('../settings/settings.service');
const notifications = require('../notifications/notifications.service');
const audit = require('../audit/audit.service');
const consent = require('../legal/consent.service');
const { withTransaction } = require('../../lib/db');
const { E } = require('../../lib/errors');
const { assertPositiveKobo, computeFee, koboToNairaString } = require('../../lib/money');
const { decryptString } = require('../../lib/crypto');
const logger = require('../../lib/logger');

const DAY = 864e5;
const ref = (p) => `${p}-${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

function addPeriod(date, frequency) {
  const d = new Date(date);
  if (frequency === 'daily') d.setUTCDate(d.getUTCDate() + 1);
  else if (frequency === 'weekly') d.setUTCDate(d.getUTCDate() + 7);
  else if (frequency === 'monthly') {
    const day = d.getUTCDate();
    d.setUTCDate(1);
    d.setUTCMonth(d.getUTCMonth() + 1);
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    d.setUTCDate(Math.min(day, last));
  }
  return d;
}

/** Penalty per the accepted (snapshotted) terms — never more than the balance. */
function earlyExitPenalty(balanceKobo, rule) {
  if (!rule || rule.type === 'none') return 0;
  const fee = computeFee(balanceKobo, rule.type === 'percent' ? { type: 'percent', bp: rule.bp } : { type: 'fixed', fixedKobo: rule.fixedKobo });
  return Math.min(fee, balanceKobo);
}

async function assertSavingsEnabled() {
  await settings.assertFeature('personal_savings', { complianceKey: 'savingsAuthorized' });
}

// ---------------------------------------------------------------- plans (admin)
async function validatePlan(data) {
  const caps = await settings.get('feeCaps');
  const s = await settings.get('savings');
  if (data.productType && data.productType !== 'personal') throw E.conflict('Group and purpose-based savings are later-phase products and cannot be created in this release', 'LATER_PHASE');
  if (data.minDurationDays < s.minDurationDays || data.maxDurationDays > s.maxDurationDays || data.minDurationDays > data.maxDurationDays) {
    throw E.validation([{ path: 'durationDays', message: `Duration must be within ${s.minDurationDays}-${s.maxDurationDays} days` }]);
  }
  const ee = data.earlyExit || { type: 'none' };
  if (ee.type === 'percent' && (ee.bp == null || ee.bp > caps.earlyExitMaxBp)) throw E.validation([{ path: 'earlyExit.bp', message: `Early-exit percentage cannot exceed ${caps.earlyExitMaxBp / 100}%` }]);
  if (ee.type === 'fixed' && (ee.fixedKobo == null || ee.fixedKobo > caps.earlyExitMaxFixedKobo)) throw E.validation([{ path: 'earlyExit.fixedKobo', message: `Fixed early-exit penalty cannot exceed ${koboToNairaString(caps.earlyExitMaxFixedKobo)}` }]);
  if ((data.allowedFrequencies || []).some((f) => !s.allowedFrequencies.includes(f))) throw E.validation([{ path: 'allowedFrequencies', message: 'Frequency not permitted by platform settings' }]);
  if (data.interestBp && data.interestBp !== 0) throw E.validation([{ path: 'interestBp', message: 'Interest is not offered at launch' }]);
}

async function createPlan(staff, data, req) {
  await validatePlan(data);
  const plan = await SavingsPlan.create({ ...data, productType: 'personal', interestBp: 0, createdBy: staff._id });
  await audit.fromReq(req, { action: 'savings_plan.created', category: 'config', targetType: 'savings_plan', targetId: plan._id, metadata: data });
  return plan;
}

/** Changes create a new terms version; existing enrolments keep their accepted snapshot. */
async function updatePlan(staff, id, data, req) {
  const plan = await SavingsPlan.findById(id);
  if (!plan) throw E.notFound('Savings plan');
  const merged = { ...plan.toObject(), ...data };
  await validatePlan(merged);
  const termsChanged = ['earlyExit', 'minDurationDays', 'maxDurationDays', 'contributionMode', 'allowedFrequencies', 'minContributionKobo'].some((k) => data[k] !== undefined);
  Object.assign(plan, data);
  if (termsChanged) plan.termsVersion += 1;
  await plan.save();
  await audit.fromReq(req, { action: 'savings_plan.updated', category: 'config', targetType: 'savings_plan', targetId: plan._id, metadata: { data, termsVersion: plan.termsVersion, note: 'Applies to new enrolments only' } });
  return plan;
}

async function listPlans({ includeRetired = false } = {}) {
  const plans = await SavingsPlan.find(includeRetired ? {} : { status: 'active', productType: 'personal' }).sort({ createdAt: 1 }).lean();
  const s = await settings.get('savings');
  return plans.map((p) => ({ ...p, id: String(p._id), disclosures: disclosure(p, s) }));
}

function disclosure(plan, s) {
  const ee = plan.earlyExit || { type: 'none' };
  const penalty = ee.type === 'none' ? 'No early-exit penalty.' : ee.type === 'percent' ? `Early exit before maturity costs ${(ee.bp / 100).toFixed(2)}% of your savings balance.` : `Early exit before maturity costs a fixed ${koboToNairaString(ee.fixedKobo)} (never more than your balance).`;
  return {
    interest: 'No interest is paid. Your savings are returned as saved, less any disclosed penalty.',
    penalty,
    missed: plan.contributionMode === 'scheduled' ? `If a scheduled contribution fails, we retry for ${s.graceDays} day(s). After that it is marked missed — no fee is charged. After ${s.maxConsecutiveMissedBeforePause} consecutive missed contributions the schedule is paused until you resume it.` : 'Contribute whenever you like.',
    maturity: 'At maturity your full balance is credited to your MubaPay wallet, or paid to your bank through a withdrawal request if you choose.',
  };
}

// ---------------------------------------------------------------- enrolment
async function enroll(user, body, req) {
  await assertSavingsEnabled();
  const v = await settings.get('verification');
  if (user.verificationTier < v.financialMinTier) throw E.verificationRequired('Savings requires a verified email and phone number');
  const plan = await SavingsPlan.findOne({ _id: body.planId, status: 'active', productType: 'personal' });
  if (!plan) throw E.notFound('Savings plan');
  const s = await settings.get('savings');
  if (!body.durationDays || body.durationDays < plan.minDurationDays || body.durationDays > plan.maxDurationDays) throw E.validation([{ path: 'durationDays', message: `Choose ${plan.minDurationDays}-${plan.maxDurationDays} days` }]);
  if (body.acceptedPolicies?.length) {
    await consent.assertRequiredAccepted(body.acceptedPolicies, 'savings');
    await consent.recordAcceptances(user._id, body.acceptedPolicies, { context: 'savings_enrolment', ip: req.ip, userAgent: req.get('user-agent') });
  }
  await consent.assertUserAccepted(user._id, 'savings');
  const disc = disclosure(plan, s);
  const statement = `I understand: ${disc.interest} ${disc.penalty} ${disc.missed}`;
  if (body.confirmTerms !== true) throw E.validation([{ path: 'confirmTerms', message: 'Please confirm the savings terms, including the early-exit penalty', disclosure: disc }]);
  let schedule;
  if (plan.contributionMode === 'scheduled') {
    if (!plan.allowedFrequencies.includes(body.frequency)) throw E.validation([{ path: 'frequency', message: 'Choose an allowed frequency' }]);
    assertPositiveKobo(body.amountKobo);
    if (body.amountKobo < plan.minContributionKobo) throw E.validation([{ path: 'amountKobo', message: `Minimum contribution is ${koboToNairaString(plan.minContributionKobo)}` }]);
    if (body.fundingSource === 'card') {
      const card = await SavedCard.findOne({ _id: body.savedCardId, userId: user._id, status: 'active' });
      if (!card) throw E.validation([{ path: 'savedCardId', message: 'Choose a saved card (save one by making a card contribution first)' }]);
    } else if (body.fundingSource !== 'wallet') throw E.validation([{ path: 'fundingSource', message: 'Choose wallet or card' }]);
    const first = body.startDate ? new Date(body.startDate) : new Date(Date.now() + DAY);
    schedule = { frequency: body.frequency, amountKobo: body.amountKobo, nextDueAt: first, fundingSource: body.fundingSource, savedCardId: body.savedCardId };
  }
  const start = new Date();
  const legal = await consent.latestPublished(['savings_terms']);
  const account = await withTransaction(async (session) => {
    const [acc] = await SavingsAccount.create([{
      userId: user._id, planId: plan._id, name: body.name || plan.name, targetKobo: body.targetKobo, startDate: start, maturityDate: new Date(start.getTime() + body.durationDays * DAY), schedule,
      payoutPreference: body.payoutPreference || 'wallet', payoutBankAccountId: body.payoutBankAccountId,
      terms: { planName: plan.name, contributionMode: plan.contributionMode, earlyExit: plan.earlyExit, termsVersion: plan.termsVersion, savingsTermsVersion: legal.get('savings_terms')?.version, graceDays: s.graceDays, maxConsecutiveMissedBeforePause: s.maxConsecutiveMissedBeforePause, missedPolicy: disc.missed, acceptedAt: new Date(), disclosure: statement },
    }], { session });
    acc.ledgerCode = ledger.savingsCode(acc._id);
    await acc.save({ session });
    await consent.recordFinancialCommitment(user._id, { statement, relatedType: 'savings_account', relatedId: acc._id, ip: req.ip, userAgent: req.get('user-agent') }, session);
    await audit.record({ ...audit.ctxFrom(req), actor: user, action: 'savings.enrolled', category: 'finance', targetType: 'savings_account', targetId: acc._id, metadata: { planId: String(plan._id), termsVersion: plan.termsVersion } }, { session });
    return acc;
  });
  await ledger.ensureSavingsAccount(account._id, user._id);
  await notifications.notify(user._id, { category: 'savings', type: 'savings_created', title: 'Savings plan created', body: `"${account.name}" matures on ${account.maturityDate.toDateString()}.`, link: `/app/savings/${account._id}` });
  return present(account);
}

async function present(acc) {
  const bal = await ledger.getBalance(ledger.savingsCode(acc._id));
  const penalty = acc.status === 'active' || acc.status === 'paused' ? earlyExitPenalty(bal, acc.terms?.earlyExit) : 0;
  const now = Date.now();
  return {
    id: String(acc._id), name: acc.name, planId: String(acc.planId), status: acc.status, balanceKobo: bal, targetKobo: acc.targetKobo,
    progress: acc.targetKobo ? Math.min(1, bal / acc.targetKobo) : null, startDate: acc.startDate, maturityDate: acc.maturityDate,
    daysToMaturity: Math.max(0, Math.ceil((new Date(acc.maturityDate).getTime() - now) / DAY)), schedule: acc.schedule, terms: acc.terms,
    consecutiveMissed: acc.consecutiveMissed, payoutPreference: acc.payoutPreference,
    withdrawal: { eligibleWithoutPenalty: new Date(acc.maturityDate).getTime() <= now, earlyExitPenaltyKobo: penalty, earlyExitPayoutKobo: bal - penalty },
  };
}

async function listAccounts(user) {
  const accs = await SavingsAccount.find({ userId: user._id }).sort({ createdAt: -1 });
  return Promise.all(accs.map(present));
}

async function getAccount(user, id) {
  const acc = await SavingsAccount.findOne({ _id: id, userId: user._id });
  if (!acc) throw E.notFound('Savings account');
  const contributions = await SavingsContribution.find({ accountId: acc._id }).sort({ createdAt: -1 }).limit(200).lean();
  return { ...(await present(acc)), contributions };
}

// ---------------------------------------------------------------- contributions
async function postContributionFromWallet(acc, contribution, session) {
  const user = await User.findById(acc.userId).session(session);
  await limits.consume(user, 'savings', contribution.amountKobo, session);
  await ledger.post({ reference: `${contribution.reference}-POST`, type: 'savings_deposit', description: `Savings contribution to "${acc.name}"`, entries: [{ account: ledger.userCodes(acc.userId).wallet, direction: 'debit', amount: contribution.amountKobo }, { account: ledger.savingsCode(acc._id), direction: 'credit', amount: contribution.amountKobo }], initiatedBy: acc.userId, relatedType: 'savings_contribution', relatedId: contribution.reference }, session);
  await SavingsContribution.updateOne({ _id: contribution._id }, { $set: { status: 'success', ledgerReference: `${contribution.reference}-POST` }, $push: { attempts: { at: new Date(), outcome: 'success' } } }, { session });
  await SavingsAccount.updateOne({ _id: acc._id }, { $inc: { totalContributedKobo: contribution.amountKobo }, $set: { consecutiveMissed: 0 } }, { session });
}

async function manualDeposit(user, accountId, { amountKobo, source = 'wallet', saveCard = false }, { idempotencyKey, req }) {
  await assertSavingsEnabled();
  assertPositiveKobo(amountKobo);
  const acc = await SavingsAccount.findOne({ _id: accountId, userId: user._id });
  if (!acc) throw E.notFound('Savings account');
  if (!['active', 'paused'].includes(acc.status)) throw E.invalidState('This savings plan is closed');
  if (new Date(acc.maturityDate) <= new Date()) throw E.invalidState('This plan has reached maturity');
  const plan = await SavingsPlan.findById(acc.planId);
  if (amountKobo < plan.minContributionKobo) throw E.validation([{ path: 'amountKobo', message: `Minimum contribution is ${koboToNairaString(plan.minContributionKobo)}` }]);
  const reference = `SVC-${crypto.createHash('sha256').update(`${user._id}:${idempotencyKey}`).digest('hex').slice(0, 18).toUpperCase()}`;
  const existing = await SavingsContribution.findOne({ reference }).lean();
  if (existing) return existing;
  if (source === 'wallet') {
    return withTransaction(async (session) => {
      const [c] = await SavingsContribution.create([{ reference, accountId: acc._id, userId: user._id, amountKobo, kind: 'manual', source: 'wallet' }], { session });
      await postContributionFromWallet(acc, c, session);
      await notifications.notify(user._id, { category: 'savings', type: 'savings_contribution', title: 'Savings contribution received', body: `${koboToNairaString(amountKobo)} added to "${acc.name}".`, link: `/app/savings/${acc._id}` }, { session });
      await audit.record({ ...audit.ctxFrom(req), actor: user, action: 'savings.contribution', category: 'finance', targetType: 'savings_account', targetId: acc._id, metadata: { amountKobo, source } }, { session });
      return SavingsContribution.findById(c._id).session(session).lean();
    });
  }
  await limits.precheck(user, 'savings', amountKobo);
  const c = await SavingsContribution.create({ reference, accountId: acc._id, userId: user._id, amountKobo, kind: 'manual', source: 'card_checkout' });
  const attempt = await payments.initPayment({ user, purpose: 'savings_contribution', amountKobo, relatedType: 'savings_contribution', relatedId: c._id, idempotencyKey, saveCard, callbackPath: `/app/savings/${acc._id}` });
  await SavingsContribution.updateOne({ _id: c._id }, { $set: { paymentReference: attempt.reference } });
  return { ...c.toObject(), paymentReference: attempt.reference, authorizationUrl: attempt.authorizationUrl };
}

payments.registerPurpose('savings_contribution', {
  async creditTarget(attempt, session) {
    const c = await SavingsContribution.findById(attempt.relatedId).session(session);
    if (!c) throw E.notFound('Contribution');
    const acc = await SavingsAccount.findById(c.accountId).session(session);
    if (!['active', 'paused'].includes(acc.status)) throw E.invalidState('Savings plan closed before payment confirmed');
    const user = await User.findById(acc.userId).session(session);
    await limits.consume(user, 'savings', c.amountKobo, session, { enforce: false });
    return { account: ledger.savingsCode(acc._id), ledgerType: 'savings_contribution_card', description: `Card contribution to "${acc.name}" (${attempt.reference})` };
  },
  async onSuccess(attempt, session) {
    const c = await SavingsContribution.findOneAndUpdate({ _id: attempt.relatedId, status: { $in: ['pending', 'failed'] } }, { $set: { status: 'success', ledgerReference: attempt.fulfillmentReference }, $push: { attempts: { at: new Date(), outcome: 'success' } } }, { new: true, session });
    if (!c) return;
    await SavingsAccount.updateOne({ _id: c.accountId }, { $inc: { totalContributedKobo: c.amountKobo }, $set: { consecutiveMissed: 0 } }, { session });
    await notifications.notify(c.userId, { category: 'savings', type: 'savings_contribution', title: 'Savings contribution received', body: `${koboToNairaString(c.amountKobo)} confirmed.`, link: `/app/savings/${c.accountId}`, dedupeKey: `svc_ok:${c.reference}` }, { session });
  },
  async onFailure(attempt) {
    // A failed payment is never recorded as a successful contribution.
    const c = await SavingsContribution.findById(attempt.relatedId);
    if (!c || c.status === 'success') return;
    if (c.kind === 'manual') await SavingsContribution.updateOne({ _id: c._id, status: 'pending' }, { $set: { status: 'failed', failureReason: `Payment ${attempt.status}` }, $push: { attempts: { at: new Date(), outcome: attempt.status } } });
    else await handleScheduledFailure(c, `Card charge ${attempt.status}`);
  },
});

async function handleScheduledFailure(c, reason) {
  const acc = await SavingsAccount.findById(c.accountId);
  const inGrace = c.graceEndsAt && c.graceEndsAt > new Date();
  if (inGrace) {
    await SavingsContribution.updateOne({ _id: c._id, status: { $in: ['pending', 'failed'] } }, { $set: { status: 'failed', failureReason: reason }, $push: { attempts: { at: new Date(), outcome: 'failed', note: reason } } });
    await notifications.notify(c.userId, { category: 'savings', type: 'savings_contribution_failed', title: 'Savings contribution failed', body: `We couldn't collect ${koboToNairaString(c.amountKobo)} for "${acc.name}" (${reason}). We'll retry until ${c.graceEndsAt.toDateString()}. No fee is charged.`, link: `/app/savings/${acc._id}`, dedupeKey: `svc_fail:${c.reference}:${new Date().toISOString().slice(0, 10)}` });
    return;
  }
  const r = await SavingsContribution.updateOne({ _id: c._id, status: { $in: ['pending', 'failed'] } }, { $set: { status: 'missed', failureReason: reason }, $push: { attempts: { at: new Date(), outcome: 'missed', note: reason } } });
  if (!r.modifiedCount) return;
  const updated = await SavingsAccount.findOneAndUpdate({ _id: acc._id }, { $inc: { consecutiveMissed: 1 } }, { new: true });
  const max = acc.terms?.maxConsecutiveMissedBeforePause ?? 3;
  if (updated.consecutiveMissed >= max && updated.status === 'active') {
    await SavingsAccount.updateOne({ _id: acc._id, status: 'active' }, { $set: { status: 'paused' } });
    await notifications.notify(c.userId, { category: 'savings', type: 'savings_paused', title: 'Savings schedule paused', body: `"${acc.name}" was paused after ${max} missed contributions, as described in your plan terms. Your balance is safe. Resume anytime.`, link: `/app/savings/${acc._id}` });
  } else {
    await notifications.notify(c.userId, { category: 'savings', type: 'savings_contribution_missed', title: 'Savings contribution missed', body: `The ${koboToNairaString(c.amountKobo)} contribution for "${acc.name}" was missed. No fee was charged.`, link: `/app/savings/${acc._id}` });
  }
}

async function attemptScheduled(c) {
  const acc = await SavingsAccount.findById(c.accountId);
  if (!acc || acc.status !== 'active') return;
  if (acc.schedule.fundingSource === 'wallet') {
    try {
      await withTransaction(async (session) => {
        const fresh = await SavingsContribution.findOne({ _id: c._id, status: { $in: ['pending', 'failed'] } }).session(session);
        if (!fresh) return;
        await postContributionFromWallet(acc, fresh, session);
        await notifications.notify(acc.userId, { category: 'savings', type: 'savings_contribution', title: 'Scheduled contribution saved', body: `${koboToNairaString(c.amountKobo)} moved from your wallet to "${acc.name}".`, link: `/app/savings/${acc._id}`, dedupeKey: `svc_ok:${c.reference}` }, { session });
      });
    } catch (err) {
      if (!err.expose) throw err;
      await handleScheduledFailure(c, err.code === 'INSUFFICIENT_FUNDS' ? 'insufficient wallet balance' : err.message);
    }
    return;
  }
  // card: charge saved authorisation; the outcome is confirmed by verification, never assumed
  const card = await SavedCard.findById(acc.schedule.savedCardId).select('+authorizationCodeEnc');
  if (!card || card.status !== 'active') return handleScheduledFailure(c, 'saved card unavailable');
  const user = await User.findById(acc.userId);
  const attemptRef = `${c.reference}-A${(c.attempts?.length || 0) + 1}`;
  let attempt = await PaymentAttempt.findOne({ relatedType: 'savings_contribution', relatedId: String(c._id), status: { $in: ['pending', 'uncertain', 'success'] } });
  if (!attempt) {
    attempt = await PaymentAttempt.create({ reference: attemptRef, purpose: 'savings_contribution', userId: user._id, amountKobo: c.amountKobo, relatedType: 'savings_contribution', relatedId: String(c._id), status: 'pending', history: [{ at: new Date(), status: 'pending', source: 'charge_authorization' }] });
    await SavingsContribution.updateOne({ _id: c._id }, { $set: { paymentReference: attemptRef }, $push: { attempts: { at: new Date(), outcome: 'charge_requested' } } });
    try {
      await paystack.chargeAuthorization({ authorizationCode: decryptString(card.authorizationCodeEnc), email: user.email, amountKobo: c.amountKobo, reference: attemptRef, metadata: { purpose: 'savings_contribution', contribution: c.reference } });
    } catch (err) {
      if (err.outcome === 'rejected') {
        await PaymentAttempt.updateOne({ _id: attempt._id }, { $set: { status: 'failed', lastVerifyError: err.message } });
        return handleScheduledFailure(c, 'card charge declined');
      }
      // unknown → verification sweeper decides
    }
  }
  await payments.verifyAndFulfil(attempt.reference, { source: 'savings_schedule' }).catch(() => {});
}

/** Scheduled job: create due contributions (unique per due date) and attempt collection. */
async function runDueContributions() {
  await settings.assertFeature('personal_savings').catch(() => null);
  if (!(await settings.isEnabled('personal_savings'))) return { skipped: 'feature_disabled' };
  const s = await settings.get('savings');
  const now = new Date();
  const due = await SavingsAccount.find({ status: 'active', 'schedule.nextDueAt': { $lte: now }, maturityDate: { $gt: now } }).limit(200);
  let created = 0;
  for (const acc of due) {
    const dueAt = acc.schedule.nextDueAt;
    try {
      // eslint-disable-next-line no-await-in-loop
      await SavingsContribution.create({ reference: ref('SVS'), accountId: acc._id, userId: acc.userId, amountKobo: acc.schedule.amountKobo, kind: 'scheduled', source: acc.schedule.fundingSource, dueAt, graceEndsAt: new Date(dueAt.getTime() + (acc.terms?.graceDays ?? s.graceDays) * DAY) });
      created += 1;
    } catch (err) {
      if (err.code !== 11000) throw err; // already created for this due date
    }
    // eslint-disable-next-line no-await-in-loop
    await SavingsAccount.updateOne({ _id: acc._id, 'schedule.nextDueAt': dueAt }, { $set: { 'schedule.nextDueAt': addPeriod(dueAt, acc.schedule.frequency) } });
  }
  // attempt pending/failed-in-grace contributions (one retry per run window)
  const toTry = await SavingsContribution.find({ kind: 'scheduled', status: { $in: ['pending', 'failed'] }, $or: [{ 'attempts.0': { $exists: false } }, { updatedAt: { $lt: new Date(Date.now() - 20 * 3600e3) } }] }).limit(200);
  for (const c of toTry) {
    // eslint-disable-next-line no-await-in-loop
    await attemptScheduled(c).catch((err) => logger.error({ err, ref: c.reference }, 'scheduled contribution attempt failed'));
  }
  // grace expired → missed
  const expired = await SavingsContribution.find({ kind: 'scheduled', status: { $in: ['pending', 'failed'] }, graceEndsAt: { $lt: now } }).limit(200);
  for (const c of expired) {
    const pa = c.paymentReference ? await PaymentAttempt.findOne({ reference: c.paymentReference }).lean() : null;
    if (pa && ['pending', 'uncertain'].includes(pa.status)) continue; // outcome unknown — do not mark missed yet
    // eslint-disable-next-line no-await-in-loop
    await handleScheduledFailure(c, c.failureReason || 'not collected within grace period');
  }
  return { created, attempted: toTry.length, expired: expired.length };
}

async function sendReminders() {
  const s = await settings.get('savings');
  const horizon = new Date(Date.now() + s.reminderHoursBefore * 3600e3);
  const accs = await SavingsAccount.find({ status: 'active', 'schedule.nextDueAt': { $gt: new Date(), $lte: horizon } }).limit(500);
  let sent = 0;
  for (const a of accs) {
    const key = `rem:${a._id}:${a.schedule.nextDueAt.toISOString()}`;
    // eslint-disable-next-line no-await-in-loop
    const n = await notifications.notify(a.userId, { category: 'savings', type: 'savings_reminder', title: 'Upcoming savings contribution', body: `${koboToNairaString(a.schedule.amountKobo)} for "${a.name}" is due ${a.schedule.nextDueAt.toDateString()}.${a.schedule.fundingSource === 'wallet' ? ' Make sure your wallet has enough funds.' : ''}`, link: `/app/savings/${a._id}`, dedupeKey: key });
    if (n) sent += 1;
  }
  return { sent };
}

async function resume(user, id) {
  const acc = await SavingsAccount.findOneAndUpdate({ _id: id, userId: user._id, status: 'paused' }, { $set: { status: 'active', consecutiveMissed: 0, 'schedule.nextDueAt': new Date(Date.now() + DAY) } }, { new: true });
  if (!acc) throw E.invalidState('Plan is not paused');
  return present(acc);
}

async function pause(user, id) {
  const acc = await SavingsAccount.findOneAndUpdate({ _id: id, userId: user._id, status: 'active' }, { $set: { status: 'paused' } }, { new: true });
  if (!acc) throw E.invalidState('Plan is not active');
  return present(acc);
}

// ---------------------------------------------------------------- early exit & maturity
async function earlyExitQuote(user, id) {
  const acc = await SavingsAccount.findOne({ _id: id, userId: user._id });
  if (!acc) throw E.notFound('Savings account');
  const bal = await ledger.getBalance(ledger.savingsCode(acc._id));
  const penalty = earlyExitPenalty(bal, acc.terms.earlyExit);
  return { balanceKobo: bal, penaltyKobo: penalty, payoutKobo: bal - penalty, rule: acc.terms.earlyExit, acceptedAt: acc.terms.acceptedAt, statement: `I want to close "${acc.name}" before maturity. A penalty of ${koboToNairaString(penalty)} applies under the terms I accepted on ${new Date(acc.terms.acceptedAt).toDateString()}. ${koboToNairaString(bal - penalty)} will be credited to my wallet.` };
}

async function earlyExit(user, id, { confirmPenaltyKobo }, req) {
  await settings.assertFeature('personal_savings');
  const q = await earlyExitQuote(user, id);
  if (confirmPenaltyKobo !== q.penaltyKobo) throw E.conflict('Please review and confirm the current early-exit amount', 'CONFIRMATION_MISMATCH', q);
  const acc = await SavingsAccount.findById(id);
  if (new Date(acc.maturityDate) <= new Date()) throw E.invalidState('This plan has matured — no penalty applies; it will be paid out automatically');
  await withTransaction(async (session) => {
    const claimed = await SavingsAccount.findOneAndUpdate({ _id: id, userId: user._id, status: { $in: ['active', 'paused'] } }, { $set: { status: 'closed_early', closedAt: new Date() } }, { new: true, session });
    if (!claimed) throw E.invalidState('Plan is not open');
    const bal = await ledger.getBalance(ledger.savingsCode(id), session);
    const penalty = earlyExitPenalty(bal, acc.terms.earlyExit);
    if (penalty !== q.penaltyKobo) throw E.conflict('Balance changed — please review again', 'CONFIRMATION_MISMATCH');
    let reference = null;
    if (bal > 0) {
      const entries = [{ account: ledger.savingsCode(id), direction: 'debit', amount: bal }];
      if (bal - penalty > 0) entries.push({ account: ledger.userCodes(user._id).wallet, direction: 'credit', amount: bal - penalty });
      if (penalty > 0) entries.push({ account: ledger.SYS.REVENUE_PENALTY, direction: 'credit', amount: penalty });
      const tx = await ledger.post({ reference: `SVX-${id}`, type: 'savings_early_exit', description: `Early exit from "${acc.name}"`, entries, initiatedBy: user._id, relatedType: 'savings_account', relatedId: id, metadata: { penaltyKobo: penalty, rule: acc.terms.earlyExit } }, session);
      reference = tx.reference;
    }
    await SavingsPayout.create([{ accountId: id, userId: user._id, kind: 'early_exit', balanceKobo: bal, penaltyKobo: penalty, payoutKobo: bal - penalty, calculation: { rule: acc.terms.earlyExit, termsAcceptedAt: acc.terms.acceptedAt }, destination: 'wallet', ledgerReference: reference, decidedAt: new Date() }], { session });
    await consent.recordFinancialCommitment(user._id, { statement: q.statement, relatedType: 'savings_early_exit', relatedId: id, ip: req.ip, userAgent: req.get('user-agent') }, session);
    await notifications.notify(user._id, { category: 'savings', type: 'savings_closed_early', title: 'Savings plan closed', body: `${koboToNairaString(bal - penalty)} was credited to your wallet${penalty ? ` after a ${koboToNairaString(penalty)} early-exit penalty` : ''}.`, link: '/app/wallet' }, { session });
    await audit.record({ ...audit.ctxFrom(req), actor: user, action: 'savings.early_exit', category: 'finance', targetType: 'savings_account', targetId: id, metadata: { balanceKobo: bal, penaltyKobo: penalty } }, { session });
  });
  return getAccount(user, id);
}

async function processMaturity(accountId) {
  const acc = await SavingsAccount.findById(accountId);
  if (!acc || !['active', 'paused'].includes(acc.status) || new Date(acc.maturityDate) > new Date()) return null;
  // Validate savings records against the ledger before paying out (no value from unverified records).
  const bal = await ledger.getBalance(ledger.savingsCode(acc._id));
  const contributed = await SavingsContribution.aggregate([{ $match: { accountId: acc._id, status: 'success' } }, { $group: { _id: null, t: { $sum: '$amountKobo' } } }]);
  if ((contributed[0]?.t || 0) !== bal) {
    await audit.raiseAlert({ severity: 'critical', type: 'savings.maturity_mismatch', message: `Savings ${acc._id} ledger balance ${bal} ≠ contributions ${contributed[0]?.t || 0}; maturity held for review`, refType: 'savings_account', refId: acc._id, dedupeKey: `sav_mismatch:${acc._id}` });
    return null;
  }
  await withTransaction(async (session) => {
    const claimed = await SavingsAccount.findOneAndUpdate({ _id: acc._id, status: { $in: ['active', 'paused'] } }, { $set: { status: 'matured', closedAt: new Date() } }, { new: true, session });
    if (!claimed) return;
    let reference = null;
    if (bal > 0) {
      const tx = await ledger.post({ reference: `SVM-${acc._id}`, type: 'savings_maturity', description: `Savings "${acc.name}" matured`, entries: [{ account: ledger.savingsCode(acc._id), direction: 'debit', amount: bal }, { account: ledger.userCodes(acc.userId).wallet, direction: 'credit', amount: bal }], relatedType: 'savings_account', relatedId: acc._id }, session);
      reference = tx.reference;
    }
    await SavingsPayout.create([{ accountId: acc._id, userId: acc.userId, kind: 'maturity', balanceKobo: bal, penaltyKobo: 0, payoutKobo: bal, calculation: { interestBp: 0, note: 'No interest at launch' }, destination: acc.payoutPreference, ledgerReference: reference, decidedAt: new Date() }], { session });
    await notifications.notify(acc.userId, { category: 'savings', type: 'savings_matured', title: 'Your savings matured 🎉', body: `${koboToNairaString(bal)} from "${acc.name}" is now in your wallet.`, link: '/app/wallet', dedupeKey: `sav_mature:${acc._id}` }, { session });
  });
  if (acc.payoutPreference === 'bank' && acc.payoutBankAccountId && bal > 0) {
    const wallet = require('../wallet/wallet.service');
    const user = await User.findById(acc.userId);
    try {
      const w = await wallet.requestWithdrawal(user, { amountKobo: bal, bankAccountId: acc.payoutBankAccountId }, { idempotencyKey: `maturity-${acc._id}` });
      await SavingsPayout.updateOne({ accountId: acc._id }, { $set: { withdrawalReference: w.reference } });
    } catch (err) {
      await notifications.notify(acc.userId, { category: 'savings', type: 'maturity_bank_payout_failed', title: 'Bank payout not started', body: `Your matured savings are in your wallet. We could not start the bank withdrawal automatically: ${err.message}`, link: '/app/wallet' });
    }
  }
  return SavingsAccount.findById(acc._id);
}

async function runMaturities() {
  const due = await SavingsAccount.find({ status: { $in: ['active', 'paused'] }, maturityDate: { $lte: new Date() } }, { _id: 1 }).limit(200).lean();
  let matured = 0;
  for (const d of due) {
    // eslint-disable-next-line no-await-in-loop
    const r = await processMaturity(d._id).catch((err) => logger.error({ err }, 'maturity failed'));
    if (r?.status === 'matured') matured += 1;
  }
  return { due: due.length, matured };
}

async function liabilitySummary() {
  const r = await LedgerAccount.aggregate([{ $match: { purpose: 'user_savings' } }, { $group: { _id: null, total: { $sum: '$balance' }, n: { $sum: 1 } } }]);
  return { totalKobo: r[0]?.total || 0, accounts: r[0]?.n || 0 };
}

module.exports = { createPlan, updatePlan, listPlans, enroll, listAccounts, getAccount, manualDeposit, runDueContributions, sendReminders, resume, pause, earlyExitQuote, earlyExit, processMaturity, runMaturities, earlyExitPenalty, addPeriod, liabilitySummary, disclosure };
