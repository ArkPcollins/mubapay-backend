'use strict';
const { mongoose } = require('../../lib/db');
const { Schema } = mongoose;

const transferSchema = new Schema(
  {
    reference: { type: String, required: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    recipientId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    amountKobo: { type: Number, required: true },
    feeKobo: { type: Number, default: 0 },
    narration: { type: String, maxlength: 140 },
    status: { type: String, enum: ['completed', 'held', 'rejected'], required: true },
    holdReason: String,
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedAt: Date,
    ledgerTransactionId: { type: Schema.Types.ObjectId, ref: 'LedgerTransaction' },
  },
  { timestamps: true }
);
transferSchema.index({ reference: 1 }, { unique: true });
transferSchema.index({ senderId: 1, createdAt: -1 });
transferSchema.index({ recipientId: 1, createdAt: -1 });
transferSchema.index({ status: 1, createdAt: -1 });

const bankAccountSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    bankCode: { type: String, required: true },
    bankName: String,
    accountNumberEnc: { type: String, required: true, select: false },
    accountNumberLast4: String,
    accountName: String,
    nameMatchStatus: { type: String, enum: ['matched', 'mismatch', 'unverified'], default: 'unverified' },
    recipientCode: { type: String, select: false },
    status: { type: String, enum: ['active', 'removed'], default: 'active' },
  },
  { timestamps: true }
);
bankAccountSchema.index({ userId: 1, status: 1 });

/**
 * Withdrawal lifecycle:
 *  pending_review → approved → payout_processing → completed
 *                 ↘ rejected (funds released)
 *  payout_processing → payout_uncertain (timeout) → completed | failed
 *  payout_processing → failed (funds released) ; completed → reversed (provider reversal; funds returned)
 *  approved → manual_payout_pending → completed (manual confirmation with evidence)
 */
const withdrawalSchema = new Schema(
  {
    reference: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    bankAccountId: { type: Schema.Types.ObjectId, ref: 'BankAccount', required: true },
    amountKobo: { type: Number, required: true },
    feeKobo: { type: Number, default: 0 },
    source: { type: String, enum: ['wallet', 'savings_maturity'], default: 'wallet' },
    status: {
      type: String,
      enum: ['pending_review', 'approved', 'rejected', 'payout_processing', 'payout_uncertain', 'manual_payout_pending', 'completed', 'failed', 'reversed'],
      default: 'pending_review',
    },
    payoutMethod: { type: String, enum: ['paystack_transfer', 'manual'], default: undefined },
    requiresDualApproval: { type: Boolean, default: false },
    approvals: [{ by: { type: Schema.Types.ObjectId, ref: 'User' }, at: Date, note: String }],
    rejectedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    rejectionReason: String,
    payoutReference: String,
    providerTransferCode: String,
    providerStatus: String,
    manualEvidence: { bankReference: String, note: String, confirmedBy: { type: Schema.Types.ObjectId, ref: 'User' }, initiatedBy: { type: Schema.Types.ObjectId, ref: 'User' }, at: Date },
    failureReason: String,
    holdLedgerTxId: { type: Schema.Types.ObjectId, ref: 'LedgerTransaction' },
    settleLedgerTxId: { type: Schema.Types.ObjectId, ref: 'LedgerTransaction' },
    history: [{ at: Date, status: String, by: { type: Schema.Types.ObjectId, ref: 'User' }, note: String }],
    lastCheckedAt: Date,
  },
  { timestamps: true }
);
withdrawalSchema.index({ reference: 1 }, { unique: true });
withdrawalSchema.index({ payoutReference: 1 }, { unique: true, sparse: true });
withdrawalSchema.index({ userId: 1, createdAt: -1 });
withdrawalSchema.index({ status: 1, createdAt: 1 });

const Transfer = mongoose.models.Transfer || mongoose.model('Transfer', transferSchema);
const BankAccount = mongoose.models.BankAccount || mongoose.model('BankAccount', bankAccountSchema);
const Withdrawal = mongoose.models.Withdrawal || mongoose.model('Withdrawal', withdrawalSchema);
module.exports = { Transfer, BankAccount, Withdrawal };
