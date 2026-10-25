'use strict';
/**
 * Privacy controls. Distinguishes four different things:
 *  - account RESTRICTION (staff action; account kept, features limited)
 *  - account CLOSURE (customer request; blocked while obligations remain)
 *  - data ANONYMISATION (on closure: direct identifiers removed/replaced)
 *  - legally required RETENTION (financial, fraud and dispute records kept
 *    for the retention period even after closure — never deleted here)
 */
const { User } = require('../users/user.model');
const { Session } = require('../auth/auth.models');
const { LedgerAccount, LedgerTransaction } = require('../ledger/ledger.models');
const { Withdrawal, BankAccount } = require('../wallet/wallet.models');
const { SavingsAccount } = require('../savings/savings.models');
const { Order, Dispute, RefundRequest, Product, Cart, SavedProduct, SavedSearch } = require('../marketplace/marketplace.models');
const { ViewingAppointment, Property, SavedProperty } = require('../realestate/realestate.models');
const { Notification } = require('../notifications/notification.model');
const { ConsentRecord } = require('../legal/legal.models');
const { IdentityVerification } = require('../verification/verification.models');
const { SupportTicket } = require('../support/support.service');
const { SavedCard } = require('../payments/payment.models');
const audit = require('../audit/audit.service');
const consent = require('../legal/consent.service');
const authService = require('../auth/auth.service');
const wallet = require('../wallet/wallet.service');
const { withTransaction } = require('../../lib/db');
const { E } = require('../../lib/errors');
const { koboToNairaString } = require('../../lib/money');

async function closureBlockers(user) {
  const blockers = [];
  const accounts = await LedgerAccount.find({ ownerId: user._id }).lean();
  const bal = (p) => accounts.filter((a) => a.purpose === p).reduce((s, a) => s + a.balance, 0);
  if (bal('user_wallet') !== 0) blockers.push({ code: 'wallet_balance', message: `Your wallet holds ${koboToNairaString(bal('user_wallet'))}. Withdraw or spend it first.` });
  if (bal('user_hold') !== 0) blockers.push({ code: 'reserved_funds', message: 'You have funds reserved for a withdrawal in progress.' });
  if (bal('user_seller_payable') !== 0) blockers.push({ code: 'seller_proceeds', message: 'You have sale proceeds awaiting release.' });
  if (await SavingsAccount.exists({ userId: user._id, status: { $in: ['active', 'paused'] } })) blockers.push({ code: 'active_savings', message: 'You have active savings plans. Wait for maturity or close them first.' });
  if (await Withdrawal.exists({ userId: user._id, status: { $in: ['pending_review', 'approved', 'payout_processing', 'payout_uncertain', 'manual_payout_pending'] } })) blockers.push({ code: 'pending_withdrawals', message: 'A withdrawal is still being processed.' });
  if (await Dispute.exists({ $or: [{ raisedBy: user._id }, { counterpartyId: user._id }], status: { $in: ['open', 'under_review'] } })) blockers.push({ code: 'open_disputes', message: 'You have open disputes.' });
  if (await RefundRequest.exists({ requesterId: user._id, status: { $in: ['pending_review', 'approved', 'processing'] } })) blockers.push({ code: 'open_refunds', message: 'You have refund requests in progress.' });
  const unsettled = ['pending_payment', 'payment_processing', 'paid', 'processing', 'ready_for_collection', 'ready_for_dispatch', 'dispatched', 'delivered', 'collected', 'refund_requested', 'partially_refunded', 'disputed', 'settlement_pending', 'delivery_failed'];
  if (await Order.exists({ $or: [{ buyerId: user._id }, { sellerId: user._id }], status: { $in: unsettled } })) blockers.push({ code: 'unsettled_orders', message: 'You have orders that are not yet completed and settled.' });
  if (await ViewingAppointment.exists({ $or: [{ customerId: user._id }, { providerId: user._id }], status: { $in: ['requested', 'proposed', 'awaiting_payment', 'confirmed', 'disputed'] } })) blockers.push({ code: 'active_viewings', message: 'You have upcoming or disputed viewings.' });
  if (user.isStaff()) blockers.push({ code: 'staff_account', message: 'Staff accounts must be deactivated by a superadmin.' });
  return blockers;
}

async function closeAccount(user, { password, confirm }, req) {
  if (confirm !== 'CLOSE MY ACCOUNT') throw E.validation([{ path: 'confirm', message: 'Type CLOSE MY ACCOUNT to confirm' }]);
  const blockers = await closureBlockers(user);
  if (blockers.length) throw E.conflict('Your account cannot be closed yet', 'CLOSURE_BLOCKED', { blockers });
  const argon2 = require('argon2');
  const full = await User.findById(user._id).select('+passwordHash');
  if (full.passwordHash && !(await argon2.verify(full.passwordHash, String(password || '')).catch(() => false))) throw E.unauthorized('Password is incorrect');
  await withTransaction(async (session) => {
    const anonEmail = `closed+${user._id}@closed.invalid`;
    await User.updateOne({ _id: user._id }, {
      $set: { status: 'closed', closedAt: new Date(), anonymizedAt: new Date(), email: anonEmail, firstName: 'Closed', lastName: 'Account', phone: null, phoneVerifiedAt: null, googleId: null, passwordHash: null, addresses: [], 'preferences.marketingEmail': false, 'twoFactor.enabled': false, 'twoFactor.secretEnc': null },
    }, { session });
    await Product.updateMany({ sellerId: user._id, status: { $in: ['published', 'pending_review', 'draft'] } }, { $set: { status: 'archived' } }, { session });
    await Property.updateMany({ 'managers.userId': user._id, 'managers.role': 'owner', status: { $in: ['published', 'pending_review', 'draft'] } }, { $set: { status: 'archived' } }, { session });
    await Cart.deleteMany({ userId: user._id }, { session });
    await SavedProduct.deleteMany({ userId: user._id }, { session });
    await SavedProperty.deleteMany({ userId: user._id }, { session });
    await SavedSearch.deleteMany({ userId: user._id }, { session });
    await SavedCard.updateMany({ userId: user._id }, { $set: { status: 'removed' } }, { session });
    await BankAccount.updateMany({ userId: user._id }, { $set: { status: 'removed' } }, { session });
    await LedgerAccount.updateMany({ ownerId: user._id }, { $set: { status: 'closed' } }, { session });
    await audit.record({ ...audit.ctxFrom(req), actor: user, action: 'account.closed', category: 'privacy', targetType: 'user', targetId: user._id, metadata: { retention: 'Financial, KYC, fraud and dispute records retained per legal retention schedule' } }, { session });
  });
  await authService.revokeAllSessions(user._id, 'account_closed');
  return { closed: true, retention: 'We keep records we are legally required to retain (financial transactions, identity verification, fraud and dispute records) for the retention period. Everything else has been removed or anonymised.' };
}

/** Machine-readable export of the user's personal data (JSON). */
async function exportData(user, req) {
  const id = user._id;
  const [profile, consents, orders, appts, savings, withdrawals, tickets, notifications, kyc, txs, banks, sessions] = await Promise.all([
    User.findById(id).lean(),
    ConsentRecord.find({ userId: id }).lean(),
    Order.find({ $or: [{ buyerId: id }, { sellerId: id }] }).lean(),
    ViewingAppointment.find({ $or: [{ customerId: id }, { providerId: id }] }).lean(),
    SavingsAccount.find({ userId: id }).lean(),
    Withdrawal.find({ userId: id }).lean(),
    SupportTicket.find({ userId: id }).lean(),
    Notification.find({ userId: id }, { 'email.to': 0 }).limit(2000).lean(),
    IdentityVerification.find({ userId: id }).lean(),
    LedgerTransaction.find({ userIds: id }).limit(20000).lean(),
    BankAccount.find({ userId: id }).lean(),
    Session.find({ userId: id }, { tokenHash: 0, replacedByHash: 0 }).lean(),
  ]);
  delete profile.passwordHash;
  delete profile.twoFactor;
  delete profile.security;
  await audit.fromReq(req, { action: 'privacy.data_export', category: 'privacy', targetType: 'user', targetId: id, sensitiveRead: true });
  return {
    generatedAt: new Date().toISOString(),
    note: 'Identity document images are not included in this export; request them from support. Amounts are in kobo (₦1 = 100 kobo).',
    profile, consents, orders, viewingAppointments: appts, savings, withdrawals, supportTickets: tickets, notifications,
    identityVerification: kyc.map((k) => ({ id: k._id, status: k.status, idType: k.idType, idNumberLast4: k.idNumberLast4, createdAt: k.createdAt })),
    ledgerTransactions: txs.map((t) => ({ reference: t.reference, type: t.type, description: t.description, totalKobo: t.totalKobo, postedAt: t.postedAt })),
    bankAccounts: banks.map((b) => ({ bankName: b.bankName, last4: b.accountNumberLast4, accountName: b.accountName, status: b.status })),
    sessions,
  };
}

async function updatePreferences(user, { theme, language, notifications, marketingEmail, shareContactWithProviders }, req) {
  const set = {};
  if (theme) set['preferences.theme'] = theme;
  if (language) set['preferences.language'] = language;
  if (shareContactWithProviders !== undefined) set['privacy.shareContactWithProviders'] = Boolean(shareContactWithProviders);
  if (notifications) {
    const mandatory = ['security', 'financial'];
    for (const [cat, pref] of Object.entries(notifications)) {
      if (mandatory.includes(cat)) continue; // cannot be disabled
      set[`preferences.notifications.${cat}`] = { email: pref.email !== false, inApp: pref.inApp !== false };
    }
  }
  if (marketingEmail !== undefined && Boolean(marketingEmail) !== Boolean(user.preferences?.marketingEmail)) {
    set['preferences.marketingEmail'] = Boolean(marketingEmail);
    set['preferences.marketingUpdatedAt'] = new Date();
    await consent.recordMarketing(user._id, Boolean(marketingEmail), { ip: req.ip, userAgent: req.get('user-agent') });
  }
  await User.updateOne({ _id: user._id }, { $set: set });
  return (await User.findById(user._id)).toSelf();
}

/** One-click unsubscribe from marketing (signed link). */
async function unsubscribe(token) {
  const crypto = require('crypto');
  const config = require('../../config');
  const [uid, sig] = String(token || '').split('.');
  const expected = crypto.createHmac('sha256', config.encryptionKey).update(`unsub:${uid}`).digest('base64url');
  if (!uid || !sig || !require('../../lib/crypto').safeEqual(sig, expected)) throw E.badRequest('Invalid unsubscribe link');
  await User.updateOne({ _id: uid }, { $set: { 'preferences.marketingEmail': false, 'preferences.marketingUpdatedAt': new Date() } });
  await consent.recordMarketing(uid, false, { userAgent: 'unsubscribe-link' });
  return { unsubscribed: true };
}

function unsubscribeToken(userId) {
  const crypto = require('crypto');
  const config = require('../../config');
  return `${userId}.${crypto.createHmac('sha256', config.encryptionKey).update(`unsub:${userId}`).digest('base64url')}`;
}

module.exports = { closureBlockers, closeAccount, exportData, updatePreferences, unsubscribe, unsubscribeToken, wallet };
