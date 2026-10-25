'use strict';
const express = require('express');
const { sha256 } = require('../../lib/crypto');
const paystack = require('../../providers/paystack/paystack.adapter');
const shipbubble = require('../../providers/logistics/shipbubble.adapter');
const whatsapp = require('../../providers/whatsapp/whatsapp.adapter');
const webhooks = require('./webhooks.service');
const audit = require('../audit/audit.service');
const config = require('../../config');
const logger = require('../../lib/logger');

const router = express.Router();
// Raw body is required for signature verification.
const raw = express.raw({ type: '*/*', limit: '1mb' });

async function rejectUnsigned(req, res, provider) {
  logger.warn({ provider, ip: req.ip }, 'webhook signature invalid');
  await audit.record({ actorType: 'provider', action: 'webhook.signature_invalid', category: 'security', outcome: 'denied', metadata: { provider }, ip: req.ip, requestId: req.id });
  await audit.raiseAlert({ severity: 'warning', type: 'webhook.invalid_signature', message: `Invalid ${provider} webhook signature from ${req.ip}`, dedupeKey: `bad_sig:${provider}` });
  return res.status(401).json({ success: false });
}

router.post('/paystack', raw, async (req, res, next) => {
  try {
    const body = req.body instanceof Buffer ? req.body : Buffer.from('');
    if (!paystack.verifyWebhookSignature(body, req.get('x-paystack-signature'))) return rejectUnsigned(req, res, 'paystack');
    const payload = JSON.parse(body.toString('utf8'));
    const d = payload.data || {};
    const eventKey = sha256(`${payload.event}|${d.id ?? ''}|${d.reference ?? ''}|${d.status ?? ''}`);
    const r = await webhooks.ingest('paystack', { eventKey, eventType: payload.event, reference: d.reference, payload: { event: payload.event, data: { id: d.id, reference: d.reference, status: d.status, amount: d.amount, currency: d.currency, transfer_code: d.transfer_code } }, rawBody: body });
    res.status(200).json({ received: true, duplicate: r.duplicate });
  } catch (err) {
    next(err);
  }
});

router.post('/shipbubble', raw, async (req, res, next) => {
  try {
    const body = req.body instanceof Buffer ? req.body : Buffer.from('');
    if (!shipbubble.verifyWebhookSignature(body, req.get('x-ship-signature'))) return rejectUnsigned(req, res, 'shipbubble');
    const payload = JSON.parse(body.toString('utf8'));
    const eventKey = sha256(`${payload.event}|${payload.order_id}|${payload.status}|${payload.date || ''}|${(payload.package_status || []).length}`);
    const r = await webhooks.ingest('shipbubble', { eventKey, eventType: payload.event, reference: payload.order_id, payload, rawBody: body });
    res.status(200).json({ received: true, duplicate: r.duplicate });
  } catch (err) {
    next(err);
  }
});

// WhatsApp verification handshake
router.get('/whatsapp', (req, res) => {
  if (!config.WHATSAPP_VERIFY_TOKEN) return res.status(503).send('not configured');
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === config.WHATSAPP_VERIFY_TOKEN) return res.status(200).send(String(req.query['hub.challenge']));
  return res.sendStatus(403);
});

router.post('/whatsapp', raw, async (req, res, next) => {
  try {
    const body = req.body instanceof Buffer ? req.body : Buffer.from('');
    if (!whatsapp.verifySignature(body, req.get('x-hub-signature-256'))) return rejectUnsigned(req, res, 'whatsapp');
    const payload = JSON.parse(body.toString('utf8'));
    const messages = [];
    for (const entry of payload.entry || []) for (const ch of entry.changes || []) for (const m of ch.value?.messages || []) messages.push({ ...m, contacts: ch.value.contacts });
    for (const m of messages) {
      // eslint-disable-next-line no-await-in-loop
      await webhooks.ingest('whatsapp', { eventKey: `msg:${m.id}`, eventType: 'message', reference: m.from, payload: m, rawBody: Buffer.from(JSON.stringify(m)) });
    }
    res.sendStatus(200);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
