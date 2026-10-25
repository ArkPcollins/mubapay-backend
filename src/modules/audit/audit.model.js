'use strict';
const { mongoose } = require('../../lib/db');
const { Schema } = mongoose;

/**
 * Append-only audit events. Mongoose hooks reject updates and deletes so no
 * ordinary code path (or admin endpoint) can alter history. Database-level
 * protection should additionally be applied in production by granting the
 * application user only `insert` + `find` on this collection
 * (see documentation/security.md).
 */
const auditEventSchema = new Schema(
  {
    at: { type: Date, default: Date.now },
    actorId: { type: Schema.Types.ObjectId, ref: 'User' },
    actorRoles: [String],
    actorType: { type: String, enum: ['user', 'staff', 'system', 'provider'], default: 'user' },
    action: { type: String, required: true },
    category: { type: String, enum: ['security', 'finance', 'config', 'access', 'moderation', 'kyc', 'export', 'support', 'operations', 'privacy'], required: true },
    targetType: String,
    targetId: String,
    sensitiveRead: { type: Boolean, default: false },
    outcome: { type: String, enum: ['success', 'denied', 'failure'], default: 'success' },
    reason: String,
    metadata: Schema.Types.Mixed,
    ip: String,
    userAgent: String,
    requestId: String,
    contentHash: String,
  },
  { versionKey: false }
);
auditEventSchema.index({ at: -1 });
auditEventSchema.index({ actorId: 1, at: -1 });
auditEventSchema.index({ targetType: 1, targetId: 1, at: -1 });
auditEventSchema.index({ category: 1, action: 1, at: -1 });

const block = function blockMutation(next) {
  next(new Error('Audit events are immutable'));
};
['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete', 'findOneAndReplace'].forEach((op) =>
  auditEventSchema.pre(op, block)
);
auditEventSchema.pre('save', function onlyNew(next) {
  if (!this.isNew) return next(new Error('Audit events are immutable'));
  next();
});

/** Operational alerts. Critical alerts persist until acknowledged; acknowledgement never erases history. */
const alertSchema = new Schema(
  {
    severity: { type: String, enum: ['info', 'warning', 'critical'], required: true },
    type: { type: String, required: true },
    message: { type: String, required: true },
    refType: String,
    refId: String,
    dedupeKey: String,
    status: { type: String, enum: ['open', 'acknowledged', 'resolved'], default: 'open' },
    occurrences: { type: Number, default: 1 },
    lastOccurredAt: { type: Date, default: Date.now },
    history: [{ at: Date, by: { type: Schema.Types.ObjectId, ref: 'User' }, action: String, note: String }],
  },
  { timestamps: true }
);
alertSchema.index({ status: 1, severity: 1, createdAt: -1 });
alertSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { status: 'open', dedupeKey: { $type: 'string' } } });

const AuditEvent = mongoose.models.AuditEvent || mongoose.model('AuditEvent', auditEventSchema);
const Alert = mongoose.models.Alert || mongoose.model('Alert', alertSchema);
module.exports = { AuditEvent, Alert };
