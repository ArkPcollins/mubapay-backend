'use strict';
const svc = require('./wallet.service');
const payments = require('../payments/payments.service');
const { SavedCard } = require('../payments/payment.models');
const { ok, created } = require('../../lib/http');

const pg = (q) => ({ page: Math.max(1, Number(q.page) || 1), limit: Math.min(100, Math.max(1, Number(q.limit) || 20)) });

module.exports = {
  overview: async (req, res) => ok(res, await svc.overview(req.user)),
  fund: async (req, res) => created(res, await svc.initFunding(req.user, req.body, { idempotencyKey: req.idempotencyKey })),
  paymentStatus: async (req, res) => ok(res, await payments.statusFor(req.user, req.params.reference)),
  lookup: async (req, res) => ok(res, await svc.lookupRecipient(req.user, req.query.identifier)),
  transfer: async (req, res) => created(res, await svc.transfer(req.user, req.body, { idempotencyKey: req.idempotencyKey, req })),
  banks: async (_req, res) => ok(res, await svc.listBanks()),
  bankAccounts: async (req, res) => ok(res, await svc.listBankAccounts(req.user)),
  addBankAccount: async (req, res) => created(res, await svc.addBankAccount(req.user, req.body, req)),
  removeBankAccount: async (req, res) => {
    await svc.removeBankAccount(req.user, req.params.id);
    ok(res, { removed: true });
  },
  withdraw: async (req, res) => created(res, await svc.requestWithdrawal(req.user, req.body, { idempotencyKey: req.idempotencyKey, req })),
  withdrawals: async (req, res) => {
    const r = await svc.listWithdrawals(req.user, pg(req.query));
    ok(res, r.items, r.meta);
  },
  transactions: async (req, res) => {
    const r = await svc.transactions(req.user, { ...pg(req.query), type: req.query.type, from: req.query.from, to: req.query.to });
    ok(res, r.items, r.meta);
  },
  transaction: async (req, res) => ok(res, await svc.transactionDetail(req.user, req.params.reference)),
  cards: async (req, res) => ok(res, (await SavedCard.find({ userId: req.user._id, status: 'active' }).lean()).map((c) => ({ id: String(c._id), last4: c.last4, brand: c.brand, bank: c.bank, expMonth: c.expMonth, expYear: c.expYear }))),
  removeCard: async (req, res) => {
    await SavedCard.updateOne({ _id: req.params.id, userId: req.user._id }, { $set: { status: 'removed' } });
    ok(res, { removed: true });
  },
};
