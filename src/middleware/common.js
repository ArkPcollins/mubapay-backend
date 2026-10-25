'use strict';
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const config = require('../config');
const { E, AppError } = require('../lib/errors');
const logger = require('../lib/logger');
const infra = require('../infra');
const settings = require('../modules/settings/settings.service');
const { IdempotencyRecord } = require('../modules/payments/payment.models');
const { sha256, stableStringify, safeEqual } = require('../lib/crypto');

const CSRF_COOKIE = 'mp_csrf';

/** Request id for tracing (accepts a sane inbound X-Request-Id). */
function requestId(req, res, next) {
  const inbound = req.get('x-request-id');
  req.id = inbound && /^[A-Za-z0-9._-]{8,64}$/.test(inbound) ? inbound : crypto.randomUUID();
  res.set('X-Request-Id', req.id);
  next();
}

/**
 * Double-submit CSRF protection for cookie-authenticated, state-changing
 * requests. Bearer-token clients are not vulnerable to CSRF and are exempt.
 * Webhooks are mounted before this middleware.
 */
function csrf(req, res, next) {
  if (!req.cookies?.[CSRF_COOKIE]) {
    res.cookie(CSRF_COOKIE, crypto.randomBytes(24).toString('base64url'), {
      httpOnly: false, secure: config.COOKIE_SECURE, sameSite: config.COOKIE_SAMESITE, domain: config.COOKIE_DOMAIN, path: '/',
    });
  }
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('authorization')?.startsWith('Bearer ')) return next();
  const hasSessionCookie = req.cookies?.mp_at || req.cookies?.mp_rt;
  if (!hasSessionCookie) return next();
  const header = req.get('x-csrf-token');
  const cookie = req.cookies?.[CSRF_COOKIE];
  if (!header || !cookie || !safeEqual(header, cookie)) return next(new AppError(403, 'CSRF_FAILED', 'Security token missing or invalid. Refresh the page and try again.'));
  next();
}

/** Rate limiter factory using the variant's shared store. */
function limiter({ name, windowMs, max, keyBy = 'ip', message }) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store: config.isTest && !process.env.TEST_RATE_LIMITS ? undefined : infra.rateLimitStore(name),
    keyGenerator: (req) => (keyBy === 'user' && req.user ? `u:${req.user._id}` : `ip:${req.ip}`),
    skip: () => config.isTest && !process.env.TEST_RATE_LIMITS,
    handler: (_req, _res, next) => next(E.tooMany(message)),
  });
}

/**
 * Maintenance mode blocks customer-initiated writes only. Webhooks,
 * reconciliation, background jobs, health checks, auth refresh/logout and
 * staff operations continue, so in-flight financial processing is never cut off.
 */
async function maintenance(req, _res, next) {
  try {
    const m = await settings.get('maintenance');
    if (!m.enabled) return next();
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const p = req.originalUrl;
    if (p.startsWith('/api/v1/webhooks') || p.startsWith('/api/v1/auth/refresh') || p.startsWith('/api/v1/auth/logout') || p.startsWith('/api/v1/auth/login') || p.startsWith('/api/v1/admin') || p.startsWith('/api/v1/auth/2fa')) return next();
    if (req.user?.isStaff()) return next();
    return next(E.maintenance());
  } catch (err) {
    next(err);
  }
}

/**
 * Idempotency for financial POSTs. Requires header Idempotency-Key (8-100 chars).
 *  - same key + same body + completed → stored response replayed
 *  - same key + different body        → 422
 *  - same key while in progress        → 409
 * The key is also passed to services to derive deterministic ledger references,
 * so even a lost idempotency record cannot cause double posting.
 */
function idempotent(scope, { required = true } = {}) {
  return async (req, res, next) => {
    try {
      const key = req.get('idempotency-key');
      if (!key) {
        if (required) return next(E.badRequest('Idempotency-Key header is required for this operation'));
        return next();
      }
      if (!/^[A-Za-z0-9_-]{8,100}$/.test(key)) return next(E.badRequest('Idempotency-Key must be 8-100 characters [A-Za-z0-9_-]'));
      const requestHash = sha256(stableStringify({ body: req.body || {}, params: req.params || {} }));
      const userId = req.user._id;
      const base = { key, userId, scope };
      let rec;
      try {
        rec = await IdempotencyRecord.create({ ...base, requestHash, state: 'in_progress', lockedUntil: new Date(Date.now() + 60000), expiresAt: new Date(Date.now() + 48 * 3600e3) });
      } catch (err) {
        if (err.code !== 11000) throw err;
        const existing = await IdempotencyRecord.findOne(base);
        if (existing.requestHash !== requestHash) return next(new AppError(422, 'IDEMPOTENCY_KEY_REUSED', 'This Idempotency-Key was already used with a different request'));
        if (existing.state === 'completed') {
          res.set('Idempotent-Replayed', 'true');
          return res.status(existing.responseStatus).json(existing.responseBody);
        }
        // in_progress or failed: take over only if the lock expired (or previous attempt failed)
        rec = await IdempotencyRecord.findOneAndUpdate(
          { ...base, $or: [{ state: 'failed' }, { state: 'in_progress', lockedUntil: { $lt: new Date() } }] },
          { $set: { state: 'in_progress', lockedUntil: new Date(Date.now() + 60000) } },
          { new: true }
        );
        if (!rec) return next(new AppError(409, 'REQUEST_IN_PROGRESS', 'An identical request is already being processed'));
      }
      req.idempotencyKey = key;
      const origJson = res.json.bind(res);
      res.json = (body) => {
        const status = res.statusCode;
        const done = status < 500 && status !== 429
          ? IdempotencyRecord.updateOne({ _id: rec._id }, { $set: { state: 'completed', responseStatus: status, responseBody: body, lockedUntil: null } })
          : IdempotencyRecord.updateOne({ _id: rec._id }, { $set: { state: 'failed', lockedUntil: null } });
        done.catch((err) => logger.error({ err }, 'idempotency record update failed'));
        return origJson(body);
      };
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** Centralised error handler with safe messages. */
// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    if (err.status >= 500) logger.warn({ reqId: req.id, code: err.code, msg: err.message }, 'app error');
    return res.status(err.status).json({ success: false, error: { code: err.code, message: err.message, details: err.details }, requestId: req.id });
  }
  if (err?.type === 'entity.too.large') return res.status(413).json({ success: false, error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large' }, requestId: req.id });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ success: false, error: { code: 'BAD_JSON', message: 'Malformed JSON body' }, requestId: req.id });
  if (err?.name === 'CastError') return res.status(400).json({ success: false, error: { code: 'BAD_ID', message: 'Invalid identifier' }, requestId: req.id });
  if (err?.name === 'ValidationError') {
    return res.status(422).json({ success: false, error: { code: 'VALIDATION_ERROR', message: 'Some fields are invalid', details: Object.values(err.errors || {}).map((e) => ({ path: e.path, message: e.message })) }, requestId: req.id });
  }
  if (err?.name === 'MulterError') return res.status(400).json({ success: false, error: { code: 'UPLOAD_ERROR', message: err.message }, requestId: req.id });
  logger.error({ err, reqId: req.id, path: req.originalUrl }, 'unhandled error');
  return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Something went wrong. Please try again or contact support with the request ID.' }, requestId: req.id });
}

function notFound(req, res) {
  res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Route not found' }, requestId: req.id });
}

module.exports = { requestId, csrf, limiter, maintenance, idempotent, errorHandler, notFound, CSRF_COOKIE };
