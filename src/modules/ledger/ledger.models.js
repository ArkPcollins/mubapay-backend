'use strict';
const { mongoose } = require('../../lib/db');
const { Schema } = mongoose;

/**
 * Chart of accounts.
 *  kind      normal balance   increases with
 *  asset     debit            debit
 *  expense   debit            debit
 *  liability credit           credit
 *  revenue   credit           credit
 *  equity    credit           credit
 *
 * `balance` is a materialised projection of the entries, always updated in
 * the same MongoDB transaction as the entries it summarises, and verified by
 * the reconciliation invariant job. Entries are the source of truth.
 */
const ledgerAccountSchema = new Schema(
  {
    code: { type: String, required: true },
    name: String,
    kind: { type: String, enum: ['asset', 'liability', 'revenue', 'expense', 'equity'], required: true },
    purpose: {
      type: String,
      required: true,
      enum: [
        'user_wallet', 'user_hold', 'user_seller_payable', 'user_savings',
        'provider_balance', 'bank', 'provider_fees', 'revenue', 'order_clearing',
        'viewing_fee_clearing', 'delivery_payable', 'refund_payable', 'corrections', 'equity',
      ],
    },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User' },
    refId: String, // e.g. savings account id or provider name
    currency: { type: String, default: 'NGN', enum: ['NGN'] },
    balance: { type: Number, default: 0 },
    allowNegative: { type: Boolean, default: false },
    status: { type: String, enum: ['active', 'frozen', 'closed'], default: 'active' },
  },
  { timestamps: true }
);
ledgerAccountSchema.index({ code: 1 }, { unique: true });
ledgerAccountSchema.index({ ownerId: 1, purpose: 1 });
ledgerAccountSchema.path('balance').validate(Number.isSafeInteger, 'balance must be integer kobo');

const ledgerTransactionSchema = new Schema(
  {
    reference: { type: String, required: true },
    type: {
      type: String,
      required: true,
      enum: [
        'wallet_funding', 'transfer', 'withdrawal_hold', 'withdrawal_release', 'withdrawal_payout', 'withdrawal_reversal',
        'savings_deposit', 'savings_contribution_card', 'savings_early_exit', 'savings_maturity',
        'order_payment', 'order_settlement', 'order_refund', 'seller_settlement_release',
        'viewing_fee_payment', 'viewing_fee_release', 'viewing_fee_refund',
        'provider_fee', 'adjustment', 'reversal', 'card_refund',
      ],
    },
    description: String,
    status: { type: String, enum: ['posted'], default: 'posted' },
    totalKobo: { type: Number, required: true },
    reversalOf: { type: Schema.Types.ObjectId, ref: 'LedgerTransaction' },
    initiatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    approvedBy: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    relatedType: String,
    relatedId: String,
    userIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    metadata: Schema.Types.Mixed,
    postedAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);
ledgerTransactionSchema.index({ reference: 1 }, { unique: true });
ledgerTransactionSchema.index({ reversalOf: 1 }, { unique: true, partialFilterExpression: { reversalOf: { $exists: true } } });
ledgerTransactionSchema.index({ userIds: 1, postedAt: -1 });
ledgerTransactionSchema.index({ type: 1, postedAt: -1 });
ledgerTransactionSchema.index({ relatedType: 1, relatedId: 1 });
ledgerTransactionSchema.index({ postedAt: -1 });

const ledgerEntrySchema = new Schema(
  {
    transactionId: { type: Schema.Types.ObjectId, ref: 'LedgerTransaction', required: true },
    reference: { type: String, required: true },
    accountId: { type: Schema.Types.ObjectId, ref: 'LedgerAccount', required: true },
    accountCode: { type: String, required: true },
    direction: { type: String, enum: ['debit', 'credit'], required: true },
    amount: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    postedAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);
ledgerEntrySchema.index({ accountId: 1, postedAt: -1 });
ledgerEntrySchema.index({ transactionId: 1 });
ledgerEntrySchema.path('amount').validate((v) => Number.isSafeInteger(v) && v > 0, 'entry amount must be positive integer kobo');

const immutable = function immutable(next) {
  next(new Error('Ledger records are immutable; post a compensating transaction instead'));
};
for (const s of [ledgerTransactionSchema, ledgerEntrySchema]) {
  ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'findOneAndReplace'].forEach((op) => s.pre(op, immutable));
  s.pre('save', function onlyInsert(next) {
    if (!this.isNew) return next(new Error('Ledger records are immutable'));
    next();
  });
}
ledgerAccountSchema.pre(['deleteOne', 'deleteMany', 'findOneAndDelete'], immutable);

const LedgerAccount = mongoose.models.LedgerAccount || mongoose.model('LedgerAccount', ledgerAccountSchema);
const LedgerTransaction = mongoose.models.LedgerTransaction || mongoose.model('LedgerTransaction', ledgerTransactionSchema);
const LedgerEntry = mongoose.models.LedgerEntry || mongoose.model('LedgerEntry', ledgerEntrySchema);

module.exports = { LedgerAccount, LedgerTransaction, LedgerEntry };
