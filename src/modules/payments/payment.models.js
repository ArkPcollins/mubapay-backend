'use strict';
const { mongoose } = require('../../lib/db');
const { Schema } = mongoose;

/**
 * A single attempt to collect money through a provider (Paystack).
 * Purpose determines what happens once the provider confirms success.
 * `fulfilledAt` + a unique ledger reference guarantee single fulfilment.
 */
const paymentAttemptSchema = new Schema(
  {
    reference: { type: String, required: true },
    provider: { type: String, default: 'paystack' },
    purpose: { type: String, enum: ['wallet_funding', 'order', 'savings_contribution', 'viewing_fee'], required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    amountKobo: { type: Number, required: true },
    feeKobo: { type: Number, default: 0 }, // MubaPay fee disclosed to customer (if any)
    currency: { type: String, default: 'NGN' },
    status: { type: String, enum: ['initialized', 'pending', 'success', 'failed', 'abandoned', 'uncertain', 'amount_mismatch'], default: 'initialized' },
    relatedType: String,
    relatedId: String,
    authorizationUrl: String,
    accessCode: String,
    providerTransactionId: String,
    providerStatus: String,
    providerFeesKobo: Number,
    gatewayResponse: String,
    channel: String,
    paidAt: Date,
    verifiedAt: Date,
    verifyAttempts: { type: Number, default: 0 },
    lastVerifyError: String,
    fulfilledAt: Date,
    fulfillmentReference: String,
    fulfillmentError: String,
    expiresAt: Date,
    saveCard: { type: Boolean, default: false },
    history: [{ at: Date, status: String, source: String, note: String }],
  },
  { timestamps: true }
);
paymentAttemptSchema.index({ reference: 1 }, { unique: true });
paymentAttemptSchema.index({ userId: 1, createdAt: -1 });
paymentAttemptSchema.index({ status: 1, createdAt: 1 });
paymentAttemptSchema.index({ relatedType: 1, relatedId: 1 });
paymentAttemptSchema.index({ providerTransactionId: 1 }, { sparse: true });

/** Every inbound provider webhook, stored before processing. Unique eventKey = dedupe. */
const providerEventSchema = new Schema(
  {
    provider: { type: String, required: true },
    eventKey: { type: String, required: true },
    eventType: String,
    reference: String,
    payloadHash: String,
    payload: Schema.Types.Mixed,
    signatureValid: Boolean,
    status: { type: String, enum: ['received', 'processing', 'processed', 'ignored', 'failed'], default: 'received' },
    attempts: { type: Number, default: 0 },
    error: String,
    processedAt: Date,
    receivedCount: { type: Number, default: 1 },
  },
  { timestamps: true }
);
providerEventSchema.index({ provider: 1, eventKey: 1 }, { unique: true });
providerEventSchema.index({ status: 1, createdAt: 1 });
providerEventSchema.index({ reference: 1 });

/** Request idempotency. Clients send an Idempotency-Key header on financial POSTs. */
const idempotencySchema = new Schema(
  {
    key: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, required: true },
    scope: { type: String, required: true },
    requestHash: { type: String, required: true },
    state: { type: String, enum: ['in_progress', 'completed', 'failed'], default: 'in_progress' },
    responseStatus: Number,
    responseBody: Schema.Types.Mixed,
    lockedUntil: Date,
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);
idempotencySchema.index({ userId: 1, scope: 1, key: 1 }, { unique: true });
idempotencySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** Running per-user totals for limit enforcement, incremented inside financial transactions. */
const limitCounterSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    kind: { type: String, required: true }, // funding|transfer|withdrawal|savings
    period: { type: String, required: true }, // e.g. D:2026-10-20 or M:2026-10
    totalKobo: { type: Number, default: 0 },
    count: { type: Number, default: 0 },
    expiresAt: Date,
  },
  { timestamps: true }
);
limitCounterSchema.index({ userId: 1, kind: 1, period: 1 }, { unique: true });
limitCounterSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/** Saved reusable card authorisation (for scheduled savings), stored encrypted. */
const savedCardSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    provider: { type: String, default: 'paystack' },
    authorizationCodeEnc: { type: String, required: true, select: false },
    signature: String,
    last4: String,
    brand: String,
    bank: String,
    expMonth: String,
    expYear: String,
    status: { type: String, enum: ['active', 'removed'], default: 'active' },
  },
  { timestamps: true }
);
savedCardSchema.index({ userId: 1, status: 1 });
savedCardSchema.index({ userId: 1, signature: 1 }, { unique: true, partialFilterExpression: { status: 'active', signature: { $type: 'string' } } });

const PaymentAttempt = mongoose.models.PaymentAttempt || mongoose.model('PaymentAttempt', paymentAttemptSchema);
const ProviderEvent = mongoose.models.ProviderEvent || mongoose.model('ProviderEvent', providerEventSchema);
const IdempotencyRecord = mongoose.models.IdempotencyRecord || mongoose.model('IdempotencyRecord', idempotencySchema);
const LimitCounter = mongoose.models.LimitCounter || mongoose.model('LimitCounter', limitCounterSchema);
const SavedCard = mongoose.models.SavedCard || mongoose.model('SavedCard', savedCardSchema);

module.exports = { PaymentAttempt, ProviderEvent, IdempotencyRecord, LimitCounter, SavedCard };
