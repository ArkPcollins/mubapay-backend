'use strict';
/**
 * Inbound webhook pipeline (all providers):
 *  1. verify signature on the RAW body (reject unsigned/invalid)
 *  2. persist ProviderEvent with a unique eventKey (duplicate → counted & acknowledged)
 *  3. acknowledge 200 quickly
 *  4. process asynchronously (queue) — handlers re-verify with provider APIs and
 *     apply forward-only state transitions, so duplicates and out-of-order
 *     deliveries cannot double-credit or regress state
 *  5. a durable sweeper re-processes any event left in "received"/"failed"
 */
const { ProviderEvent } = require('../payments/payment.models');
const { sha256 } = require('../../lib/crypto');
const infra = require('../../infra');
const logger = require('../../lib/logger');
const audit = require('../audit/audit.service');

const processors = new Map(); // provider -> async (event) => result
function registerProcessor(provider, fn) {
  processors.set(provider, fn);
}

async function ingest(provider, { eventKey, eventType, reference, payload, rawBody }) {
  const payloadHash = sha256(rawBody || JSON.stringify(payload));
  try {
    const ev = await ProviderEvent.create({ provider, eventKey, eventType, reference, payload, payloadHash, signatureValid: true });
    await infra.queue.add('webhook.process', { id: String(ev._id) }, { jobId: `webhook:${ev._id}`, attempts: 8, backoffMs: 15000 }).catch((err) => logger.warn({ err: err.message }, 'webhook enqueue failed; sweeper will process'));
    return { duplicate: false, id: String(ev._id) };
  } catch (err) {
    if (err.code !== 11000) throw err;
    await ProviderEvent.updateOne({ provider, eventKey }, { $inc: { receivedCount: 1 } });
    return { duplicate: true };
  }
}

async function processEvent(id) {
  const ev = await ProviderEvent.findOneAndUpdate(
    { _id: id, $or: [{ status: { $in: ['received', 'failed'] } }, { status: 'processing', updatedAt: { $lt: new Date(Date.now() - 5 * 60e3) } }], attempts: { $lt: 12 } },
    { $set: { status: 'processing' }, $inc: { attempts: 1 } },
    { new: true }
  );
  if (!ev) return { skipped: true };
  const fn = processors.get(ev.provider);
  try {
    const r = fn ? await fn(ev) : { ignored: true };
    await ProviderEvent.updateOne({ _id: ev._id }, { $set: { status: r?.ignored ? 'ignored' : 'processed', processedAt: new Date(), error: r?.reason } });
    return r;
  } catch (err) {
    await ProviderEvent.updateOne({ _id: ev._id }, { $set: { status: 'failed', error: String(err.message).slice(0, 500) } });
    if (ev.attempts >= 6) await audit.raiseAlert({ severity: 'critical', type: 'webhook.processing_failed', message: `${ev.provider} webhook ${ev.eventType} (${ev.reference}) failed ${ev.attempts} times: ${err.message}`, refType: 'provider_event', refId: ev._id, dedupeKey: `webhook_fail:${ev._id}` });
    throw err;
  }
}

async function sweep(limit = 100) {
  const due = await ProviderEvent.find({ $or: [{ status: 'received', createdAt: { $lt: new Date(Date.now() - 60e3) } }, { status: 'failed', attempts: { $lt: 12 }, updatedAt: { $lt: new Date(Date.now() - 2 * 60e3) } }, { status: 'processing', updatedAt: { $lt: new Date(Date.now() - 5 * 60e3) } }] }, { _id: 1 }).limit(limit).lean();
  let ok = 0;
  for (const d of due) {
    // eslint-disable-next-line no-await-in-loop
    await processEvent(d._id).then(() => (ok += 1)).catch(() => {});
  }
  return { due: due.length, ok };
}

/** Raise an alert if no Paystack webhooks arrived in a long time while payments are flowing. */
async function checkWebhookFreshness() {
  const { PaymentAttempt } = require('../payments/payment.models');
  const recentPayments = await PaymentAttempt.countDocuments({ status: 'success', updatedAt: { $gt: new Date(Date.now() - 6 * 3600e3) } });
  const recentEvents = await ProviderEvent.countDocuments({ provider: 'paystack', createdAt: { $gt: new Date(Date.now() - 6 * 3600e3) } });
  if (recentPayments >= 3 && recentEvents === 0) {
    await audit.raiseAlert({ severity: 'warning', type: 'webhook.silence', message: 'Payments are confirming via polling but no Paystack webhooks were received in 6 hours — check webhook URL configuration', dedupeKey: 'paystack_webhook_silence' });
  }
  return { recentPayments, recentEvents };
}

module.exports = { registerProcessor, ingest, processEvent, sweep, checkWebhookFreshness };
