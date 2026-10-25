'use strict';
/**
 * WhatsApp Business Cloud API (Meta) adapter.
 *  Send:    POST https://graph.facebook.com/{version}/{phone-number-id}/messages  (Bearer access token)
 *  Webhook: GET verification (hub.mode=subscribe, hub.verify_token, hub.challenge)
 *           POST events signed with X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(app secret, raw body)
 *
 * Business-initiated messages outside the 24h customer-service window must use
 * an approved template (e.g. the OTP "authentication" template). Conversation
 * pricing applies per Meta's WhatsApp Business pricing.
 */
const crypto = require('crypto');
const config = require('../../config');
const { request } = require('../http');
const { E } = require('../../lib/errors');

function requireConfigured() {
  if (!config.integrations.whatsapp) {
    throw E.notConfigured('WhatsApp Business', 'Set WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN, WHATSAPP_APP_SECRET and WHATSAPP_VERIFY_TOKEN. See documentation/integrations/whatsapp.md');
  }
}

const endpoint = () => `https://graph.facebook.com/${config.WHATSAPP_GRAPH_VERSION}/${config.WHATSAPP_PHONE_NUMBER_ID}/messages`;

/** Normalise Nigerian numbers to E.164 without "+" as WhatsApp expects. */
function toWaId(phone) {
  const digits = String(phone).replace(/\D/g, '');
  if (digits.startsWith('234')) return digits;
  if (digits.startsWith('0') && digits.length === 11) return `234${digits.slice(1)}`;
  return digits;
}

async function sendText(to, body) {
  requireConfigured();
  const res = await request(endpoint(), {
    method: 'POST',
    headers: { authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}` },
    body: { messaging_product: 'whatsapp', recipient_type: 'individual', to: toWaId(to), type: 'text', text: { preview_url: false, body } },
  });
  return { messageId: res.messages?.[0]?.id };
}

/** Send an OTP using an approved authentication template (code in body + copy-code button). */
async function sendOtp(to, code) {
  requireConfigured();
  if (!config.WHATSAPP_OTP_TEMPLATE) throw E.notConfigured('WhatsApp OTP template', 'Create and get approval for an authentication template, then set WHATSAPP_OTP_TEMPLATE');
  const res = await request(endpoint(), {
    method: 'POST',
    headers: { authorization: `Bearer ${config.WHATSAPP_ACCESS_TOKEN}` },
    body: {
      messaging_product: 'whatsapp',
      to: toWaId(to),
      type: 'template',
      template: {
        name: config.WHATSAPP_OTP_TEMPLATE,
        language: { code: config.WHATSAPP_OTP_TEMPLATE_LANG },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: code }] },
          { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: code }] },
        ],
      },
    },
  });
  return { messageId: res.messages?.[0]?.id };
}

function verifySignature(rawBody, header) {
  if (!config.WHATSAPP_APP_SECRET || !header || !rawBody) return false;
  const expected = `sha256=${crypto.createHmac('sha256', config.WHATSAPP_APP_SECRET).update(rawBody).digest('hex')}`;
  const a = Buffer.from(expected);
  const b = Buffer.from(String(header));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function status() {
  return { implemented: true, configured: config.integrations.whatsapp, otpTemplate: Boolean(config.WHATSAPP_OTP_TEMPLATE) };
}

module.exports = { sendText, sendOtp, verifySignature, toWaId, status, requireConfigured };
