'use strict';
const { mongoose } = require('../../lib/db');
const { Schema } = mongoose;

const CATEGORIES = ['security', 'financial', 'savings', 'orders', 'delivery', 'property', 'support', 'disputes', 'account', 'marketing', 'system'];

/**
 * In-app notification + durable email delivery state. Created inside the same
 * transaction as the business event, so it doubles as a transactional outbox.
 */
const notificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    category: { type: String, enum: CATEGORIES, required: true },
    type: { type: String, required: true },
    title: { type: String, required: true, maxlength: 200 },
    body: { type: String, maxlength: 2000 },
    link: String,
    data: Schema.Types.Mixed,
    mandatory: { type: Boolean, default: false },
    readAt: Date,
    dedupeKey: String,
    email: {
      wanted: { type: Boolean, default: false },
      // captured_dev = written to the development console outbox, NOT delivered
      status: { type: String, enum: ['pending', 'sending', 'sent', 'captured_dev', 'failed', 'skipped', 'not_configured'], default: 'skipped' },
      attempts: { type: Number, default: 0 },
      nextAttemptAt: Date,
      lockedUntil: Date,
      providerMessageId: String,
      lastError: String,
      sentAt: Date,
      template: String,
      to: String,
    },
    realtimeEmittedAt: Date,
  },
  { timestamps: true }
);
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, readAt: 1 });
notificationSchema.index({ 'email.status': 1, 'email.nextAttemptAt': 1 });
notificationSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });

const Notification = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);
module.exports = { Notification, CATEGORIES };
