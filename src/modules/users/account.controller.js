'use strict';
const { User } = require('./user.model');
const verification = require('../verification/verification.service');
const privacy = require('../privacy/privacy.service');
const consent = require('../legal/consent.service');
const wallet = require('../wallet/wallet.service');
const { SavingsAccount } = require('../savings/savings.models');
const reports = require('../reports/reports.service');
const { ok, created } = require('../../lib/http');
const { E } = require('../../lib/errors');
const usersService = require('./users.service');

module.exports = {
  async updateProfile(req, res) {
    const set = {};
    if (req.user.kycStatus !== 'approved') {
      if (req.body.firstName) set.firstName = req.body.firstName;
      if (req.body.lastName) set.lastName = req.body.lastName;
    } else if (req.body.firstName || req.body.lastName) throw E.conflict('Your name is locked to your verified identity. Contact support to change it.', 'NAME_LOCKED');
    if (req.body.phone && req.body.phone !== req.user.phone) {
      const p = usersService.normalisePhone(req.body.phone);
      if (!p) throw E.validation([{ path: 'phone', message: 'Enter a valid Nigerian phone number' }]);
      set.phone = p;
      set.phoneVerifiedAt = null;
    }
    await User.updateOne({ _id: req.user._id }, { $set: set });
    const u = await usersService.recomputeTier(req.user._id);
    ok(res, u.toSelf());
  },
  async addAddress(req, res) {
    if (req.user.addresses.length >= 10) throw E.conflict('You can save up to 10 addresses');
    const u = await User.findById(req.user._id);
    if (req.body.isDefault) u.addresses.forEach((a) => { a.isDefault = false; });
    u.addresses.push(req.body);
    await u.save();
    created(res, u.addresses[u.addresses.length - 1]);
  },
  async updateAddress(req, res) {
    const u = await User.findById(req.user._id);
    const a = u.addresses.id(req.params.id);
    if (!a) throw E.notFound('Address');
    if (req.body.isDefault) u.addresses.forEach((x) => { x.isDefault = false; });
    Object.assign(a, req.body);
    await u.save();
    ok(res, a);
  },
  async deleteAddress(req, res) {
    await User.updateOne({ _id: req.user._id }, { $pull: { addresses: { _id: req.params.id } } });
    ok(res, { deleted: true });
  },
  async preferences(req, res) {
    ok(res, await privacy.updatePreferences(req.user, req.body, req));
  },
  async onboardingStep(req, res) {
    await User.updateOne({ _id: req.user._id }, { $addToSet: { 'onboarding.completedSteps': req.body.step }, ...(req.body.complete ? { $set: { 'onboarding.completedAt': new Date() } } : {}) });
    ok(res, (await User.findById(req.user._id)).toSelf());
  },
  async outstandingTerms(req, res) {
    ok(res, await consent.outstanding(req.user._id, req.query.context));
  },
  async acceptTerms(req, res) {
    await consent.recordAcceptances(req.user._id, req.body.acceptedPolicies, { ip: req.ip, userAgent: req.get('user-agent'), context: req.body.context || 'renewal' });
    ok(res, await consent.outstanding(req.user._id));
  },
  // ---- identity & roles
  async myVerification(req, res) {
    ok(res, await verification.myIdentity(req.user));
  },
  async submitVerification(req, res) {
    created(res, await verification.submitIdentity(req.user, req.body, req.files, req));
  },
  async appealVerification(req, res) {
    ok(res, await verification.appealIdentity(req.user, req.params.id, req.body.text));
  },
  async applyRole(req, res) {
    created(res, await verification.applyForRole(req.user, req.body, req.files, req));
  },
  async myRoleApplications(req, res) {
    ok(res, await verification.myRoleApplications(req.user));
  },
  async documentAccess(req, res) {
    ok(res, await verification.requestDocumentAccess(req.user, req.params.id, req));
  },
  async downloadDocument(req, res) {
    await verification.streamDocument(req.user, req.params.token, req, res);
  },
  // ---- privacy
  async closureCheck(req, res) {
    const blockers = await privacy.closureBlockers(req.user);
    ok(res, { canClose: blockers.length === 0, blockers });
  },
  async close(req, res) {
    const r = await privacy.closeAccount(req.user, req.body, req);
    require('../auth/auth.controller').clearSessionCookies(res);
    ok(res, r);
  },
  async exportData(req, res) {
    const data = await privacy.exportData(req.user, req);
    res.set({ 'Content-Type': 'application/json', 'Content-Disposition': `attachment; filename="mubapay-data-${new Date().toISOString().slice(0, 10)}.json"`, 'Cache-Control': 'no-store' });
    res.send(JSON.stringify(data, null, 2));
  },
  /** Separate statements: wallet | savings | orders, CSV / XLSX / PDF. */
  async statement(req, res) {
    const { kind, format = 'csv' } = req.params;
    const from = req.query.from || new Date(Date.now() - 90 * 864e5).toISOString();
    const to = req.query.to || new Date().toISOString();
    let rows;
    if (kind === 'wallet') {
      const data = await wallet.statementRows(req.user, { from, to });
      rows = [['Date', 'Reference', 'Type', 'Description', 'Credit (kobo)', 'Debit (kobo)', 'Balance (kobo)'], ...data.map((r) => [r.date, r.reference, r.type, r.description, r.creditKobo, r.debitKobo, r.balanceKobo])];
    } else if (kind === 'savings') {
      const accs = await SavingsAccount.find({ userId: req.user._id }).lean();
      const ledger = require('../ledger/ledger.service');
      const { LedgerAccount, LedgerEntry, LedgerTransaction } = require('../ledger/ledger.models');
      rows = [['Plan', 'Date', 'Reference', 'Description', 'Credit (kobo)', 'Debit (kobo)', 'Balance (kobo)']];
      for (const a of accs) {
        const la = await LedgerAccount.findOne({ code: ledger.savingsCode(a._id) }).lean();
        if (!la) continue;
        const entries = await LedgerEntry.find({ accountId: la._id, postedAt: { $gte: new Date(from), $lte: new Date(to) } }).sort({ postedAt: 1 }).lean();
        const txs = new Map((await LedgerTransaction.find({ _id: { $in: entries.map((e) => e.transactionId) } }).lean()).map((t) => [String(t._id), t]));
        for (const e of entries) rows.push([a.name, e.postedAt.toISOString(), txs.get(String(e.transactionId))?.reference, txs.get(String(e.transactionId))?.description, e.direction === 'credit' ? e.amount : 0, e.direction === 'debit' ? e.amount : 0, e.balanceAfter]);
      }
    } else if (kind === 'orders') {
      const { Order } = require('../marketplace/marketplace.models');
      const orders = await Order.find({ buyerId: req.user._id, createdAt: { $gte: new Date(from), $lte: new Date(to) } }).sort({ createdAt: 1 }).lean();
      rows = [['Date', 'Order', 'Status', 'Items', 'Subtotal (kobo)', 'Delivery (kobo)', 'Total (kobo)', 'Refunded (kobo)'], ...orders.map((o) => [o.createdAt.toISOString(), o.orderNumber, o.status, o.items.map((i) => `${i.quantity}x ${i.title}`).join('; '), o.subtotalKobo, o.deliveryFeeKobo, o.totalKobo, o.refundedKobo])];
    } else throw E.badRequest('Statement kind must be wallet, savings or orders');
    const name = `mubapay-${kind}-statement`;
    let body;
    let type;
    if (format === 'csv') { body = Buffer.from(reports.toCsv(rows)); type = 'text/csv; charset=utf-8'; }
    else if (format === 'xlsx') { body = await reports.toXlsx(`${kind} statement`, rows); type = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'; }
    else if (format === 'pdf') { body = await reports.toPdf(`${kind} statement (${from.slice(0, 10)} to ${to.slice(0, 10)})`, rows); type = 'application/pdf'; }
    else throw E.badRequest('format must be csv, xlsx or pdf');
    res.set({ 'Content-Type': type, 'Content-Disposition': `attachment; filename="${name}.${format}"`, 'Cache-Control': 'no-store' });
    res.send(body);
  },
  async unsubscribe(req, res) {
    ok(res, await privacy.unsubscribe(req.query.token));
  },
};
