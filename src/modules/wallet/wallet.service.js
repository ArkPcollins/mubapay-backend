'use strict';
const crypto = require('crypto');
const { Transfer, BankAccount, Withdrawal } = require('./wallet.models');
const { User } = require('../users/user.model');
const { LedgerAccount, LedgerTransaction, LedgerEntry } = require('../ledger/ledger.models');
const { PaymentAttempt } = require('../payments/payment.models');
const ledger = require('../ledger/ledger.service');
const limits = require('../payments/limits.service');
const payments = require('../payments/payments.service');
const paystack = require('../../providers/paystack/paystack.adapter');
const settings = require('../settings/settings.service');
const notifications = require('../notifications/notifications.service');
const audit = require('../audit/audit.service');
const consent = require('../legal/consent.service');
const usersService = require('../users/users.service');
const { withTransaction } = require('../../lib/db');
const { E } = require('../../lib/errors');
const { assertPositiveKobo, computeFee, koboToNairaString } = require('../../lib/money');
const { encryptString, decryptString } = require('../../lib/crypto');
const logger = require('../../lib/logger');

const deterministicRef = (prefix, userId, key) => `${prefix}-${crypto.createHash('sha256').update(`${userId}:${key}`).digest('hex').slice(0, 20).toUpperCase()}`;

async function requireTier(user, min, action) {
  if (user.verificationTier < min) {
    throw E.verificationRequired(`${action} requires verification tier ${min}. Your current tier is ${user.verificationTier}.`, { requiredTier: min, currentTier: user.verificationTier });
  }
}

// ---------------------------------------------------------------- overview
async function overview(user) {
  const codes = ledger.userCodes(user._id);
  const [wallet, hold, seller, pendingFunding, pendingWithdrawals, savingsAccounts] = await Promise.all([
    LedgerAccount.findOne({ code: codes.wallet }).lean(),
    LedgerAccount.findOne({ code: codes.hold }).lean(),
    LedgerAccount.findOne({ code: codes.sellerPayable }).lean(),
    PaymentAttempt.aggregate([{ $match: { userId: user._id, purpose: 'wallet_funding', status: { $in: ['pending', 'uncertain'] }, fulfilledAt: null } }, { $group: { _id: null, t: { $sum: '$amountKobo' }, n: { $sum: 1 } } }]),
    Withdrawal.countDocuments({ userId: user._id, status: { $in: ['pending_review', 'approved', 'payout_processing', 'payout_uncertain', 'manual_payout_pending'] } }),
    LedgerAccount.find({ ownerId: user._id, purpose: 'user_savings' }, { balance: 1 }).lean(),
  ]);
  return {
    currency: 'NGN',
    availableKobo: wallet?.balance || 0,
    reservedForWithdrawalsKobo: hold?.balance || 0,
    sellerProceedsPendingKobo: seller?.balance || 0,
    pendingFundingKobo: pendingFunding[0]?.t || 0,
    pendingFundingCount: pendingFunding[0]?.n || 0,
    pendingWithdrawalCount: pendingWithdrawals,
    savingsTotalKobo: savingsAccounts.reduce((a, s) => a + s.balance, 0),
    notes: {
      available: 'Spendable now.',
      reserved: 'Held for withdrawal requests under review or being paid out. Not spendable.',
      sellerPending: 'Proceeds from sales awaiting delivery confirmation and the settlement hold period. Not spendable.',
      pendingFunding: 'Payments not yet confirmed by Paystack. Not spendable until confirmed.',
    },
    limits: await limits.usage(user),
  };
}

// ---------------------------------------------------------------- funding
async function initFunding(user, { amountKobo, acceptedPolicies }, { idempotencyKey }) {
  assertPositiveKobo(amountKobo);
  await settings.assertFeature('wallet_funding', { complianceKey: 'walletOperationsAuthorized' });
  const v = await settings.get('verification');
  await requireTier(user, v.financialMinTier, 'Wallet funding');
  if (acceptedPolicies?.length) {
    await consent.assertRequiredAccepted(acceptedPolicies, 'wallet');
    await consent.recordAcceptances(user._id, acceptedPolicies, { context: 'wallet_funding' });
  }
  await consent.assertUserAccepted(user._id, 'wallet');
  const lim = await settings.get('limits');
  if (amountKobo < lim.minFundingKobo) throw E.validation([{ path: 'amountKobo', message: `Minimum funding is ${koboToNairaString(lim.minFundingKobo)}` }]);
  const pending = await PaymentAttempt.aggregate([{ $match: { userId: user._id, purpose: 'wallet_funding', status: { $in: ['pending', 'uncertain'] }, createdAt: { $gt: new Date(Date.now() - 864e5) } } }, { $group: { _id: null, t: { $sum: '$amountKobo' } } }]);
  await limits.precheck(user, 'funding', amountKobo, { pendingKobo: pending[0]?.t || 0 });
  const fees = await settings.get('fees');
  const feeKobo = computeFee(amountKobo, fees.funding);
  const attempt = await payments.initPayment({ user, purpose: 'wallet_funding', amountKobo, feeKobo, relatedType: 'wallet', relatedId: user._id, idempotencyKey, callbackPath: '/app/wallet/funding/return' });
  return payments.present(attempt);
}

payments.registerPurpose('wallet_funding', {
  async creditTarget(attempt, session) {
    const user = await User.findById(attempt.userId).session(session);
    // Limits are consumed on confirmation; money already received is always credited.
    const { exceeded } = await limits.consume(user, 'funding', attempt.amountKobo, session, { enforce: false });
    if (exceeded.length) {
      await audit.raiseAlert({ severity: 'warning', type: 'risk.funding_limit_exceeded', message: `User ${user.email} funding exceeded limits after confirmation (${attempt.reference})`, refType: 'payment', refId: attempt.reference });
    }
    return { account: ledger.userCodes(attempt.userId).wallet, ledgerType: 'wallet_funding', description: `Wallet funding via Paystack (${attempt.reference})` };
  },
  async onSuccess(attempt, session) {
    await notifications.notify(attempt.userId, { category: 'financial', type: 'wallet_funded', title: 'Wallet funded', body: `${koboToNairaString(attempt.amountKobo)} was added to your wallet.`, link: '/app/wallet', dedupeKey: `funded:${attempt.reference}` }, { session });
  },
});

// ---------------------------------------------------------------- transfers
async function findRecipient(identifier) {
  const id = String(identifier || '').trim();
  if (/^[a-f0-9]{24}$/.test(id)) return User.findById(id);
  if (id.includes('@')) return User.findOne({ email: id.toLowerCase() });
  const phone = usersService.normalisePhone(id);
  if (phone) return User.findOne({ phone, phoneVerifiedAt: { $ne: null } });
  return null;
}

async function lookupRecipient(user, identifier) {
  const r = await findRecipient(identifier);
  if (!r || r.status !== 'active' || String(r._id) === String(user._id)) throw E.notFound('Recipient');
  return { id: String(r._id), displayName: r.toPublic().displayName };
}

async function transfer(sender, { recipient, amountKobo, narration }, { idempotencyKey, req }) {
  assertPositiveKobo(amountKobo);
  await settings.assertFeature('transfers', { complianceKey: 'walletOperationsAuthorized' });
  const v = await settings.get('verification');
  await requireTier(sender, v.financialMinTier, 'Transfers');
  if (sender.status !== 'active') throw E.forbidden('Your account is restricted');
  const to = await findRecipient(recipient);
  if (!to || to.status !== 'active') throw E.notFound('Recipient');
  if (String(to._id) === String(sender._id)) throw E.badRequest('You cannot transfer to yourself');
  if ((to.blockedUserIds || []).some((b) => String(b) === String(sender._id))) throw E.forbidden('This recipient cannot receive transfers from you');
  await ledger.ensureUserAccounts(to._id);
  const [fees, risk] = await Promise.all([settings.get('fees'), settings.get('risk')]);
  const feeKobo = computeFee(amountKobo, fees.transfer);
  const reference = deterministicRef('TRF', sender._id, idempotencyKey);
  const existing = await Transfer.findOne({ reference }).lean();
  if (existing) return presentTransfer(existing, sender._id);

  const recentCount = await Transfer.countDocuments({ senderId: sender._id, createdAt: { $gt: new Date(Date.now() - 3600e3) } });
  const holdReason = amountKobo > risk.holdTransferAboveKobo ? 'amount_above_review_threshold' : recentCount >= risk.maxTransfersPerHour ? 'velocity' : null;

  const sc = ledger.userCodes(sender._id);
  const rc = ledger.userCodes(to._id);
  const doc = await withTransaction(async (session) => {
    await limits.consume(sender, 'transfer', amountKobo, session);
    const entries = holdReason
      ? [{ account: sc.wallet, direction: 'debit', amount: amountKobo + feeKobo }, { account: sc.hold, direction: 'credit', amount: amountKobo + feeKobo }]
      : [{ account: sc.wallet, direction: 'debit', amount: amountKobo + feeKobo }, { account: rc.wallet, direction: 'credit', amount: amountKobo }, ...(feeKobo ? [{ account: ledger.SYS.REVENUE_FEES, direction: 'credit', amount: feeKobo }] : [])];
    const tx = await ledger.post({ reference, type: 'transfer', description: holdReason ? `Transfer to ${to.email} held for review` : `Transfer to ${to.toPublic().displayName}`, entries, initiatedBy: sender._id, relatedType: 'transfer', relatedId: reference, metadata: { recipientId: String(to._id), narration, held: Boolean(holdReason) } }, session);
    const [t] = await Transfer.create([{ reference, senderId: sender._id, recipientId: to._id, amountKobo, feeKobo, narration, status: holdReason ? 'held' : 'completed', holdReason, ledgerTransactionId: tx._id }], { session });
    if (holdReason) {
      await notifications.notify(sender._id, { category: 'financial', type: 'transfer_held', title: 'Transfer under review', body: `Your transfer of ${koboToNairaString(amountKobo)} is being reviewed for your security. The funds are reserved and not spendable until the review completes.`, link: '/app/wallet' }, { session });
    } else {
      await notifications.notify(sender._id, { category: 'financial', type: 'transfer_sent', title: 'Transfer sent', body: `You sent ${koboToNairaString(amountKobo)} to ${to.toPublic().displayName}.`, link: '/app/wallet' }, { session });
      await notifications.notify(to._id, { category: 'financial', type: 'transfer_received', title: 'Money received', body: `You received ${koboToNairaString(amountKobo)} from ${sender.toPublic().displayName}.`, link: '/app/wallet' }, { session });
    }
    await audit.record({ ...audit.ctxFrom(req), actor: sender, action: holdReason ? 'transfer.held' : 'transfer.completed', category: 'finance', targetType: 'transfer', targetId: reference, metadata: { amountKobo, recipientId: String(to._id), holdReason } }, { session });
    return t;
  }).catch(async (err) => {
    if (err instanceof ledger.DuplicatePostingError) return Transfer.findOne({ reference });
    throw err;
  });
  if (holdReason) await notifications.notifyStaff('risk.review', { category: 'system', type: 'risk_review_needed', title: 'Transfer held for review', body: `${koboToNairaString(amountKobo)} — ${holdReason}`, link: '/admin/risk' });
  return presentTransfer(doc.toObject ? doc.toObject() : doc, sender._id);
}

function presentTransfer(t, viewerId) {
  return { reference: t.reference, amountKobo: t.amountKobo, feeKobo: t.feeKobo, narration: t.narration, status: t.status, direction: String(t.senderId) === String(viewerId) ? 'out' : 'in', createdAt: t.createdAt, holdReason: t.status === 'held' ? 'Under security review' : undefined };
}

/** Risk review of a held transfer (permission risk.review). */
async function reviewHeldTransfer(staff, reference, { decision, note }, req) {
  if (!['approve', 'reject'].includes(decision)) throw E.badRequest('decision must be approve or reject');
  const t = await Transfer.findOne({ reference });
  if (!t) throw E.notFound('Transfer');
  if (String(t.senderId) === String(staff._id)) throw E.forbidden('You cannot review your own transfer');
  const sc = ledger.userCodes(t.senderId);
  const rc = ledger.userCodes(t.recipientId);
  await withTransaction(async (session) => {
    const updated = await Transfer.findOneAndUpdate({ _id: t._id, status: 'held' }, { $set: { status: decision === 'approve' ? 'completed' : 'rejected', reviewedBy: staff._id, reviewedAt: new Date() } }, { new: true, session });
    if (!updated) throw E.invalidState('Transfer is no longer held');
    const total = t.amountKobo + t.feeKobo;
    const entries = decision === 'approve'
      ? [{ account: sc.hold, direction: 'debit', amount: total }, { account: rc.wallet, direction: 'credit', amount: t.amountKobo }, ...(t.feeKobo ? [{ account: ledger.SYS.REVENUE_FEES, direction: 'credit', amount: t.feeKobo }] : [])]
      : [{ account: sc.hold, direction: 'debit', amount: total }, { account: sc.wallet, direction: 'credit', amount: total }];
    await ledger.post({ reference: `${reference}-${decision === 'approve' ? 'REL' : 'RJT'}`, type: 'transfer', description: `Held transfer ${decision}d`, entries, initiatedBy: staff._id, approvedBy: [staff._id], relatedType: 'transfer', relatedId: reference, metadata: { note } }, session);
    if (decision === 'reject') {
      const sender = await User.findById(t.senderId).session(session);
      await limits.release(sender._id, 'transfer', t.amountKobo, t.createdAt, session);
    }
    await notifications.notify(t.senderId, { category: 'financial', type: `transfer_${decision}d`, title: decision === 'approve' ? 'Transfer completed' : 'Transfer declined', body: decision === 'approve' ? `Your transfer of ${koboToNairaString(t.amountKobo)} was completed.` : `Your transfer of ${koboToNairaString(t.amountKobo)} was declined after review. The funds are back in your wallet.`, link: '/app/wallet' }, { session });
    if (decision === 'approve') await notifications.notify(t.recipientId, { category: 'financial', type: 'transfer_received', title: 'Money received', body: `You received ${koboToNairaString(t.amountKobo)}.`, link: '/app/wallet' }, { session });
    await audit.record({ ...audit.ctxFrom(req), actor: staff, action: `transfer.review_${decision}`, category: 'finance', targetType: 'transfer', targetId: reference, reason: note }, { session });
  });
  return Transfer.findOne({ reference }).lean();
}

// ---------------------------------------------------------------- bank accounts
async function listBanks() {
  return paystack.listBanks();
}

async function addBankAccount(user, { bankCode, accountNumber, bankName }, req) {
  if (!/^\d{10}$/.test(String(accountNumber))) throw E.validation([{ path: 'accountNumber', message: 'NUBAN account numbers have 10 digits' }]);
  let resolved = null;
  let nameMatchStatus = 'unverified';
  if (paystack.status().configured) {
    try {
      resolved = await paystack.resolveAccount({ accountNumber, bankCode });
    } catch (err) {
      if (err.outcome === 'rejected') throw E.badRequest('We could not verify this bank account. Check the number and bank.');
      throw E.provider('Bank verification is temporarily unavailable. Try again shortly.');
    }
    const legal = `${user.firstName || ''} ${user.lastName || ''}`.toUpperCase().split(/\s+/).filter(Boolean);
    const acct = (resolved.accountName || '').toUpperCase();
    nameMatchStatus = legal.length && legal.every((n) => acct.includes(n)) ? 'matched' : 'mismatch';
  }
  const count = await BankAccount.countDocuments({ userId: user._id, status: 'active' });
  if (count >= 5) throw E.conflict('You can save up to 5 bank accounts');
  const doc = await BankAccount.create({ userId: user._id, bankCode, bankName, accountNumberEnc: encryptString(accountNumber), accountNumberLast4: String(accountNumber).slice(-4), accountName: resolved?.accountName, nameMatchStatus });
  await audit.fromReq(req, { action: 'bank_account.added', category: 'finance', targetType: 'bank_account', targetId: doc._id, metadata: { bankCode, last4: doc.accountNumberLast4, nameMatchStatus } });
  await notifications.notify(user._id, { category: 'security', type: 'bank_account_added', title: 'New bank account added', body: `A bank account ending ${doc.accountNumberLast4} was added for withdrawals. If this wasn't you, contact support now.` });
  return presentBank(doc);
}

const presentBank = (b) => ({ id: String(b._id), bankCode: b.bankCode, bankName: b.bankName, accountNumberLast4: b.accountNumberLast4, accountName: b.accountName, nameMatchStatus: b.nameMatchStatus, createdAt: b.createdAt });

async function listBankAccounts(user) {
  return (await BankAccount.find({ userId: user._id, status: 'active' }).lean()).map(presentBank);
}

async function removeBankAccount(user, id) {
  const r = await BankAccount.updateOne({ _id: id, userId: user._id, status: 'active' }, { $set: { status: 'removed' } });
  if (!r.modifiedCount) throw E.notFound('Bank account');
}

// ---------------------------------------------------------------- withdrawals
async function requestWithdrawal(user, { amountKobo, bankAccountId }, { idempotencyKey, req }) {
  assertPositiveKobo(amountKobo);
  await settings.assertFeature('withdrawals', { complianceKey: 'walletOperationsAuthorized' });
  const v = await settings.get('verification');
  await requireTier(user, v.withdrawalMinTier, 'Withdrawals');
  if (user.status !== 'active') throw E.forbidden('Your account is restricted');
  const bank = await BankAccount.findOne({ _id: bankAccountId, userId: user._id, status: 'active' });
  if (!bank) throw E.notFound('Bank account');
  if (bank.nameMatchStatus === 'mismatch') throw E.conflict('The bank account name does not match your verified name. Contact support to proceed.', 'BANK_NAME_MISMATCH');
  const [lim, fees, risk] = await Promise.all([settings.get('limits'), settings.get('fees'), settings.get('risk')]);
  if (amountKobo < lim.minWithdrawalKobo) throw E.validation([{ path: 'amountKobo', message: `Minimum withdrawal is ${koboToNairaString(lim.minWithdrawalKobo)}` }]);
  const feeKobo = computeFee(amountKobo, fees.withdrawal);
  const reference = deterministicRef('WDR', user._id, idempotencyKey);
  const existing = await Withdrawal.findOne({ reference }).lean();
  if (existing) return presentWithdrawal(existing);
  const c = ledger.userCodes(user._id);
  const w = await withTransaction(async (session) => {
    await limits.consume(user, 'withdrawal', amountKobo, session);
    const [doc] = await Withdrawal.create([{ reference, userId: user._id, bankAccountId: bank._id, amountKobo, feeKobo, requiresDualApproval: amountKobo > risk.dualApprovalWithdrawalAboveKobo, history: [{ at: new Date(), status: 'pending_review', by: user._id }] }], { session });
    const tx = await ledger.post({ reference: `${reference}-HOLD`, type: 'withdrawal_hold', description: 'Funds reserved for withdrawal request', entries: [{ account: c.wallet, direction: 'debit', amount: amountKobo + feeKobo }, { account: c.hold, direction: 'credit', amount: amountKobo + feeKobo }], initiatedBy: user._id, relatedType: 'withdrawal', relatedId: reference }, session);
    doc.holdLedgerTxId = tx._id;
    await doc.save({ session });
    await notifications.notify(user._id, { category: 'financial', type: 'withdrawal_requested', title: 'Withdrawal requested', body: `Your withdrawal of ${koboToNairaString(amountKobo)} is awaiting review. The amount is reserved and not spendable.`, link: '/app/wallet/withdrawals' }, { session });
    await audit.record({ ...audit.ctxFrom(req), actor: user, action: 'withdrawal.requested', category: 'finance', targetType: 'withdrawal', targetId: reference, metadata: { amountKobo, feeKobo } }, { session });
    return doc;
  }).catch(async (err) => {
    if (err instanceof ledger.DuplicatePostingError || err.code === 11000) return Withdrawal.findOne({ reference });
    throw err;
  });
  await notifications.notifyStaff('withdrawals.approve', { category: 'system', type: 'withdrawal_review_needed', title: 'Withdrawal awaiting review', body: `${koboToNairaString(amountKobo)} (${reference})`, link: '/admin/withdrawals' });
  return presentWithdrawal(w.toObject ? w.toObject() : w);
}

function presentWithdrawal(w, { staff = false } = {}) {
  const base = { reference: w.reference, amountKobo: w.amountKobo, feeKobo: w.feeKobo, status: w.status, payoutMethod: w.payoutMethod, rejectionReason: w.rejectionReason, failureReason: w.failureReason, createdAt: w.createdAt, updatedAt: w.updatedAt, history: (w.history || []).map((h) => ({ at: h.at, status: h.status, note: staff ? h.note : undefined })) };
  if (staff) Object.assign(base, { id: String(w._id), userId: String(w.userId), requiresDualApproval: w.requiresDualApproval, approvals: w.approvals, payoutReference: w.payoutReference, providerStatus: w.providerStatus, manualEvidence: w.manualEvidence });
  return base;
}

async function releaseHold(w, reason, status, session, by) {
  const c = ledger.userCodes(w.userId);
  const total = w.amountKobo + w.feeKobo;
  await ledger.post({ reference: `${w.reference}-RELEASE`, type: 'withdrawal_release', description: `Withdrawal ${status}: funds returned to wallet`, entries: [{ account: c.hold, direction: 'debit', amount: total }, { account: c.wallet, direction: 'credit', amount: total }], initiatedBy: by, relatedType: 'withdrawal', relatedId: w.reference, metadata: { reason } }, session);
  await limits.release(w.userId, 'withdrawal', w.amountKobo, w.createdAt, session);
}

async function approveWithdrawal(staff, reference, { note }, req) {
  const w = await Withdrawal.findOne({ reference });
  if (!w) throw E.notFound('Withdrawal');
  if (String(w.userId) === String(staff._id)) throw E.forbidden('You cannot approve your own withdrawal');
  if (w.approvals.some((a) => String(a.by) === String(staff._id))) throw E.conflict('You have already approved this withdrawal', 'ALREADY_APPROVED');
  const needed = w.requiresDualApproval ? 2 : 1;
  const updated = await withTransaction(async (session) => {
    const doc = await Withdrawal.findOneAndUpdate(
      { _id: w._id, status: 'pending_review', 'approvals.by': { $ne: staff._id } },
      { $push: { approvals: { by: staff._id, at: new Date(), note }, history: { at: new Date(), status: 'approval_recorded', by: staff._id, note } } },
      { new: true, session }
    );
    if (!doc) throw E.invalidState('Withdrawal is not awaiting review');
    if (doc.approvals.length >= needed) {
      doc.status = 'approved';
      doc.history.push({ at: new Date(), status: 'approved', by: staff._id });
      await doc.save({ session });
    }
    await audit.record({ ...audit.ctxFrom(req), actor: staff, action: 'withdrawal.approval', category: 'finance', targetType: 'withdrawal', targetId: reference, reason: note, metadata: { approvals: doc.approvals.length, needed } }, { session });
    return doc;
  });
  if (updated.status === 'approved') {
    await notifications.notify(updated.userId, { category: 'financial', type: 'withdrawal_approved', title: 'Withdrawal approved', body: `Your withdrawal of ${koboToNairaString(updated.amountKobo)} was approved and will be paid out shortly.`, link: '/app/wallet/withdrawals' });
  }
  return presentWithdrawal(updated.toObject(), { staff: true });
}

async function rejectWithdrawal(staff, reference, { reason }, req) {
  if (!reason || reason.length < 5) throw E.validation([{ path: 'reason', message: 'A rejection reason is required' }]);
  const w = await Withdrawal.findOne({ reference });
  if (!w) throw E.notFound('Withdrawal');
  if (String(w.userId) === String(staff._id)) throw E.forbidden('You cannot review your own withdrawal');
  const out = await withTransaction(async (session) => {
    const doc = await Withdrawal.findOneAndUpdate({ _id: w._id, status: { $in: ['pending_review', 'approved'] } }, { $set: { status: 'rejected', rejectedBy: staff._id, rejectionReason: reason }, $push: { history: { at: new Date(), status: 'rejected', by: staff._id, note: reason } } }, { new: true, session });
    if (!doc) throw E.invalidState('Withdrawal can no longer be rejected');
    await releaseHold(doc, reason, 'rejected', session, staff._id);
    await notifications.notify(doc.userId, { category: 'financial', type: 'withdrawal_rejected', title: 'Withdrawal not approved', body: `Your withdrawal of ${koboToNairaString(doc.amountKobo)} was not approved: ${reason}. The funds are back in your wallet.`, link: '/app/wallet/withdrawals' }, { session });
    await audit.record({ ...audit.ctxFrom(req), actor: staff, action: 'withdrawal.rejected', category: 'finance', targetType: 'withdrawal', targetId: reference, reason }, { session });
    return doc;
  });
  return presentWithdrawal(out.toObject(), { staff: true });
}

/** Start an automated Paystack payout for an approved withdrawal. */
async function initiatePayout(staff, reference, req) {
  const w = await Withdrawal.findOne({ reference });
  if (!w) throw E.notFound('Withdrawal');
  if (String(w.userId) === String(staff._id)) throw E.forbidden('You cannot pay out your own withdrawal');
  const payoutReference = `${reference}-PO`;
  const claimed = await Withdrawal.findOneAndUpdate(
    { _id: w._id, status: 'approved' },
    { $set: { status: 'payout_processing', payoutMethod: 'paystack_transfer', payoutReference }, $push: { history: { at: new Date(), status: 'payout_processing', by: staff._id } } },
    { new: true }
  );
  if (!claimed) throw E.invalidState('Withdrawal is not approved for payout (or payout already started)');
  await audit.fromReq(req, { action: 'withdrawal.payout_initiated', category: 'finance', targetType: 'withdrawal', targetId: reference });
  const bank = await BankAccount.findById(w.bankAccountId).select('+accountNumberEnc +recipientCode');
  try {
    if (!bank.recipientCode) {
      const r = await paystack.createTransferRecipient({ name: bank.accountName || 'MubaPay customer', accountNumber: decryptString(bank.accountNumberEnc), bankCode: bank.bankCode });
      bank.recipientCode = r.recipientCode;
      await bank.save();
    }
    const res = await paystack.initiateTransfer({ amountKobo: w.amountKobo, recipientCode: bank.recipientCode, reference: payoutReference, reason: `MubaPay withdrawal ${reference}` });
    await Withdrawal.updateOne({ _id: w._id }, { $set: { providerStatus: res.status, providerTransferCode: res.transferCode } });
    // Accepted ≠ paid. Confirm via webhook or verify; check now in case it settled instantly.
    if (res.status === 'success') await checkPayout(reference);
  } catch (err) {
    if (err.outcome === 'rejected' || err.code === 'INTEGRATION_NOT_CONFIGURED') {
      // Definitive rejection before any money left: revert to approved so staff can retry or pay manually.
      await Withdrawal.updateOne({ _id: w._id, status: 'payout_processing' }, { $set: { status: 'approved', providerStatus: 'rejected', failureReason: err.message, payoutReference: null }, $push: { history: { at: new Date(), status: 'payout_rejected_by_provider', note: err.message } } });
      throw err.code === 'INTEGRATION_NOT_CONFIGURED' ? err : E.provider(`Paystack rejected the payout: ${err.message}`);
    }
    // Unknown outcome (timeout/5xx): the transfer may have been created. Mark uncertain; reconciliation verifies.
    await Withdrawal.updateOne({ _id: w._id, status: 'payout_processing' }, { $set: { status: 'payout_uncertain', providerStatus: 'unknown', failureReason: err.message }, $push: { history: { at: new Date(), status: 'payout_uncertain', note: 'Provider did not confirm — awaiting verification' } } });
    await audit.raiseAlert({ severity: 'warning', type: 'payout.uncertain', message: `Payout ${payoutReference} outcome unknown: ${err.message}`, refType: 'withdrawal', refId: reference, dedupeKey: `payout_uncertain:${reference}` });
  }
  return presentWithdrawal((await Withdrawal.findById(w._id)).toObject(), { staff: true });
}

/** Verify a payout's outcome with Paystack and apply terminal accounting once. */
async function checkPayout(reference) {
  const w = await Withdrawal.findOne({ reference });
  if (!w || !['payout_processing', 'payout_uncertain'].includes(w.status) || !w.payoutReference) return w;
  let v;
  try {
    v = await paystack.verifyTransfer(w.payoutReference);
  } catch (err) {
    await Withdrawal.updateOne({ _id: w._id }, { $set: { lastCheckedAt: new Date() } });
    return w;
  }
  await Withdrawal.updateOne({ _id: w._id }, { $set: { lastCheckedAt: new Date(), providerStatus: v.found ? v.status : 'not_found' } });
  if (!v.found) {
    if (w.status === 'payout_uncertain' && Date.now() - w.updatedAt.getTime() > 24 * 3600e3) {
      await audit.raiseAlert({ severity: 'critical', type: 'payout.unresolved', message: `Payout ${w.payoutReference} not found at Paystack after 24h — manual investigation required`, refType: 'withdrawal', refId: reference, dedupeKey: `payout_unresolved:${reference}` });
    }
    return w;
  }
  if (v.amountKobo != null && v.amountKobo !== w.amountKobo) {
    await audit.raiseAlert({ severity: 'critical', type: 'payout.amount_mismatch', message: `Payout ${w.payoutReference} amount mismatch`, refType: 'withdrawal', refId: reference, dedupeKey: `payout_mismatch:${reference}` });
    return w;
  }
  if (v.status === 'success') return completeWithdrawal(w, { method: 'paystack_transfer' });
  if (['failed', 'reversed'].includes(v.status)) return failWithdrawal(w, `Payout ${v.status} at provider${v.reason ? `: ${v.reason}` : ''}`);
  return w; // pending / processing / otp / queued
}

async function completeWithdrawal(w, { method, by, evidence }) {
  const c = ledger.userCodes(w.userId);
  const total = w.amountKobo + w.feeKobo;
  return withTransaction(async (session) => {
    const doc = await Withdrawal.findOneAndUpdate(
      { _id: w._id, status: { $in: ['payout_processing', 'payout_uncertain', 'manual_payout_pending'] } },
      { $set: { status: 'completed', ...(evidence ? { 'manualEvidence.bankReference': evidence.bankReference, 'manualEvidence.note': evidence.note, 'manualEvidence.confirmedBy': by, 'manualEvidence.at': new Date() } : {}) }, $push: { history: { at: new Date(), status: 'completed', by } } },
      { new: true, session }
    );
    if (!doc) return Withdrawal.findById(w._id).session(session);
    const sourceAccount = method === 'manual' ? ledger.SYS.MANUAL_PAYOUT_BANK : ledger.SYS.PAYSTACK_BALANCE;
    const entries = [{ account: c.hold, direction: 'debit', amount: total }, { account: sourceAccount, direction: 'credit', amount: w.amountKobo }];
    if (w.feeKobo) entries.push({ account: ledger.SYS.REVENUE_FEES, direction: 'credit', amount: w.feeKobo });
    const tx = await ledger.post({ reference: `${w.reference}-PAID`, type: 'withdrawal_payout', description: `Withdrawal paid out (${method})`, entries, initiatedBy: by, relatedType: 'withdrawal', relatedId: w.reference }, session);
    doc.settleLedgerTxId = tx._id;
    await doc.save({ session });
    await notifications.notify(w.userId, { category: 'financial', type: 'withdrawal_completed', title: 'Withdrawal paid', body: `${koboToNairaString(w.amountKobo)} has been sent to your bank account.`, link: '/app/wallet/withdrawals', dedupeKey: `wd_done:${w.reference}` }, { session });
    await audit.record({ actor: by ? { _id: by } : undefined, actorType: by ? 'staff' : 'provider', action: 'withdrawal.completed', category: 'finance', targetType: 'withdrawal', targetId: w.reference, metadata: { method } }, { session });
    return doc;
  });
}

async function failWithdrawal(w, reason) {
  return withTransaction(async (session) => {
    const doc = await Withdrawal.findOneAndUpdate({ _id: w._id, status: { $in: ['payout_processing', 'payout_uncertain'] } }, { $set: { status: 'failed', failureReason: reason }, $push: { history: { at: new Date(), status: 'failed', note: reason } } }, { new: true, session });
    if (!doc) return Withdrawal.findById(w._id).session(session);
    await releaseHold(doc, reason, 'failed', session);
    await notifications.notify(w.userId, { category: 'financial', type: 'withdrawal_failed', title: 'Withdrawal could not be completed', body: `Your withdrawal of ${koboToNairaString(w.amountKobo)} failed. The funds are back in your wallet.`, link: '/app/wallet/withdrawals', dedupeKey: `wd_fail:${w.reference}` }, { session });
    await audit.record({ actorType: 'provider', action: 'withdrawal.failed', category: 'finance', targetType: 'withdrawal', targetId: w.reference, reason }, { session });
    return doc;
  });
}

/** Provider reversed a completed payout: money is back in our provider balance → return to customer wallet. */
async function reverseCompletedWithdrawal(w, reason) {
  const c = ledger.userCodes(w.userId);
  return withTransaction(async (session) => {
    const doc = await Withdrawal.findOneAndUpdate({ _id: w._id, status: 'completed', payoutMethod: 'paystack_transfer' }, { $set: { status: 'reversed', failureReason: reason }, $push: { history: { at: new Date(), status: 'reversed', note: reason } } }, { new: true, session });
    if (!doc) return null;
    await ledger.post({ reference: `${w.reference}-REVERSED`, type: 'withdrawal_reversal', description: 'Payout reversed by provider; funds returned to wallet', entries: [{ account: ledger.SYS.PAYSTACK_BALANCE, direction: 'debit', amount: w.amountKobo }, { account: c.wallet, direction: 'credit', amount: w.amountKobo }], relatedType: 'withdrawal', relatedId: w.reference }, session);
    await notifications.notify(w.userId, { category: 'financial', type: 'withdrawal_reversed', title: 'Withdrawal returned', body: `Your bank returned a payout of ${koboToNairaString(w.amountKobo)}. The funds are back in your wallet.`, link: '/app/wallet/withdrawals' }, { session });
    return doc;
  });
}

/** Manual payout: staff A records that money was sent outside Paystack; staff B confirms with evidence. */
async function markManualPayout(staff, reference, { note }, req) {
  const w = await Withdrawal.findOne({ reference });
  if (!w) throw E.notFound('Withdrawal');
  if (String(w.userId) === String(staff._id)) throw E.forbidden('You cannot pay out your own withdrawal');
  const doc = await Withdrawal.findOneAndUpdate({ _id: w._id, status: 'approved' }, { $set: { status: 'manual_payout_pending', payoutMethod: 'manual', 'manualEvidence.initiatedBy': staff._id, 'manualEvidence.note': note }, $push: { history: { at: new Date(), status: 'manual_payout_pending', by: staff._id, note } } }, { new: true });
  if (!doc) throw E.invalidState('Withdrawal is not approved for payout');
  await audit.fromReq(req, { action: 'withdrawal.manual_payout_started', category: 'finance', targetType: 'withdrawal', targetId: reference, reason: note });
  return presentWithdrawal(doc.toObject(), { staff: true });
}

async function confirmManualPayout(staff, reference, { bankReference, note }, req) {
  if (!bankReference || bankReference.length < 4) throw E.validation([{ path: 'bankReference', message: 'Bank transfer reference is required as evidence' }]);
  const w = await Withdrawal.findOne({ reference });
  if (!w) throw E.notFound('Withdrawal');
  if (w.status !== 'manual_payout_pending') throw E.invalidState('Withdrawal is not awaiting manual payout confirmation');
  if (String(w.manualEvidence?.initiatedBy) === String(staff._id)) throw E.forbidden('A different staff member must confirm a manual payout (separation of duties)');
  if (String(w.userId) === String(staff._id)) throw E.forbidden('You cannot confirm your own withdrawal');
  const doc = await completeWithdrawal(w, { method: 'manual', by: staff._id, evidence: { bankReference, note } });
  await audit.fromReq(req, { action: 'withdrawal.manual_payout_confirmed', category: 'finance', targetType: 'withdrawal', targetId: reference, metadata: { bankReference } });
  return presentWithdrawal(doc.toObject(), { staff: true });
}

async function manualPayoutFailed(staff, reference, { reason }, req) {
  const w = await Withdrawal.findOne({ reference, status: 'manual_payout_pending' });
  if (!w) throw E.invalidState('Withdrawal is not awaiting manual payout');
  await withTransaction(async (session) => {
    const doc = await Withdrawal.findOneAndUpdate({ _id: w._id, status: 'manual_payout_pending' }, { $set: { status: 'failed', failureReason: reason }, $push: { history: { at: new Date(), status: 'failed', by: staff._id, note: reason } } }, { new: true, session });
    if (!doc) throw E.invalidState('Withdrawal changed concurrently');
    await releaseHold(doc, reason, 'failed', session, staff._id);
    await notifications.notify(w.userId, { category: 'financial', type: 'withdrawal_failed', title: 'Withdrawal could not be completed', body: 'The funds are back in your wallet.', link: '/app/wallet/withdrawals' }, { session });
    await audit.record({ ...audit.ctxFrom(req), actor: staff, action: 'withdrawal.manual_payout_failed', category: 'finance', targetType: 'withdrawal', targetId: reference, reason }, { session });
  });
  return presentWithdrawal((await Withdrawal.findById(w._id)).toObject(), { staff: true });
}

async function sweepPayouts() {
  const due = await Withdrawal.find({ status: { $in: ['payout_processing', 'payout_uncertain'] }, $or: [{ lastCheckedAt: null }, { lastCheckedAt: { $lt: new Date(Date.now() - 5 * 60e3) } }] }).limit(50);
  for (const w of due) {
    // eslint-disable-next-line no-await-in-loop
    await checkPayout(w.reference).catch((err) => logger.error({ err, ref: w.reference }, 'payout check failed'));
  }
  return { checked: due.length };
}

/** Handle Paystack transfer webhooks: always re-verify with the API before acting. */
async function handleTransferEvent(event, data) {
  const payoutRef = data?.reference;
  if (!payoutRef) return { ignored: true };
  const w = await Withdrawal.findOne({ payoutReference: payoutRef });
  if (!w) return { ignored: true, reason: 'unknown_reference' };
  if (event === 'transfer.reversed' && w.status === 'completed') {
    const v = await paystack.verifyTransfer(payoutRef);
    if (v.found && v.status === 'reversed') await reverseCompletedWithdrawal(w, 'Reversed by provider');
    return { handled: true };
  }
  await checkPayout(w.reference);
  return { handled: true };
}

// ---------------------------------------------------------------- history & statements
async function transactions(user, { page = 1, limit = 20, type, from, to }) {
  const accounts = await LedgerAccount.find({ ownerId: user._id, purpose: { $in: ['user_wallet', 'user_hold'] } }, { _id: 1, code: 1, purpose: 1 }).lean();
  const ids = accounts.map((a) => a._id);
  const filter = { accountId: { $in: ids } };
  if (from || to) filter.postedAt = { ...(from ? { $gte: new Date(from) } : {}), ...(to ? { $lte: new Date(to) } : {}) };
  const walletId = accounts.find((a) => a.purpose === 'user_wallet')?._id;
  const entries = await LedgerEntry.find({ ...filter, accountId: walletId }).sort({ postedAt: -1, _id: -1 }).skip((page - 1) * limit).limit(limit).lean();
  const total = await LedgerEntry.countDocuments({ ...filter, accountId: walletId });
  const txs = await LedgerTransaction.find({ _id: { $in: entries.map((e) => e.transactionId) }, ...(type ? { type } : {}) }).lean();
  const txMap = new Map(txs.map((t) => [String(t._id), t]));
  const items = entries.filter((e) => txMap.has(String(e.transactionId))).map((e) => {
    const t = txMap.get(String(e.transactionId));
    return { reference: t.reference, type: t.type, description: t.description, direction: e.direction === 'credit' ? 'in' : 'out', amountKobo: e.amount, balanceAfterKobo: e.balanceAfter, postedAt: e.postedAt, relatedType: t.relatedType, relatedId: t.relatedId };
  });
  return { items, meta: { page, limit, total, pages: Math.ceil(total / limit) } };
}

async function transactionDetail(user, reference) {
  const tx = await LedgerTransaction.findOne({ reference, userIds: user._id }).lean();
  if (!tx) throw E.notFound('Transaction');
  const entries = await LedgerEntry.find({ transactionId: tx._id }).lean();
  const own = entries.filter((e) => e.accountCode.startsWith(`USER:${user._id}:`) || e.accountCode.startsWith('SAVINGS:'));
  return { reference: tx.reference, type: tx.type, description: tx.description, postedAt: tx.postedAt, totalKobo: tx.totalKobo, relatedType: tx.relatedType, relatedId: tx.relatedId, yourEntries: own.map((e) => ({ account: e.accountCode.split(':').slice(-1)[0].toLowerCase(), direction: e.direction, amountKobo: e.amount, balanceAfterKobo: e.balanceAfter })) };
}

async function statementRows(user, { from, to, accountPurpose = 'user_wallet' }) {
  const acc = await LedgerAccount.findOne({ ownerId: user._id, purpose: accountPurpose }).lean();
  if (!acc) return [];
  const filter = { accountId: acc._id, postedAt: { $gte: new Date(from), $lte: new Date(to) } };
  const entries = await LedgerEntry.find(filter).sort({ postedAt: 1, _id: 1 }).limit(10000).lean();
  const txs = await LedgerTransaction.find({ _id: { $in: entries.map((e) => e.transactionId) } }, { reference: 1, type: 1, description: 1 }).lean();
  const m = new Map(txs.map((t) => [String(t._id), t]));
  return entries.map((e) => ({ date: e.postedAt.toISOString(), reference: m.get(String(e.transactionId))?.reference, type: m.get(String(e.transactionId))?.type, description: m.get(String(e.transactionId))?.description, creditKobo: e.direction === 'credit' ? e.amount : 0, debitKobo: e.direction === 'debit' ? e.amount : 0, balanceKobo: e.balanceAfter }));
}

async function listWithdrawals(user, { page = 1, limit = 20 }) {
  const [items, total] = await Promise.all([Withdrawal.find({ userId: user._id }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), Withdrawal.countDocuments({ userId: user._id })]);
  return { items: items.map((w) => presentWithdrawal(w)), meta: { page, limit, total, pages: Math.ceil(total / limit) } };
}

module.exports = {
  overview, initFunding, lookupRecipient, transfer, reviewHeldTransfer, listBanks, addBankAccount, listBankAccounts, removeBankAccount,
  requestWithdrawal, approveWithdrawal, rejectWithdrawal, initiatePayout, checkPayout, markManualPayout, confirmManualPayout, manualPayoutFailed,
  sweepPayouts, handleTransferEvent, transactions, transactionDetail, statementRows, listWithdrawals, presentWithdrawal, requireTier, deterministicRef, completeWithdrawal, failWithdrawal,
};
