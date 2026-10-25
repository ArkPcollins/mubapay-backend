'use strict';
const { LedgerAccount, LedgerTransaction, LedgerEntry } = require('./ledger.models');
const { E, AppError } = require('../../lib/errors');
const { isDuplicateKey } = require('../../lib/db');

const DEBIT_NORMAL = new Set(['asset', 'expense']);

/** System account codes. */
const SYS = {
  PAYSTACK_BALANCE: 'SYS:PROVIDER_BALANCE:paystack',
  MANUAL_PAYOUT_BANK: 'SYS:BANK:operations',
  PROVIDER_FEES: 'SYS:PROVIDER_FEES',
  REVENUE_COMMISSION: 'SYS:REVENUE:marketplace_commission',
  REVENUE_SALES: 'SYS:REVENUE:direct_sales',
  REVENUE_VIEWING: 'SYS:REVENUE:viewing_commission',
  REVENUE_PENALTY: 'SYS:REVENUE:savings_early_exit',
  REVENUE_FEES: 'SYS:REVENUE:transaction_fees',
  REVENUE_PROMOTION: 'SYS:REVENUE:promotions',
  ORDER_CLEARING: 'SYS:ORDER_CLEARING',
  VIEWING_CLEARING: 'SYS:VIEWING_FEE_CLEARING',
  DELIVERY_PAYABLE: 'SYS:DELIVERY_PAYABLE',
  REFUND_PAYABLE: 'SYS:REFUND_PAYABLE',
  CORRECTIONS: 'SYS:CORRECTIONS',
};

const SYSTEM_ACCOUNTS = [
  { code: SYS.PAYSTACK_BALANCE, name: 'Paystack balance (funds held at provider)', kind: 'asset', purpose: 'provider_balance', refId: 'paystack', allowNegative: true },
  { code: SYS.MANUAL_PAYOUT_BANK, name: 'Operations bank account (manual payouts)', kind: 'asset', purpose: 'bank', allowNegative: true },
  { code: SYS.PROVIDER_FEES, name: 'Payment provider fees', kind: 'expense', purpose: 'provider_fees', allowNegative: true },
  { code: SYS.REVENUE_COMMISSION, name: 'Marketplace commission revenue', kind: 'revenue', purpose: 'revenue', allowNegative: true },
  { code: SYS.REVENUE_SALES, name: 'Direct product sales revenue', kind: 'revenue', purpose: 'revenue', allowNegative: true },
  { code: SYS.REVENUE_VIEWING, name: 'Viewing fee commission revenue', kind: 'revenue', purpose: 'revenue', allowNegative: true },
  { code: SYS.REVENUE_PENALTY, name: 'Savings early-exit penalty revenue', kind: 'revenue', purpose: 'revenue', allowNegative: true },
  { code: SYS.REVENUE_FEES, name: 'Transaction fee revenue', kind: 'revenue', purpose: 'revenue', allowNegative: true },
  { code: SYS.REVENUE_PROMOTION, name: 'Promotion fee revenue', kind: 'revenue', purpose: 'revenue', allowNegative: true },
  { code: SYS.ORDER_CLEARING, name: 'Order clearing (buyer funds awaiting fulfilment)', kind: 'liability', purpose: 'order_clearing' },
  { code: SYS.VIEWING_CLEARING, name: 'Viewing fee clearing', kind: 'liability', purpose: 'viewing_fee_clearing' },
  { code: SYS.DELIVERY_PAYABLE, name: 'Delivery fees payable to logistics providers', kind: 'liability', purpose: 'delivery_payable', allowNegative: true },
  { code: SYS.REFUND_PAYABLE, name: 'Refunds payable to original payment method', kind: 'liability', purpose: 'refund_payable' },
  { code: SYS.CORRECTIONS, name: 'Approved corrections & adjustments', kind: 'expense', purpose: 'corrections', allowNegative: true },
];

const userCodes = (userId) => ({
  wallet: `USER:${userId}:WALLET`,
  hold: `USER:${userId}:HOLD`,
  sellerPayable: `USER:${userId}:SELLER_PAYABLE`,
});
const savingsCode = (savingsAccountId) => `SAVINGS:${savingsAccountId}`;

/**
 * Create an account if missing. Reads first: an upsert that matches an
 * existing document is still a write, and would cause a WriteConflict with
 * any transaction concurrently modifying that account (e.g. when called from
 * inside a refund/settlement flow). Existing accounts are therefore never written.
 */
async function upsertAccount(def, session) {
  const existing = await LedgerAccount.findOne({ code: def.code }).session(session || null);
  if (existing) return existing;
  try {
    return await LedgerAccount.findOneAndUpdate({ code: def.code }, { $setOnInsert: def }, { upsert: true, new: true, session });
  } catch (err) {
    if (isDuplicateKey(err)) return LedgerAccount.findOne({ code: def.code }).session(session || null);
    throw err;
  }
}

async function ensureSystemAccounts() {
  for (const a of SYSTEM_ACCOUNTS) await upsertAccount(a);
}

/** Idempotently create a user's ledger accounts. Call outside transactions (e.g. on signup). */
async function ensureUserAccounts(userId) {
  const c = userCodes(userId);
  await upsertAccount({ code: c.wallet, name: 'Wallet (available)', kind: 'liability', purpose: 'user_wallet', ownerId: userId });
  await upsertAccount({ code: c.hold, name: 'Wallet (reserved for withdrawals)', kind: 'liability', purpose: 'user_hold', ownerId: userId });
  await upsertAccount({ code: c.sellerPayable, name: 'Seller proceeds pending release', kind: 'liability', purpose: 'user_seller_payable', ownerId: userId });
  return c;
}

async function ensureSavingsAccount(savingsAccountId, userId) {
  return upsertAccount({ code: savingsCode(savingsAccountId), name: 'Savings balance', kind: 'liability', purpose: 'user_savings', ownerId: userId, refId: String(savingsAccountId) });
}

class DuplicatePostingError extends AppError {
  constructor(reference) {
    super(409, 'DUPLICATE_POSTING', `Ledger transaction ${reference} already posted`);
    this.reference = reference;
  }
}

function validateEntries(entries) {
  if (!Array.isArray(entries) || entries.length < 2) throw new Error('A ledger transaction needs at least two entries');
  let debits = 0;
  let credits = 0;
  for (const e of entries) {
    if (!Number.isSafeInteger(e.amount) || e.amount <= 0) throw new Error(`Invalid entry amount ${e.amount}`);
    if (e.direction === 'debit') debits += e.amount;
    else if (e.direction === 'credit') credits += e.amount;
    else throw new Error(`Invalid direction ${e.direction}`);
    if (!e.account) throw new Error('Entry account code missing');
  }
  if (debits !== credits) throw new Error(`Unbalanced transaction: debits ${debits} != credits ${credits}`);
  return debits;
}

/**
 * Post a balanced transaction atomically. MUST be called with a session from
 * withTransaction(). Throws:
 *   DuplicatePostingError  if the reference already exists (idempotency)
 *   INSUFFICIENT_FUNDS     if a non-negative account would go below zero
 */
async function post({ reference, type, description, entries, initiatedBy, approvedBy, relatedType, relatedId, metadata, reversalOf, insufficientError }, session) {
  if (!session) throw new Error('ledger.post requires a transaction session');
  const total = validateEntries(entries);
  const codes = [...new Set(entries.map((e) => e.account))];
  const accounts = await LedgerAccount.find({ code: { $in: codes } }).session(session);
  const byCode = new Map(accounts.map((a) => [a.code, a]));
  for (const c of codes) {
    const acc = byCode.get(c);
    if (!acc) throw new Error(`Ledger account ${c} does not exist`);
    if (acc.status !== 'active') throw E.conflict(`Account ${c} is ${acc.status}`, 'ACCOUNT_NOT_ACTIVE');
  }

  let tx;
  try {
    [tx] = await LedgerTransaction.create(
      [{
        reference, type, description, totalKobo: total, initiatedBy, approvedBy, relatedType,
        relatedId: relatedId != null ? String(relatedId) : undefined, metadata, reversalOf,
        userIds: [...new Set(accounts.filter((a) => a.ownerId).map((a) => String(a.ownerId)))],
      }],
      { session }
    );
  } catch (err) {
    if (isDuplicateKey(err)) throw new DuplicatePostingError(reference);
    throw err;
  }

  // Apply credits before debits on the same account set so a transaction that
  // nets out (e.g. hold→wallet) never trips the non-negative guard spuriously.
  const ordered = [...entries].sort((a, b) => (a.direction === b.direction ? 0 : a.direction === 'credit' ? -1 : 1));
  const docs = [];
  for (const e of ordered) {
    const acc = byCode.get(e.account);
    const increases = DEBIT_NORMAL.has(acc.kind) ? e.direction === 'debit' : e.direction === 'credit';
    const delta = increases ? e.amount : -e.amount;
    const filter = { _id: acc._id, status: 'active' };
    if (delta < 0 && !acc.allowNegative) filter.balance = { $gte: -delta };
    const updated = await LedgerAccount.findOneAndUpdate(filter, { $inc: { balance: delta } }, { new: true, session });
    if (!updated) throw insufficientError || E.insufficientFunds();
    docs.push({ transactionId: tx._id, reference, accountId: acc._id, accountCode: acc.code, direction: e.direction, amount: e.amount, balanceAfter: updated.balance, postedAt: tx.postedAt });
  }
  await LedgerEntry.insertMany(docs, { session });
  return tx;
}

/*
 * NOTE: there is intentionally no "post or ignore duplicate" helper. Inside a
 * MongoDB transaction a duplicate-key error aborts the transaction, so callers
 * that need idempotency check for the reference (or claim a state transition)
 * BEFORE posting, and let DuplicatePostingError abort concurrent duplicates.
 */

/** Compensating reversal of a posted transaction (flips every entry). */
async function reverse(originalId, { reason, initiatedBy, approvedBy }, session) {
  const orig = await LedgerTransaction.findById(originalId).session(session);
  if (!orig) throw E.notFound('Ledger transaction');
  if (orig.type === 'reversal') throw E.conflict('A reversal cannot itself be reversed; post an adjustment instead');
  const entries = await LedgerEntry.find({ transactionId: orig._id }).session(session);
  return post(
    {
      reference: `REV-${orig.reference}`,
      type: 'reversal',
      description: `Reversal of ${orig.reference}: ${reason}`,
      entries: entries.map((e) => ({ account: e.accountCode, direction: e.direction === 'debit' ? 'credit' : 'debit', amount: e.amount })),
      initiatedBy,
      approvedBy,
      reversalOf: orig._id,
      relatedType: 'ledger_transaction',
      relatedId: orig._id,
      metadata: { reason },
    },
    session
  );
}

async function getBalance(code, session) {
  const a = await LedgerAccount.findOne({ code }, { balance: 1 }).session(session || null).lean();
  return a ? a.balance : 0;
}

/**
 * Ledger invariants:
 *  1. Every transaction balances (sum debits == sum credits).
 *  2. Every account's materialised balance equals the net of its entries.
 *  3. No non-negative account is negative.
 */
async function checkInvariants() {
  const problems = [];
  const unbalanced = await LedgerEntry.aggregate([
    { $group: { _id: '$transactionId', d: { $sum: { $cond: [{ $eq: ['$direction', 'debit'] }, '$amount', 0] } }, c: { $sum: { $cond: [{ $eq: ['$direction', 'credit'] }, '$amount', 0] } } } },
    { $match: { $expr: { $ne: ['$d', '$c'] } } },
    { $limit: 100 },
  ]);
  for (const u of unbalanced) problems.push({ type: 'unbalanced_transaction', transactionId: String(u._id), debits: u.d, credits: u.c });

  const sums = await LedgerEntry.aggregate([
    { $group: { _id: '$accountId', d: { $sum: { $cond: [{ $eq: ['$direction', 'debit'] }, '$amount', 0] } }, c: { $sum: { $cond: [{ $eq: ['$direction', 'credit'] }, '$amount', 0] } } } },
  ]);
  const sumMap = new Map(sums.map((s) => [String(s._id), s]));
  const accounts = await LedgerAccount.find({}).lean();
  for (const a of accounts) {
    const s = sumMap.get(String(a._id)) || { d: 0, c: 0 };
    const expected = DEBIT_NORMAL.has(a.kind) ? s.d - s.c : s.c - s.d;
    if (expected !== a.balance) problems.push({ type: 'balance_mismatch', account: a.code, stored: a.balance, fromEntries: expected });
    if (!a.allowNegative && a.balance < 0) problems.push({ type: 'negative_balance', account: a.code, balance: a.balance });
  }
  return { ok: problems.length === 0, problems, accountsChecked: accounts.length };
}

module.exports = {
  SYS, SYSTEM_ACCOUNTS, userCodes, savingsCode, ensureSystemAccounts, ensureUserAccounts, ensureSavingsAccount,
  post, reverse, getBalance, checkInvariants, DuplicatePostingError, validateEntries,
};
