'use strict';
const { mongoose } = require('../../lib/db');
const { Schema } = mongoose;

const penaltyRule = new Schema({ type: { type: String, enum: ['none', 'fixed', 'percent'], default: 'none' }, bp: Number, fixedKobo: Number }, { _id: false });

/** Product definition (admin-managed). Only "personal" savings is offered at launch. */
const savingsPlanSchema = new Schema(
  {
    name: { type: String, required: true, maxlength: 80 },
    description: { type: String, maxlength: 2000 },
    productType: { type: String, enum: ['personal', 'group', 'purpose'], default: 'personal' }, // group/purpose: later phase
    contributionMode: { type: String, enum: ['flexible', 'scheduled'], required: true },
    minDurationDays: { type: Number, required: true },
    maxDurationDays: { type: Number, required: true },
    allowedFrequencies: { type: [String], default: ['weekly', 'monthly'] },
    minContributionKobo: { type: Number, default: 10000 },
    earlyExit: { type: penaltyRule, default: () => ({ type: 'none' }) },
    interestBp: { type: Number, default: 0 }, // no interest at launch; must remain 0
    status: { type: String, enum: ['active', 'retired'], default: 'active' },
    termsVersion: { type: Number, default: 1 },
    createdBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);
savingsPlanSchema.path('interestBp').validate((v) => v === 0, 'Interest is not offered at launch');

/** A customer's enrolment. Terms are snapshotted at acceptance and never changed retroactively. */
const savingsAccountSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    planId: { type: Schema.Types.ObjectId, ref: 'SavingsPlan', required: true },
    name: { type: String, maxlength: 80 },
    targetKobo: Number,
    terms: {
      planName: String, contributionMode: String, earlyExit: penaltyRule, termsVersion: Number, savingsTermsVersion: Number,
      graceDays: Number, maxConsecutiveMissedBeforePause: Number, missedPolicy: String, acceptedAt: Date, disclosure: String,
    },
    startDate: { type: Date, required: true },
    maturityDate: { type: Date, required: true },
    schedule: {
      frequency: { type: String, enum: ['daily', 'weekly', 'monthly'] },
      amountKobo: Number,
      nextDueAt: Date,
      fundingSource: { type: String, enum: ['wallet', 'card'] },
      savedCardId: { type: Schema.Types.ObjectId, ref: 'SavedCard' },
    },
    payoutPreference: { type: String, enum: ['wallet', 'bank'], default: 'wallet' },
    payoutBankAccountId: { type: Schema.Types.ObjectId, ref: 'BankAccount' },
    status: { type: String, enum: ['active', 'paused', 'matured', 'closed_early'], default: 'active' },
    consecutiveMissed: { type: Number, default: 0 },
    totalContributedKobo: { type: Number, default: 0 },
    ledgerCode: String,
    closedAt: Date,
    remindersSent: [String],
  },
  { timestamps: true }
);
savingsAccountSchema.index({ userId: 1, status: 1 });
savingsAccountSchema.index({ status: 1, 'schedule.nextDueAt': 1 });
savingsAccountSchema.index({ status: 1, maturityDate: 1 });

const contributionSchema = new Schema(
  {
    reference: { type: String, required: true },
    accountId: { type: Schema.Types.ObjectId, ref: 'SavingsAccount', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    amountKobo: { type: Number, required: true },
    kind: { type: String, enum: ['scheduled', 'manual'], required: true },
    source: { type: String, enum: ['wallet', 'card', 'card_checkout'], required: true },
    dueAt: Date,
    status: { type: String, enum: ['pending', 'success', 'failed', 'missed'], default: 'pending' },
    attempts: [{ at: Date, outcome: String, note: String }],
    paymentReference: String,
    ledgerReference: String,
    failureReason: String,
    graceEndsAt: Date,
    isTestContribution: { type: Boolean, default: false },
  },
  { timestamps: true }
);
contributionSchema.index({ reference: 1 }, { unique: true });
contributionSchema.index({ accountId: 1, dueAt: 1 }, { unique: true, partialFilterExpression: { kind: 'scheduled' } });
contributionSchema.index({ accountId: 1, createdAt: -1 });
contributionSchema.index({ status: 1, graceEndsAt: 1 });

const maturitySchema = new Schema(
  {
    accountId: { type: Schema.Types.ObjectId, ref: 'SavingsAccount', required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['maturity', 'early_exit'], required: true },
    balanceKobo: Number,
    penaltyKobo: { type: Number, default: 0 },
    payoutKobo: Number,
    calculation: Schema.Types.Mixed,
    destination: { type: String, enum: ['wallet', 'bank'], default: 'wallet' },
    withdrawalReference: String,
    ledgerReference: String,
    decidedAt: Date,
  },
  { timestamps: true }
);
maturitySchema.index({ accountId: 1 }, { unique: true });

const m = (n, s) => mongoose.models[n] || mongoose.model(n, s);
module.exports = { SavingsPlan: m('SavingsPlan', savingsPlanSchema), SavingsAccount: m('SavingsAccount', savingsAccountSchema), SavingsContribution: m('SavingsContribution', contributionSchema), SavingsPayout: m('SavingsPayout', maturitySchema) };
