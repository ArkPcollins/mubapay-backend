'use strict';
/**
 * Brevo transactional email — POST https://api.brevo.com/v3/smtp/email
 * Header: api-key: <BREVO_API_KEY>. Response: { messageId }.
 *
 * EMAIL_TRANSPORT=console (development/test only) writes emails to the log
 * and an in-memory outbox instead of sending. It is rejected in production.
 * Console delivery is reported as status "sent_console", never as real delivery.
 */
const config = require('../../config');
const { request } = require('../http');
const logger = require('../../lib/logger');

const devOutbox = []; // inspected by tests / dev tooling only

async function send({ to, toName, subject, html, text, tags }) {
  if (config.EMAIL_TRANSPORT === 'disabled') return { status: 'not_configured', reason: 'EMAIL_TRANSPORT=disabled' };
  if (config.EMAIL_TRANSPORT === 'console') {
    if (config.isProduction) throw new Error('Console email transport is not permitted in production');
    devOutbox.push({ to, subject, text, html, at: new Date() });
    if (devOutbox.length > 500) devOutbox.shift();
    logger.info({ to, subject }, '[console-email] email captured (not sent)');
    return { status: 'sent_console', messageId: `console-${Date.now()}` };
  }
  if (!config.BREVO_API_KEY) return { status: 'not_configured', reason: 'BREVO_API_KEY missing' };
  const res = await request(`${config.BREVO_BASE_URL}/smtp/email`, {
    method: 'POST',
    headers: { 'api-key': config.BREVO_API_KEY },
    body: {
      sender: { email: config.EMAIL_FROM_ADDRESS, name: config.EMAIL_FROM_NAME },
      to: [{ email: to, name: toName || undefined }],
      subject,
      htmlContent: html,
      textContent: text,
      tags,
    },
    timeoutMs: 10000,
  });
  return { status: 'sent', messageId: res.messageId };
}

function status() {
  return { implemented: true, transport: config.EMAIL_TRANSPORT, configured: config.EMAIL_TRANSPORT === 'brevo' ? Boolean(config.BREVO_API_KEY) : config.EMAIL_TRANSPORT === 'console' };
}

module.exports = { send, status, devOutbox };
