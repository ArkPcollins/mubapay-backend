'use strict';
/**
 * Registered dual-approval actions. Staff can NEVER edit balances directly:
 * corrections are compensating ledger transactions executed only here.
 */
const { z } = require('zod');
const { defineAction } = require('./approvals');
const ledger = require('../ledger/ledger.service');
const { LedgerTransaction } = require('../ledger/ledger.models');
const { User } = require('../users/user.model');
const settings = require('../settings/settings.service');
const authService = require('../auth/auth.service');
const notifications = require('../notifications/notifications.service');
const { ALL_PERMISSIONS, SUPERADMIN_ONLY } = require('../rbac/permissions');
const { E } = require('../../lib/errors');
const { koboToNairaString } = require('../../lib/money');

const zParse = (schema, payload) => {
  const r = schema.safeParse(payload);
  if (!r.success) throw E.validation(r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  return r.data;
};

// 1) Wallet correction against the corrections account (credit or debit a user wallet)
defineAction('ledger.wallet_adjustment', {
  initiatorPermission: 'finance.adjust.initiate',
  approverPermission: 'finance.adjust.approve',
  requiredApprovals: 1, // + initiator = two people
  targetType: 'user',
  async validate(payload) {
    const p = zParse(z.object({ userId: z.string().regex(/^[a-f0-9]{24}$/), direction: z.enum(['credit', 'debit']), amountKobo: z.number().int().positive(), relatedReference: z.string().min(3) }), payload);
    const tx = await LedgerTransaction.findOne({ reference: p.relatedReference }).lean();
    if (!tx) throw E.validation([{ path: 'relatedReference', message: 'Referenced ledger transaction not found' }]);
    if (!(await User.exists({ _id: p.userId }))) throw E.notFound('User');
    return p;
  },
  summarize: (p) => `${p.direction === 'credit' ? 'Credit' : 'Debit'} ${koboToNairaString(p.amountKobo)} ${p.direction === 'credit' ? 'to' : 'from'} user ${p.userId} (re ${p.relatedReference})`,
  async execute(p, ctx, session) {
    await ledger.ensureUserAccounts(p.userId);
    const wallet = ledger.userCodes(p.userId).wallet;
    const entries = p.direction === 'credit'
      ? [{ account: ledger.SYS.CORRECTIONS, direction: 'debit', amount: p.amountKobo }, { account: wallet, direction: 'credit', amount: p.amountKobo }]
      : [{ account: wallet, direction: 'debit', amount: p.amountKobo }, { account: ledger.SYS.CORRECTIONS, direction: 'credit', amount: p.amountKobo }];
    const tx = await ledger.post({ reference: `ADJ-${ctx.request._id}`, type: 'adjustment', description: `Approved correction: ${ctx.request.reason}`, entries, initiatedBy: ctx.initiatedBy, approvedBy: ctx.approvers, relatedType: 'ledger_transaction', relatedId: p.relatedReference, metadata: { approvalId: String(ctx.request._id) } }, session);
    await notifications.notify(p.userId, { category: 'financial', type: 'wallet_adjustment', title: 'Wallet adjustment', body: `An approved correction of ${koboToNairaString(p.amountKobo)} was ${p.direction === 'credit' ? 'credited to' : 'debited from'} your wallet. Reference ${tx.reference}.`, link: '/app/wallet' }, { session });
    return { ledgerReference: tx.reference };
  },
});

// 2) Full reversal of a posted ledger transaction
defineAction('ledger.reversal', {
  initiatorPermission: 'finance.adjust.initiate',
  approverPermission: 'finance.adjust.approve',
  requiredApprovals: 1,
  targetType: 'ledger_transaction',
  async validate(payload) {
    const p = zParse(z.object({ reference: z.string().min(3) }), payload);
    const tx = await LedgerTransaction.findOne({ reference: p.reference }).lean();
    if (!tx) throw E.notFound('Ledger transaction');
    if (await LedgerTransaction.exists({ reversalOf: tx._id })) throw E.conflict('Already reversed');
    return { ...p, targetId: String(tx._id) };
  },
  summarize: (p) => `Reverse ledger transaction ${p.reference}`,
  async execute(p, ctx, session) {
    const tx = await LedgerTransaction.findOne({ reference: p.reference }).session(session);
    const rev = await ledger.reverse(tx._id, { reason: ctx.request.reason, initiatedBy: ctx.initiatedBy, approvedBy: ctx.approvers }, session);
    return { reversalReference: rev.reference };
  },
});

// 3) Compliance authorisation (enables custody features in production)
defineAction('settings.compliance', {
  initiatorPermission: 'settings.manage',
  approverPermission: 'settings.manage',
  requiredApprovals: 1,
  targetType: 'setting',
  async validate(payload) {
    return zParse(z.object({ walletOperationsAuthorized: z.boolean().optional(), savingsAuthorized: z.boolean().optional(), settlementHoldingAuthorized: z.boolean().optional(), authorizationReference: z.string().min(3).nullable().optional() }), payload);
  },
  summarize: (p) => `Change compliance authorisation: ${JSON.stringify(p)}`,
  async execute(p, ctx) {
    const approver = await User.findById(ctx.approvers[ctx.approvers.length - 1]);
    const r = await settings.update('compliance', p, { actor: approver, reason: `Dual-approved: ${ctx.request.reason}`, req: ctx.req, bypassDualApproval: true });
    return { version: r.version };
  },
});

// 4) Staff permission changes / promotion to admin (critical security change)
defineAction('staff.set_permissions', {
  initiatorPermission: 'staff.manage',
  approverPermission: 'staff.manage',
  requiredApprovals: 1,
  targetType: 'user',
  async validate(payload, actor) {
    const p = zParse(z.object({ userId: z.string().regex(/^[a-f0-9]{24}$/), makeAdmin: z.boolean().default(true), permissions: z.array(z.string()) }), payload);
    const bad = p.permissions.filter((x) => !ALL_PERMISSIONS.includes(x) || SUPERADMIN_ONLY.has(x));
    if (bad.length) throw E.validation([{ path: 'permissions', message: `Not assignable to admins: ${bad.join(', ')}` }]);
    if (String(p.userId) === String(actor._id)) throw E.forbidden('You cannot change your own permissions');
    const u = await User.findById(p.userId);
    if (!u) throw E.notFound('User');
    if (u.roles.includes('superadmin')) throw E.forbidden('Superadmin permissions cannot be edited here');
    return p;
  },
  summarize: (p) => `Set admin permissions for ${p.userId}: ${p.permissions.join(', ') || '(none)'}`,
  async execute(p, ctx, session) {
    const u = await User.findById(p.userId).session(session);
    const roles = new Set(u.roles);
    if (p.makeAdmin) roles.add('admin');
    else roles.delete('admin');
    u.roles = [...roles];
    u.staffPermissions = p.makeAdmin ? p.permissions : [];
    await u.save({ session });
    await authService.revokeAllSessions(u._id, 'permissions_changed');
    return { roles: u.roles, permissions: u.staffPermissions };
  },
});

// 5) Promote to superadmin
defineAction('staff.grant_superadmin', {
  initiatorPermission: 'staff.manage',
  approverPermission: 'staff.manage',
  requiredApprovals: 1,
  targetType: 'user',
  async validate(payload, actor) {
    const p = zParse(z.object({ userId: z.string().regex(/^[a-f0-9]{24}$/), grant: z.boolean() }), payload);
    if (String(p.userId) === String(actor._id)) throw E.forbidden('You cannot change your own role');
    return p;
  },
  summarize: (p) => `${p.grant ? 'Grant' : 'Revoke'} superadmin for ${p.userId}`,
  async execute(p, _ctx, session) {
    const u = await User.findById(p.userId).session(session);
    if (!u) throw E.notFound('User');
    const roles = new Set(u.roles);
    if (p.grant) roles.add('superadmin');
    else {
      const remaining = await User.countDocuments({ roles: 'superadmin', _id: { $ne: u._id }, status: 'active' }).session(session);
      if (remaining < 1) throw E.conflict('At least one active superadmin must remain');
      roles.delete('superadmin');
    }
    u.roles = [...roles];
    await u.save({ session });
    await authService.revokeAllSessions(u._id, 'role_changed');
    return { roles: u.roles };
  },
});

// 6) Reset a staff member's 2FA (lost device)
defineAction('security.reset_staff_2fa', {
  initiatorPermission: 'staff.manage',
  approverPermission: 'staff.manage',
  requiredApprovals: 1,
  targetType: 'user',
  async validate(payload, actor) {
    const p = zParse(z.object({ userId: z.string().regex(/^[a-f0-9]{24}$/) }), payload);
    if (String(p.userId) === String(actor._id)) throw E.forbidden('You cannot reset your own 2FA');
    return p;
  },
  summarize: (p) => `Reset two-factor authentication for staff ${p.userId}`,
  async execute(p) {
    await authService.resetTwoFactorForStaff(p.userId);
    return { reset: true };
  },
});

module.exports = {};
