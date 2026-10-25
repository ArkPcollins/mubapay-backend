'use strict';
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const pinoHttp = require('pino-http');
const config = require('./config');
const logger = require('./lib/logger');
const metrics = require('./lib/metrics');
const { requestId, csrf, maintenance, errorHandler, notFound, limiter } = require('./middleware/common');
const { optionalAuth } = require('./middleware/auth');
const { asyncHandler: h, ok } = require('./lib/http');
const health = require('./modules/system/health.service');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.TRUST_PROXY);

  app.use(requestId);
  app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } }, crossOriginResourcePolicy: { policy: 'same-site' } }));
  app.use(cors({ origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)), credentials: true, allowedHeaders: ['content-type', 'x-csrf-token', 'idempotency-key', 'authorization', 'x-request-id', 'x-client'], exposedHeaders: ['x-request-id', 'idempotent-replayed'] }));
  app.use(metrics.middleware);
  app.use(pinoHttp({ logger, genReqId: (req) => req.id, autoLogging: { ignore: (req) => req.url.startsWith('/health') }, customProps: (req) => ({ userId: req.user?._id && String(req.user._id) }), serializers: { req: (r) => ({ id: r.id, method: r.method, url: r.url.split('?')[0] }), res: (r) => ({ statusCode: r.statusCode }) } }));

  // Health (no sensitive details publicly)
  app.get('/health/live', (_req, res) => res.json(health.live()));
  app.get('/health/ready', h(async (_req, res) => {
    const r = await health.ready();
    res.status(r.status === 'down' ? 503 : 200).json(r);
  }));

  // Provider webhooks need the raw body and are exempt from CSRF/maintenance.
  app.use('/api/v1/webhooks', limiter({ name: 'webhooks', windowMs: 60e3, max: 600 }), require('./modules/webhooks/webhooks.routes'));

  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '100kb' }));
  app.use(cookieParser());
  app.use(csrf);
  app.use('/api', limiter({ name: 'global', windowMs: 60e3, max: 300, message: 'Too many requests from your network' }));
  app.use(optionalAuth);
  app.use(maintenance);

  const v1 = express.Router();
  v1.get('/health', h(async (_req, res) => ok(res, await health.ready())));
  v1.get('/meta', h(async (_req, res) => {
    const settings = require('./modules/settings/settings.service');
    const [branding, delivery, flags, maintenanceCfg] = await Promise.all([settings.get('branding'), settings.get('delivery'), settings.listFlags(), settings.get('maintenance')]);
    ok(res, {
      branding, coverageStates: delivery.coverageStates, collectionPoints: delivery.collectionPoints, maintenance: maintenanceCfg,
      features: Object.fromEntries(Object.values(flags).map((f) => [f.key, f.enabled])),
      integrations: { googleSignIn: Boolean(config.GOOGLE_CLIENT_ID), googleClientId: config.GOOGLE_CLIENT_ID || null, paystack: config.integrations.paystack, paystackPublicKey: config.PAYSTACK_PUBLIC_KEY || null, cloudinary: config.integrations.cloudinary, geocoding: config.integrations.nominatim, whatsappSupport: config.integrations.whatsapp },
      environment: config.APP_ENV,
    });
  }));
  v1.use('/auth', require('./modules/auth/auth.routes'));
  v1.use('/account', require('./modules/users/account.routes'));
  v1.use('/wallet', require('./modules/wallet/wallet.routes'));
  v1.use('/savings', require('./modules/savings/savings.routes'));
  v1.use('/marketplace', require('./modules/marketplace/marketplace.routes'));
  v1.use('/realestate', require('./modules/realestate/realestate.routes'));
  const eng = require('./modules/engagement.routes');
  v1.use('/legal', eng.legal);
  v1.use('/messages', eng.msg);
  v1.use('/notifications', eng.notif);
  v1.use('/support', eng.sup);
  v1.use('/admin', require('./modules/admin/admin.routes'));
  v1.use('/seo', require('./modules/seo/seo.routes'));
  app.use('/api/v1', v1);

  app.use(notFound);
  app.use(errorHandler);
  return app;
}

module.exports = { createApp };
