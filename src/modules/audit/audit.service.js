'use strict';
const { AuditEvent, Alert } = require('./audit.model');
const { sha256, stableStringify } = require('../../lib/crypto');
const logger = require('../../lib/logger');
const config = require('../../config');

function ctxFrom(req) {
  if (!req) return {};
  return { ip: req.ip, userAgent: req.get?.('user-agent'), requestId: req.id, actor: req.user };
}

/**
 * Record an audit event. When `session` is passed the event is written in the
 * same transaction as the business change, so they commit or roll back together.
 */
async function record({ actor, actorType, action, category, targetType, targetId, sensitiveRead, outcome, reason, metadata, ip, userAgent, requestId }, { session } = {}) {
  const doc = {
    at: new Date(),
    actorId: actor?._id || actor?.id,
    actorRoles: actor?.roles,
    actorType: actorType || (actor ? (actor.roles?.some((r) => r === 'admin' || r === 'superadmin') ? 'staff' : 'user') : 'system'),
    action,
    category,
    targetType,
    targetId: targetId != null ? String(targetId) : undefined,
    sensitiveRead: Boolean(sensitiveRead),
    outcome: outcome || 'success',
    reason,
    metadata,
    ip,
    userAgent,
    requestId,
  };
  doc.contentHash = sha256(stableStringify({ ...doc, at: doc.at.toISOString(), actorId: String(doc.actorId || '') }));
  const [ev] = await AuditEvent.create([doc], { session });
  return ev;
}

const fromReq = (req, event, opts) => record({ ...ctxFrom(req), actor: event.actor || req?.user, ...event }, opts);

/** Raise (or bump) an operational alert. Also posts to ALERT_WEBHOOK_URL when configured. */
async function raiseAlert({ severity, type, message, refType, refId, dedupeKey }) {
  try {
    let alert;
    if (dedupeKey) {
      alert = await Alert.findOneAndUpdate(
        { dedupeKey, status: 'open' },
        { $inc: { occurrences: 1 }, $set: { lastOccurredAt: new Date(), message } },
        { new: true }
      );
    }
    if (!alert) {
      try {
        alert = await Alert.create({ severity, type, message, refType, refId: refId && String(refId), dedupeKey, history: [{ at: new Date(), action: 'raised' }] });
      } catch (e) {
        if (e.code === 11000) return Alert.findOne({ dedupeKey, status: 'open' });
        throw e;
      }
      if (config.ALERT_WEBHOOK_URL && severity !== 'info') {
        fetch(config.ALERT_WEBHOOK_URL, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: `[MubaPay ${config.APP_ENV}] ${severity.toUpperCase()} ${type}: ${message}` }),
          signal: AbortSignal.timeout(5000),
        }).catch((err) => logger.warn({ err: err.message }, 'alert webhook failed'));
      }
    }
    return alert;
  } catch (err) {
    logger.error({ err }, 'failed to raise alert');
    return null;
  }
}

module.exports = { record, fromReq, raiseAlert, ctxFrom };
