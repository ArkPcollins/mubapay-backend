'use strict';
/**
 * Staff / superadmin API. Every route enforces explicit permissions on the
 * backend; viewing permissions never imply change permissions. Thin
 * controllers delegate to domain services, which re-check separation of duties.
 */
const express = require('express');
const { z } = require('zod');
const { asyncHandler: h, validate, ok, created, parsePagination, paginate, escapeRegex } = require('../../lib/http');
const { requireAuth, requirePermission: can, requireAnyPermission } = require('../../middleware/auth');
const { E } = require('../../lib/errors');
const { User } = require('../users/user.model');
const { PERMISSIONS, ADMIN_PRESETS, SUPERADMIN_ONLY } = require('../rbac/permissions');
const audit = require('../audit/audit.service');
const { AuditEvent, Alert } = require('../audit/audit.model');
const settings = require('../settings/settings.service');
const approvals = require('../approvals/approvals');
require('../approvals/approval.actions');
const verification = require('../verification/verification.service');
const wallet = require('../wallet/wallet.service');
const { Withdrawal, Transfer, BankAccount } = require('../wallet/wallet.models');
const { LedgerAccount, LedgerTransaction, LedgerEntry } = require('../ledger/ledger.models');
const recon = require('../reconciliation/reconciliation.service');
const savings = require('../savings/savings.service');
const { SavingsAccount } = require('../savings/savings.models');
const products = require('../marketplace/products.service');
const orders = require('../marketplace/orders.service');
const { Order, DeliveryRequest, RefundRequest, Dispute, SellerSettlement } = require('../marketplace/marketplace.models');
const deliveries = require('../deliveries/deliveries.service');
const refunds = require('../refunds/refunds.service');
const props = require('../realestate/properties.service');
const { ViewingAppointment } = require('../realestate/realestate.models');
const support = require('../support/support.service');
const messaging = require('../messaging/messaging.service');
const notifications = require('../notifications/notifications.service');
const reports = require('../reports/reports.service');
const { LegalDocument } = require('../legal/legal.models');
const infra = require('../../infra');
const health = require('../system/health.service');
const { PaymentAttempt } = require('../payments/payment.models');

const r = express.Router();
const oid = z.string().regex(/^[a-f0-9]{24}$/);
const reason = z.string().min(5).max(1000);
r.use(requireAuth, (req, _res, next) => (req.user.isStaff() ? next() : next(E.forbidden())));

const maskEmail = (e) => (e ? e.replace(/^(.)(.*)(@.*)$/, (_m, a, b, c) => `${a}${'*'.repeat(Math.min(6, b.length))}${c}`) : e);
const maskPhone = (p) => (p ? `${p.slice(0, 4)}****${p.slice(-2)}` : p);
const pg = (q) => ({ page: Math.max(1, Number(q.page) || 1), limit: Math.min(100, Math.max(1, Number(q.limit) || 20)) });

// ---------------------------------------------------------------- overview
r.get('/overview', h(async (req, res) => {
  const counts = {};
  const P = (p) => require('../../middleware/auth').hasPermission(req.user, p);
  if (P('kyc.view')) counts.kycPending = await require('../verification/verification.models').IdentityVerification.countDocuments({ status: 'pending' });
  if (P('withdrawals.view')) counts.withdrawalsPending = await Withdrawal.countDocuments({ status: { $in: ['pending_review', 'approved', 'payout_uncertain', 'manual_payout_pending'] } });
  if (P('listings.moderate')) counts.listingsPending = await require('../marketplace/marketplace.models').Product.countDocuments({ status: 'pending_review' });
  if (P('properties.moderate')) counts.propertiesPending = await require('../realestate/realestate.models').Property.countDocuments({ status: 'pending_review' });
  if (P('refunds.view')) counts.refundsPending = await RefundRequest.countDocuments({ status: 'pending_review' });
  if (P('disputes.manage')) counts.disputesOpen = await Dispute.countDocuments({ status: { $in: ['open', 'under_review'] } });
  if (P('support.view')) counts.ticketsOpen = await support.SupportTicket.countDocuments({ status: { $in: ['open', 'pending_staff'] } });
  if (P('reconciliation.view')) counts.reconciliationOpen = await recon.ReconciliationException.countDocuments({ status: { $in: ['open', 'investigating'] } });
  if (P('risk.review')) counts.transfersHeld = await Transfer.countDocuments({ status: 'held' });
  counts.approvalsPending = await approvals.ApprovalRequest.countDocuments({ status: 'pending' });
  if (P('alerts.manage')) counts.criticalAlerts = await Alert.countDocuments({ status: 'open', severity: 'critical' });
  ok(res, { counts, permissions: req.user.roles.includes('superadmin') ? Object.keys(PERMISSIONS) : req.user.staffPermissions, roles: req.user.roles });
}));

// ---------------------------------------------------------------- users & staff
r.get('/users', can('users.view'), h(async (req, res) => {
  const p = parsePagination(req.query, { allowedSort: ['createdAt', 'email'] });
  const filter = {};
  if (req.query.q) filter.$or = [{ email: new RegExp(escapeRegex(req.query.q), 'i') }, { firstName: new RegExp(escapeRegex(req.query.q), 'i') }, { lastName: new RegExp(escapeRegex(req.query.q), 'i') }];
  if (req.query.role) filter.roles = req.query.role;
  if (req.query.status) filter.status = req.query.status;
  if (req.query.kycStatus) filter.kycStatus = req.query.kycStatus;
  const { items, meta } = await paginate(User, filter, p, { projection: { email: 1, phone: 1, firstName: 1, lastName: 1, roles: 1, status: 1, kycStatus: 1, verificationTier: 1, createdAt: 1, capabilities: 1 } });
  const full = require('../../middleware/auth').hasPermission(req.user, 'users.view_pii');
  if (full) await audit.fromReq(req, { action: 'users.list_pii', category: 'access', sensitiveRead: true, metadata: { q: req.query.q } });
  ok(res, items.map((u) => ({ ...u, email: full ? u.email : maskEmail(u.email), phone: full ? u.phone : maskPhone(u.phone) })), meta);
}));
r.get('/users/:id', can('users.view'), h(async (req, res) => {
  const u = await User.findById(req.params.id).lean();
  if (!u) throw E.notFound('User');
  const full = require('../../middleware/auth').hasPermission(req.user, 'users.view_pii');
  await audit.fromReq(req, { action: 'user.viewed', category: 'access', targetType: 'user', targetId: u._id, sensitiveRead: full });
  const out = { id: String(u._id), email: full ? u.email : maskEmail(u.email), phone: full ? u.phone : maskPhone(u.phone), firstName: u.firstName, lastName: u.lastName, roles: u.roles, capabilities: u.capabilities, status: u.status, restriction: u.restriction, kycStatus: u.kycStatus, verificationTier: u.verificationTier, createdAt: u.createdAt, twoFactorEnabled: u.twoFactor?.enabled, staffPermissions: u.staffPermissions, lastLoginAt: u.security?.lastLoginAt };
  if (require('../../middleware/auth').hasPermission(req.user, 'finance.view')) out.ledgerAccounts = await LedgerAccount.find({ ownerId: u._id }, { code: 1, purpose: 1, balance: 1, status: 1 }).lean();
  if (full) out.addresses = u.addresses;
  ok(res, out);
}));
r.post('/users/:id/restriction', can('users.restrict'), validate(z.object({ action: z.enum(['restrict', 'suspend', 'unrestrict']), reason, scopes: z.array(z.enum(['messaging', 'financial', 'listings'])).optional() })), h(async (req, res) => {
  const target = await User.findById(req.params.id);
  if (!target) throw E.notFound('User');
  if (String(target._id) === String(req.user._id)) throw E.forbidden('You cannot change your own restriction');
  if (target.isStaff() && !req.user.roles.includes('superadmin')) throw E.forbidden('Only superadmins can restrict staff');
  const set = req.body.action === 'unrestrict' ? { status: 'active', restriction: null } : { status: req.body.action === 'suspend' ? 'suspended' : 'restricted', restriction: { reason: req.body.reason, by: req.user._id, at: new Date(), scopes: req.body.scopes || [] } };
  await User.updateOne({ _id: target._id }, { $set: set });
  if (req.body.action === 'suspend') await require('../auth/auth.service').revokeAllSessions(target._id, 'suspended');
  await audit.fromReq(req, { action: `user.${req.body.action}`, category: 'security', targetType: 'user', targetId: target._id, reason: req.body.reason });
  await notifications.notify(target._id, { category: 'account', type: `account_${req.body.action}`, title: req.body.action === 'unrestrict' ? 'Account restrictions removed' : 'Your account has been restricted', body: req.body.action === 'unrestrict' ? 'Your account is fully active again.' : `Reason: ${req.body.reason}. Contact support if you have questions.` });
  ok(res, { status: set.status });
}));
r.get('/staff', can('staff.manage'), h(async (_req, res) => ok(res, await User.find({ roles: { $in: ['admin', 'superadmin'] } }, { email: 1, firstName: 1, lastName: 1, roles: 1, staffPermissions: 1, status: 1, 'twoFactor.enabled': 1, 'security.lastLoginAt': 1 }).lean())));
r.get('/permissions', can('staff.manage'), h(async (_req, res) => ok(res, { permissions: PERMISSIONS, presets: ADMIN_PRESETS, superadminOnly: [...SUPERADMIN_ONLY] })));

// ---------------------------------------------------------------- approvals (dual control)
r.get('/approvals', h(async (req, res) => {
  const out = await approvals.list({ status: req.query.status || 'pending', ...pg(req.query) });
  ok(res, out.items, out.meta);
}));
r.post('/approvals', validate(z.object({ action: z.string(), payload: z.record(z.any()), reason: z.string().min(10).max(2000) })), h(async (req, res) => created(res, await approvals.initiate(req.user, req.body.action, req.body.payload, req.body.reason, req))));
r.post('/approvals/:id/approve', validate(z.object({ note: z.string().max(1000).optional() })), h(async (req, res) => ok(res, await approvals.approve(req.user, req.params.id, req.body.note, req))));
r.post('/approvals/:id/reject', validate(z.object({ note: reason })), h(async (req, res) => ok(res, await approvals.reject(req.user, req.params.id, req.body.note, req))));

// ---------------------------------------------------------------- verification
r.get('/verification/identity', can('kyc.view'), h(async (req, res) => {
  const out = await verification.queue({ status: req.query.status || 'pending', ...pg(req.query) });
  ok(res, out.items, out.meta);
}));
r.post('/verification/identity/:id/review', can('kyc.review'), validate(z.object({ decision: z.enum(['approve', 'reject', 'request_resubmission']), reviewerNotes: z.string().max(2000).optional(), customerMessage: z.string().max(1000).optional() })), h(async (req, res) => ok(res, await verification.reviewIdentity(req.user, req.params.id, req.body, req))));
r.get('/verification/roles', can('roles.review'), h(async (req, res) => {
  const out = await verification.roleQueue({ status: req.query.status || 'pending', ...pg(req.query) });
  ok(res, out.items, out.meta);
}));
r.post('/verification/roles/:id/review', can('roles.review'), validate(z.object({ decision: z.enum(['approve', 'reject', 'request_resubmission']), reviewerNotes: z.string().max(2000).optional(), customerMessage: z.string().max(1000).optional() })), h(async (req, res) => ok(res, await verification.reviewRoleApplication(req.user, req.params.id, req.body, req))));

// ---------------------------------------------------------------- finance
r.get('/finance/accounts', can('finance.view'), h(async (req, res) => {
  const filter = {};
  if (req.query.purpose) filter.purpose = req.query.purpose;
  if (req.query.system === 'true') filter.ownerId = null;
  const p = parsePagination(req.query, { allowedSort: ['createdAt', 'balance'], defaultSort: '-balance' });
  const { items, meta } = await paginate(LedgerAccount, filter, p);
  ok(res, items, meta);
}));
r.get('/finance/accounts/:code/entries', can('finance.view'), h(async (req, res) => {
  const acc = await LedgerAccount.findOne({ code: req.params.code }).lean();
  if (!acc) throw E.notFound('Account');
  const p = parsePagination(req.query, { allowedSort: ['postedAt'], defaultSort: '-postedAt' });
  const { items, meta } = await paginate(LedgerEntry, { accountId: acc._id }, p);
  ok(res, { account: acc, entries: items }, meta);
}));
r.get('/finance/transactions', can('finance.view'), h(async (req, res) => {
  const filter = {};
  if (req.query.reference) filter.reference = new RegExp(`^${escapeRegex(req.query.reference)}`);
  if (req.query.type) filter.type = req.query.type;
  if (req.query.userId) filter.userIds = req.query.userId;
  const p = parsePagination(req.query, { allowedSort: ['postedAt'], defaultSort: '-postedAt' });
  const { items, meta } = await paginate(LedgerTransaction, filter, p);
  ok(res, items, meta);
}));
r.get('/finance/transactions/:reference', can('finance.view'), h(async (req, res) => {
  const tx = await LedgerTransaction.findOne({ reference: req.params.reference }).lean();
  if (!tx) throw E.notFound('Transaction');
  ok(res, { ...tx, entries: await LedgerEntry.find({ transactionId: tx._id }).lean(), reversal: await LedgerTransaction.findOne({ reversalOf: tx._id }).lean() });
}));
r.get('/finance/invariants', can('finance.view'), h(async (_req, res) => ok(res, await require('../ledger/ledger.service').checkInvariants())));
r.get('/finance/payments', can('finance.view'), h(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.reference) filter.reference = req.query.reference;
  const p = parsePagination(req.query);
  const { items, meta } = await paginate(PaymentAttempt, filter, p, { projection: { authorizationUrl: 0, accessCode: 0 } });
  ok(res, items, meta);
}));
r.post('/finance/payments/:reference/verify', can('finance.view'), h(async (req, res) => ok(res, require('../payments/payments.service').present(await require('../payments/payments.service').verifyAndFulfil(req.params.reference, { source: 'staff' })))));
r.get('/finance/transfers', requireAnyPermission('finance.view', 'risk.review'), h(async (req, res) => {
  const p = parsePagination(req.query);
  const { items, meta } = await paginate(Transfer, req.query.status ? { status: req.query.status } : {}, p);
  ok(res, items, meta);
}));
r.post('/finance/transfers/:reference/review', can('risk.review'), validate(z.object({ decision: z.enum(['approve', 'reject']), note: reason })), h(async (req, res) => ok(res, await wallet.reviewHeldTransfer(req.user, req.params.reference, req.body, req))));

// withdrawals
r.get('/withdrawals', can('withdrawals.view'), h(async (req, res) => {
  const p = parsePagination(req.query, { defaultSort: 'createdAt' });
  const { items, meta } = await paginate(Withdrawal, req.query.status ? { status: req.query.status } : {}, p);
  const banks = new Map((await BankAccount.find({ _id: { $in: items.map((w) => w.bankAccountId) } }).lean()).map((b) => [String(b._id), b]));
  ok(res, items.map((w) => {
    const b = banks.get(String(w.bankAccountId));
    return { ...wallet.presentWithdrawal(w, { staff: true }), destination: b ? { bankName: b.bankName, accountName: b.accountName, accountNumberLast4: b.accountNumberLast4, nameMatchStatus: b.nameMatchStatus } : null };
  }), meta);
}));
/** Full destination account number, for a manual bank payout. Audited sensitive read. */
r.get('/withdrawals/:reference/destination', can('withdrawals.payout'), h(async (req, res) => {
  const w = await Withdrawal.findOne({ reference: req.params.reference }).lean();
  if (!w) throw E.notFound('Withdrawal');
  if (!['approved', 'manual_payout_pending', 'payout_uncertain'].includes(w.status)) throw E.invalidState('Destination details are only shown for withdrawals ready for payout');
  const b = await BankAccount.findById(w.bankAccountId).select('+accountNumberEnc').lean();
  if (!b) throw E.notFound('Bank account');
  await audit.fromReq(req, { action: 'withdrawal.destination_viewed', category: 'finance', targetType: 'withdrawal', targetId: w.reference, sensitiveRead: true });
  ok(res, { bankName: b.bankName, bankCode: b.bankCode, accountName: b.accountName, accountNumber: require('../../lib/crypto').decryptString(b.accountNumberEnc), nameMatchStatus: b.nameMatchStatus });
}));
r.post('/withdrawals/:reference/approve', can('withdrawals.approve'), validate(z.object({ note: z.string().max(500).optional() })), h(async (req, res) => ok(res, await wallet.approveWithdrawal(req.user, req.params.reference, req.body, req))));
r.post('/withdrawals/:reference/reject', can('withdrawals.approve'), validate(z.object({ reason })), h(async (req, res) => ok(res, await wallet.rejectWithdrawal(req.user, req.params.reference, req.body, req))));
r.post('/withdrawals/:reference/payout', can('withdrawals.payout'), h(async (req, res) => ok(res, await wallet.initiatePayout(req.user, req.params.reference, req))));
r.post('/withdrawals/:reference/check', can('withdrawals.payout'), h(async (req, res) => ok(res, wallet.presentWithdrawal((await wallet.checkPayout(req.params.reference)).toObject(), { staff: true }))));
r.post('/withdrawals/:reference/manual', can('withdrawals.payout'), validate(z.object({ note: z.string().max(500).optional() })), h(async (req, res) => ok(res, await wallet.markManualPayout(req.user, req.params.reference, req.body, req))));
r.post('/withdrawals/:reference/manual/confirm', can('withdrawals.payout'), validate(z.object({ bankReference: z.string().min(4).max(100), note: z.string().max(500).optional() })), h(async (req, res) => ok(res, await wallet.confirmManualPayout(req.user, req.params.reference, req.body, req))));
r.post('/withdrawals/:reference/manual/failed', can('withdrawals.payout'), validate(z.object({ reason })), h(async (req, res) => ok(res, await wallet.manualPayoutFailed(req.user, req.params.reference, req.body, req))));

// reconciliation
r.get('/reconciliation/runs', can('reconciliation.view'), h(async (_req, res) => ok(res, await recon.ReconciliationRun.find({}).sort({ createdAt: -1 }).limit(100).lean())));
r.get('/reconciliation/exceptions', can('reconciliation.view'), h(async (req, res) => {
  const p = parsePagination(req.query);
  const { items, meta } = await paginate(recon.ReconciliationException, { status: req.query.status || { $in: ['open', 'investigating'] } }, p);
  ok(res, items, meta);
}));
r.post('/reconciliation/run', can('reconciliation.view'), validate(z.object({ type: z.enum(['paystack_payments', 'payouts', 'ledger_invariants', 'pending_sweep']), from: z.string().optional(), to: z.string().optional() })), h(async (req, res) => {
  const fn = { paystack_payments: () => recon.reconcilePaystack({ ...req.body, triggeredBy: req.user._id }), payouts: () => recon.reconcilePayouts({ triggeredBy: req.user._id }), ledger_invariants: () => recon.checkLedger({ triggeredBy: req.user._id }), pending_sweep: () => recon.sweepPendingPayments({ olderThanMs: 0 }) }[req.body.type];
  await audit.fromReq(req, { action: 'reconciliation.run', category: 'finance', metadata: req.body });
  ok(res, await fn());
}));
r.post('/reconciliation/exceptions/:id', can('reconciliation.resolve'), validate(z.object({ status: z.enum(['investigating', 'resolved', 'dismissed']), note: z.string().min(10).max(2000) })), h(async (req, res) => ok(res, await recon.resolveException(req.user, req.params.id, req.body, req))));

// ---------------------------------------------------------------- savings
r.get('/savings/plans', can('savings.view'), h(async (_req, res) => ok(res, await savings.listPlans({ includeRetired: true }))));
const plan = z.object({ name: z.string().min(3).max(80), description: z.string().max(2000).optional(), contributionMode: z.enum(['flexible', 'scheduled']), minDurationDays: z.number().int().positive(), maxDurationDays: z.number().int().positive(), allowedFrequencies: z.array(z.enum(['daily', 'weekly', 'monthly'])).optional(), minContributionKobo: z.number().int().positive().optional(), earlyExit: z.object({ type: z.enum(['none', 'fixed', 'percent']), bp: z.number().int().min(0).optional(), fixedKobo: z.number().int().min(0).optional() }).optional(), status: z.enum(['active', 'retired']).optional() });
r.post('/savings/plans', can('savings.manage_plans'), validate(plan), h(async (req, res) => created(res, await savings.createPlan(req.user, req.body, req))));
r.patch('/savings/plans/:id', can('savings.manage_plans'), validate(plan.partial()), h(async (req, res) => ok(res, await savings.updatePlan(req.user, req.params.id, req.body, req))));
r.get('/savings/accounts', can('savings.view'), h(async (req, res) => {
  const p = parsePagination(req.query);
  const { items, meta } = await paginate(SavingsAccount, req.query.status ? { status: req.query.status } : {}, p);
  ok(res, items, meta);
}));
r.get('/savings/liabilities', can('savings.view'), h(async (_req, res) => ok(res, await savings.liabilitySummary())));

// ---------------------------------------------------------------- catalogue & moderation
const newProduct = z.object({ title: z.string().min(3).max(140), description: z.string().min(10).max(5000), brand: z.string().max(60).optional(), categoryId: oid, priceKobo: z.number().int().min(100), stock: z.number().int().min(0), images: z.array(z.object({ url: z.string().url(), publicId: z.string().optional(), alt: z.string().optional() })).max(10).optional(), weightKg: z.number().min(0.01).optional(), fulfilment: z.object({ delivery: z.boolean().optional(), collection: z.boolean().optional(), collectionPointId: z.string().optional(), originState: z.string().optional(), originCity: z.string().optional(), originAddressCode: z.string().optional() }).optional(), publish: z.boolean().optional(), status: z.enum(['draft', 'published', 'archived', 'hidden']).optional(), promotedUntil: z.string().nullable().optional() });
r.post('/products', can('products.manage'), validate(newProduct), h(async (req, res) => created(res, await products.createNewProduct(req.user, req.body, req))));
r.patch('/products/:id', can('products.manage'), validate(newProduct.partial()), h(async (req, res) => ok(res, await products.updateNewProduct(req.user, req.params.id, req.body, req))));
r.get('/products', requireAnyPermission('products.manage', 'listings.moderate'), h(async (req, res) => {
  const p = parsePagination(req.query, { allowedSort: ['createdAt', 'updatedAt', 'priceKobo'] });
  const filter = {};
  if (req.query.kind) filter.kind = req.query.kind;
  if (req.query.status) filter.status = req.query.status;
  const { items, meta } = await paginate(require('../marketplace/marketplace.models').Product, filter, p);
  ok(res, items, meta);
}));
r.get('/categories', can('categories.manage'), h(async (_req, res) => ok(res, await products.listCategories({ includeInactive: true }))));
const category = z.object({ name: z.string().min(2).max(80), slug: z.string().max(80).optional(), parentId: oid.optional(), allowsUsed: z.boolean().optional(), allowsNew: z.boolean().optional(), prohibited: z.boolean().optional(), prohibitedReason: z.string().max(300).optional(), active: z.boolean().optional(), sortOrder: z.number().int().optional(), shipbubbleCategoryId: z.number().int().optional() });
r.post('/categories', can('categories.manage'), validate(category), h(async (req, res) => created(res, await products.upsertCategory(req.user, req.body, null, req))));
r.patch('/categories/:id', can('categories.manage'), validate(category.partial()), h(async (req, res) => ok(res, await products.upsertCategory(req.user, req.body, req.params.id, req))));
r.get('/moderation/products', can('listings.moderate'), h(async (req, res) => {
  const out = await products.moderationQueue({ status: req.query.status || 'pending_review', ...pg(req.query) });
  ok(res, out.items, out.meta);
}));
r.post('/moderation/products/:id', can('listings.moderate'), validate(z.object({ decision: z.enum(['approve', 'reject', 'hide', 'unhide']), reason: z.string().max(1000).optional() })), h(async (req, res) => ok(res, await products.moderate(req.user, req.params.id, req.body, req))));
r.get('/moderation/properties', can('properties.moderate'), h(async (req, res) => ok(res, await props.moderationQueue({ status: req.query.status || 'pending_review' }))));
r.post('/moderation/properties/:id', can('properties.moderate'), validate(z.object({ decision: z.enum(['approve', 'reject', 'hide', 'unhide']), reason: z.string().max(1000).optional(), authorityVerified: z.boolean().optional() })), h(async (req, res) => ok(res, await props.moderate(req.user, req.params.id, req.body, req))));
r.get('/moderation/users', can('messaging.moderate'), h(async (req, res) => ok(res, await messaging.reportQueue({ status: req.query.status || 'open' }))));
r.post('/moderation/users/:id', can('messaging.moderate'), validate(z.object({ action: z.enum(['dismiss', 'warn', 'restrict_messaging', 'hide_message']), note: reason })), h(async (req, res) => ok(res, await messaging.moderateReport(req.user, req.params.id, req.body, req))));

// ---------------------------------------------------------------- orders, deliveries, refunds, disputes, settlements
r.get('/orders', can('orders.view'), h(async (req, res) => {
  const filter = {};
  if (req.query.status) filter.status = req.query.status;
  if (req.query.sellerKind) filter.sellerKind = req.query.sellerKind;
  if (req.query.orderNumber) filter.orderNumber = req.query.orderNumber;
  const p = parsePagination(req.query);
  const { items, meta } = await paginate(Order, filter, p, { projection: { 'pickup.codeHash': 0, 'pickup.qrTokenHash': 0 } });
  ok(res, items, meta);
}));
r.get('/deliveries', can('deliveries.manage'), h(async (req, res) => {
  const p = parsePagination(req.query);
  const { items, meta } = await paginate(DeliveryRequest, req.query.status ? { status: req.query.status } : {}, p);
  ok(res, items, meta);
}));
r.get('/deliveries/providers', can('deliveries.manage'), h(async (_req, res) => ok(res, deliveries.providerStatus())));
r.get('/deliveries/:id/timeline', can('deliveries.manage'), h(async (req, res) => ok(res, await deliveries.timeline(req.params.id))));
r.post('/deliveries/:id/status', can('deliveries.manage'), validate(z.object({ status: z.enum(['booked', 'in_transit', 'delivered', 'failed', 'redelivery_scheduled', 'cancelled']), note: z.string().max(500).optional(), evidenceRef: z.string().max(300).optional() })), h(async (req, res) => ok(res, await deliveries.manualUpdate(req.user, req.params.id, req.body, req))));
r.post('/deliveries/:id/book', can('deliveries.manage'), h(async (req, res) => ok(res, await deliveries.book(req.params.id))));
r.get('/refunds', can('refunds.view'), h(async (req, res) => {
  const p = parsePagination(req.query, { defaultSort: 'createdAt' });
  const { items, meta } = await paginate(RefundRequest, { status: req.query.status || 'pending_review' }, p);
  ok(res, items, meta);
}));
r.post('/refunds/:id/decision', can('refunds.decide'), validate(z.object({ decision: z.enum(['approve', 'reject']), note: reason, amountKobo: z.number().int().positive().optional() })), h(async (req, res) => ok(res, await refunds.decide(req.user, req.params.id, req.body, req))));
r.get('/disputes', can('disputes.manage'), h(async (req, res) => {
  const p = parsePagination(req.query, { defaultSort: 'createdAt' });
  const { items, meta } = await paginate(Dispute, { status: req.query.status || { $in: ['open', 'under_review'] } }, p);
  ok(res, items, meta);
}));
r.post('/disputes/:id/resolve', can('disputes.manage'), validate(z.object({ outcome: z.enum(['resolved_for_customer', 'resolved_for_provider', 'under_review']), note: z.string().max(2000).optional(), refundKobo: z.number().int().min(0).optional() })), h(async (req, res) => ok(res, await refunds.resolveDispute(req.user, req.params.id, req.body, req))));
r.get('/settlements', can('settlements.view'), h(async (req, res) => {
  const p = parsePagination(req.query);
  const { items, meta } = await paginate(SellerSettlement, req.query.status ? { status: req.query.status } : {}, p);
  ok(res, items, meta);
}));
r.post('/settlements/:id/release', can('settlements.release'), h(async (req, res) => ok(res, await orders.releaseSettlement(req.params.id, { by: req.user, req }))));
r.post('/settlements/:id/hold', can('settlements.release'), validate(z.object({ reason })), h(async (req, res) => {
  const s = await SellerSettlement.findOneAndUpdate({ _id: req.params.id, status: 'pending_release' }, { $set: { status: 'on_hold', holdReason: req.body.reason } }, { new: true });
  if (!s) throw E.invalidState('Settlement is not pending release');
  await audit.fromReq(req, { action: 'settlement.held', category: 'finance', targetType: 'seller_settlement', targetId: s.reference, reason: req.body.reason });
  ok(res, s);
}));
r.get('/appointments', can('appointments.view'), h(async (req, res) => {
  const p = parsePagination(req.query, { allowedSort: ['createdAt', 'scheduledAt'] });
  const { items, meta } = await paginate(ViewingAppointment, req.query.status ? { status: req.query.status } : {}, p);
  ok(res, items, meta);
}));

// ---------------------------------------------------------------- support
r.get('/support/tickets', can('support.view'), h(async (req, res) => {
  const out = await support.staffQueue(req.user, req.query);
  ok(res, out.items, out.meta);
}));
r.post('/support/tickets/:id/assign', can('support.manage'), validate(z.object({ assigneeId: oid })), h(async (req, res) => ok(res, await support.assign(req.user, req.params.id, req.body.assigneeId, req))));
r.post('/notifications/send', can('notifications.manage'), validate(z.object({ userId: oid, title: z.string().min(3).max(200), body: z.string().max(2000), category: z.enum(['account', 'system', 'support']) })), h(async (req, res) => {
  const n = await notifications.notify(req.body.userId, { category: req.body.category, type: 'staff_message', title: req.body.title, body: req.body.body });
  await audit.fromReq(req, { action: 'notification.sent', category: 'support', targetType: 'user', targetId: req.body.userId });
  created(res, n);
}));

// ---------------------------------------------------------------- reports
r.get('/reports/financial', can('reports.view'), h(async (req, res) => ok(res, await reports.financialSummary(req.query))));
r.get('/reports/operational', can('reports.view'), h(async (req, res) => ok(res, await reports.operationalSummary(req.query))));
r.get('/reports/drilldown', can('reports.view'), h(async (req, res) => ok(res, await reports.drilldown(req.query))));
r.get('/reports/export/:type/:format', can('reports.export'), h(async (req, res) => {
  const f = await reports.exportReport(req.user, req.params.type, req.params.format, req.query, req);
  res.set({ 'Content-Type': f.contentType, 'Content-Disposition': `attachment; filename="${f.filename}"`, 'Cache-Control': 'no-store' });
  res.send(f.body);
}));
r.get('/reports/runs', can('reports.view'), h(async (_req, res) => ok(res, await reports.listRuns())));
r.get('/reports/runs/:id', can('reports.view'), h(async (req, res) => ok(res, await reports.getRun(req.params.id))));

// ---------------------------------------------------------------- audit & alerts
r.get('/audit', can('audit.view'), h(async (req, res) => {
  const filter = {};
  for (const k of ['category', 'action', 'targetType', 'targetId', 'outcome']) if (req.query[k]) filter[k] = req.query[k];
  if (req.query.actorId) filter.actorId = req.query.actorId;
  if (req.query.sensitiveRead) filter.sensitiveRead = req.query.sensitiveRead === 'true';
  if (req.query.from || req.query.to) filter.at = { ...(req.query.from ? { $gte: new Date(req.query.from) } : {}), ...(req.query.to ? { $lte: new Date(req.query.to) } : {}) };
  const p = parsePagination(req.query, { allowedSort: ['at'], defaultSort: '-at', maxLimit: 200 });
  const { items, meta } = await paginate(AuditEvent, filter, p);
  await audit.fromReq(req, { action: 'audit.viewed', category: 'access', sensitiveRead: true, metadata: filter });
  ok(res, items, meta);
}));
r.get('/alerts', requireAnyPermission('alerts.manage', 'system.health'), h(async (req, res) => ok(res, await Alert.find({ status: req.query.status || 'open' }).sort({ severity: 1, createdAt: -1 }).limit(200).lean())));
r.post('/alerts/:id/:action', can('alerts.manage'), validate(z.object({ note: z.string().max(500).optional() })), h(async (req, res) => {
  if (!['acknowledge', 'resolve'].includes(req.params.action)) throw E.badRequest('Invalid action');
  const status = req.params.action === 'acknowledge' ? 'acknowledged' : 'resolved';
  // Acknowledging never erases history: the alert and its history remain queryable.
  const a = await Alert.findByIdAndUpdate(req.params.id, { $set: { status }, $push: { history: { at: new Date(), by: req.user._id, action: status, note: req.body.note } } }, { new: true });
  if (!a) throw E.notFound('Alert');
  await audit.fromReq(req, { action: `alert.${status}`, category: 'operations', targetType: 'alert', targetId: a._id, reason: req.body.note });
  ok(res, a);
}));

// ---------------------------------------------------------------- settings, flags, legal
r.get('/settings', can('settings.view'), h(async (_req, res) => ok(res, await settings.getAll())));
r.get('/settings/:key/history', can('settings.view'), h(async (req, res) => ok(res, await settings.history(req.params.key))));
r.patch('/settings/:key', can('settings.manage'), validate(z.object({ value: z.record(z.any()), reason })), h(async (req, res) => ok(res, await settings.update(req.params.key, req.body.value, { actor: req.user, reason: req.body.reason, req }))));
r.get('/flags', can('settings.view'), h(async (_req, res) => ok(res, Object.values(await settings.listFlags()))));
r.put('/flags/:key', can('flags.manage'), validate(z.object({ enabled: z.boolean(), reason })), h(async (req, res) => ok(res, await settings.setFlag(req.params.key, req.body.enabled, { actor: req.user, reason: req.body.reason, req }))));
r.post('/maintenance', can('system.maintenance'), validate(z.object({ enabled: z.boolean(), message: z.string().max(300).optional(), reason })), h(async (req, res) => ok(res, await settings.update('maintenance', { enabled: req.body.enabled, ...(req.body.message ? { message: req.body.message } : {}) }, { actor: req.user, reason: req.body.reason, req }))));
r.get('/legal', can('legal.manage'), h(async (_req, res) => ok(res, await LegalDocument.find({}, { content: 0 }).sort({ slug: 1, version: -1 }).lean())));
r.post('/legal', can('legal.manage'), validate(z.object({ slug: z.string(), title: z.string().min(3).max(200), content: z.string().min(50), summaryOfChanges: z.string().max(1000).optional(), material: z.boolean().optional() })), h(async (req, res) => {
  const last = await LegalDocument.findOne({ slug: req.body.slug }).sort({ version: -1 }).lean();
  const doc = await LegalDocument.create({ ...req.body, version: (last?.version || 0) + 1, status: 'draft' });
  await audit.fromReq(req, { action: 'legal.draft_created', category: 'config', targetType: 'legal_document', targetId: `${doc.slug}@${doc.version}` });
  created(res, doc);
}));
r.post('/legal/:id/publish', can('legal.manage'), validate(z.object({ reviewedByProfessional: z.boolean(), effectiveAt: z.string().optional() })), h(async (req, res) => {
  const doc = await LegalDocument.findById(req.params.id);
  if (!doc || doc.status !== 'draft') throw E.invalidState('Only drafts can be published');
  await LegalDocument.updateMany({ slug: doc.slug, status: 'published' }, { $set: { status: 'superseded' } });
  doc.status = 'published';
  doc.publishedAt = new Date();
  doc.publishedBy = req.user._id;
  doc.reviewedByProfessional = req.body.reviewedByProfessional;
  doc.effectiveAt = req.body.effectiveAt ? new Date(req.body.effectiveAt) : new Date();
  await doc.save();
  await audit.fromReq(req, { action: 'legal.published', category: 'config', targetType: 'legal_document', targetId: `${doc.slug}@${doc.version}`, metadata: { material: doc.material, reviewedByProfessional: doc.reviewedByProfessional } });
  if (doc.material) await audit.raiseAlert({ severity: 'info', type: 'legal.material_change', message: `${doc.title} v${doc.version} published — users will be asked to re-accept`, refType: 'legal_document', refId: doc._id });
  ok(res, doc);
}));

// ---------------------------------------------------------------- system
r.get('/system/health', can('system.health'), h(async (_req, res) => ok(res, await health.detailed())));
r.get('/system/jobs', can('system.health'), h(async (req, res) => ok(res, { stats: await infra.queue.stats(), jobs: await infra.queue.listJobs({ status: req.query.status || 'failed', limit: 50 }) })));
r.post('/system/jobs/:id/retry', can('system.health'), h(async (req, res) => {
  const okRetry = await infra.queue.retryJob(req.params.id);
  await audit.fromReq(req, { action: 'job.retried', category: 'operations', targetType: 'job', targetId: req.params.id });
  ok(res, { retried: okRetry });
}));
r.get('/system/integrations', requireAnyPermission('system.health', 'settings.view'), h(async (_req, res) => ok(res, health.integrations())));

module.exports = r;
