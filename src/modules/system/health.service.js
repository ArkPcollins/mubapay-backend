'use strict';
const { mongoose } = require('../../lib/db');
const infra = require('../../infra');
const config = require('../../config');
const metrics = require('../../lib/metrics');
const paystack = require('../../providers/paystack/paystack.adapter');
const brevo = require('../../providers/email/brevo.adapter');
const cloudinary = require('../../providers/media/cloudinary.adapter');
const whatsapp = require('../../providers/whatsapp/whatsapp.adapter');
const nominatim = require('../../providers/geocoding/nominatim.adapter');
const shipbubble = require('../../providers/logistics/shipbubble.adapter');

async function db() {
  try {
    const t0 = Date.now();
    await mongoose.connection.db.admin().command({ ping: 1 });
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    return { status: 'ok', latencyMs: Date.now() - t0, replicaSet: hello.setName || null, transactions: Boolean(hello.setName) };
  } catch (e) {
    return { status: 'down', error: 'unreachable' };
  }
}

/** Public liveness: no sensitive detail. */
function live() {
  return { status: 'ok', service: 'mubapay-api', variant: infra.name };
}

/** Readiness: database must be reachable; reports degraded components without internals. */
async function ready() {
  const d = await db();
  const inf = await infra.health().catch(() => ({}));
  const degraded = Object.entries(inf).filter(([, v]) => v.status && !['ok', 'not_used', 'idle'].includes(v.status)).map(([k]) => k);
  return { status: d.status === 'ok' ? (degraded.length ? 'degraded' : 'ok') : 'down', database: d.status, degraded };
}

/**
 * "Implemented / configured / connected / tested / live-verified" are distinct.
 * This endpoint can only state implemented + configured (+ mode). Connectivity
 * and live verification are recorded in the acceptance report after real tests.
 */
function integrations() {
  return {
    paystack: paystack.status(),
    brevo: brevo.status(),
    cloudinary: cloudinary.status(),
    whatsapp: whatsapp.status(),
    geocoding: nominatim.status(),
    shipbubble: { implemented: true, configured: shipbubble.isConfigured() },
    configuredRateDelivery: { implemented: true, configured: true },
    google: { implemented: true, configured: config.integrations.google },
    redis: { used: infra.name === 'with-redis', configured: config.integrations.redis },
    note: 'configured = credentials present. It does NOT mean connected, tested, or live-verified.',
  };
}

async function detailed() {
  return { variant: infra.name, env: config.APP_ENV, database: await db(), infrastructure: await infra.health(), integrations: integrations(), metrics: metrics.snapshot(), node: process.version };
}

module.exports = { live, ready, detailed, integrations, db };
