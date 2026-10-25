'use strict';
/**
 * Central configuration. Reads process.env once, validates it, and exposes a
 * frozen object. Server-only secrets live here and are never sent to clients.
 *
 * Environment separation rules (enforced at boot):
 *  - APP_ENV=development  → live provider keys are rejected.
 *  - APP_ENV=staging      → live provider keys are rejected.
 *  - APP_ENV=production   → test provider keys are rejected; strong secrets required.
 */
const { z } = require('zod');

const bool = (def) =>
  z
    .union([z.boolean(), z.string()])
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : v === true || v === 'true' || v === '1'));

const optStr = z
  .string()
  .optional()
  .transform((v) => (v && v.trim() !== '' ? v.trim() : undefined));

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  APP_ENV: z.enum(['development', 'staging', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  API_PUBLIC_URL: z.string().default('http://localhost:4000'),
  FRONTEND_URL: z.string().default('http://localhost:5173'),
  CORS_ORIGINS: optStr,
  TRUST_PROXY: z.coerce.number().int().default(0),
  MONGODB_URI: z.string().default('mongodb://127.0.0.1:27017/mubapay?replicaSet=rs0'),
  REDIS_URL: optStr,
  JWT_ACCESS_SECRET: z.string().default('dev-access-secret-change-me-dev-access-secret'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().default(30),
  COOKIE_DOMAIN: optStr,
  COOKIE_SECURE: bool(false),
  COOKIE_SAMESITE: z.enum(['lax', 'strict', 'none']).default('lax'),
  DATA_ENCRYPTION_KEY: z.string().default('ZGV2LWRhdGEta2V5LWNoYW5nZS1tZS0zMmJ5dGVzISE='),
  PRIVATE_STORAGE_DIR: z.string().default('./private-storage'),
  DOWNLOAD_TOKEN_TTL_SECONDS: z.coerce.number().int().default(120),
  GOOGLE_CLIENT_ID: optStr,
  PAYSTACK_MODE: z.enum(['test', 'live']).default('test'),
  PAYSTACK_SECRET_KEY: optStr,
  PAYSTACK_PUBLIC_KEY: optStr,
  PAYSTACK_BASE_URL: z.string().default('https://api.paystack.co'),
  PAYSTACK_TRANSFERS_ENABLED: bool(false),
  EMAIL_TRANSPORT: z.enum(['brevo', 'console', 'disabled']).default('brevo'),
  BREVO_API_KEY: optStr,
  BREVO_BASE_URL: z.string().default('https://api.brevo.com/v3'),
  BREVO_INBOUND_SECRET: optStr,
  EMAIL_FROM_ADDRESS: z.string().default('no-reply@example.com'),
  EMAIL_FROM_NAME: z.string().default('MubaPay'),
  SUPPORT_EMAIL: z.string().default('support@example.com'),
  CLOUDINARY_CLOUD_NAME: optStr,
  CLOUDINARY_API_KEY: optStr,
  CLOUDINARY_API_SECRET: optStr,
  CLOUDINARY_FOLDER: z.string().default('mubapay'),
  SHIPBUBBLE_API_KEY: optStr,
  SHIPBUBBLE_BASE_URL: z.string().default('https://api.shipbubble.com'),
  SHIPBUBBLE_SENDER_ADDRESS_CODE: optStr,
  SHIPBUBBLE_DEFAULT_CATEGORY_ID: optStr,
  NOMINATIM_BASE_URL: z.string().default('https://nominatim.openstreetmap.org'),
  NOMINATIM_USER_AGENT: optStr,
  NOMINATIM_EMAIL: optStr,
  WHATSAPP_GRAPH_VERSION: z.string().default('v21.0'),
  WHATSAPP_PHONE_NUMBER_ID: optStr,
  WHATSAPP_ACCESS_TOKEN: optStr,
  WHATSAPP_APP_SECRET: optStr,
  WHATSAPP_VERIFY_TOKEN: optStr,
  WHATSAPP_OTP_TEMPLATE: optStr,
  WHATSAPP_OTP_TEMPLATE_LANG: z.string().default('en'),
  PHONE_OTP_TRANSPORT: z.enum(['whatsapp', 'console', 'disabled']).default('whatsapp'),
  ALERT_WEBHOOK_URL: optStr,
  LOG_LEVEL: z.string().default('info'),
  RUN_WORKER_IN_PROCESS: bool(true),
  RUN_SCHEDULER: bool(true),
  ENABLE_SEED_DATA: bool(false),
  HEALTH_DETAILS_TOKEN: optStr,
});

function load(env = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const c = parsed.data;
  const errors = [];
  const isProd = c.APP_ENV === 'production';
  const isNonProd = !isProd;

  // ---- Environment separation for provider credentials ----
  if (c.PAYSTACK_SECRET_KEY) {
    const live = c.PAYSTACK_SECRET_KEY.startsWith('sk_live_');
    const test = c.PAYSTACK_SECRET_KEY.startsWith('sk_test_');
    if (!live && !test) errors.push('PAYSTACK_SECRET_KEY must start with sk_test_ or sk_live_');
    if (isNonProd && live) errors.push(`Live Paystack key is not allowed when APP_ENV=${c.APP_ENV}`);
    if (isProd && c.PAYSTACK_MODE === 'live' && test) errors.push('PAYSTACK_MODE=live but a test key was supplied');
    if (isProd && c.PAYSTACK_MODE === 'test') errors.push('APP_ENV=production requires PAYSTACK_MODE=live (use staging for test keys)');
    if (c.PAYSTACK_MODE === 'test' && live) errors.push('PAYSTACK_MODE=test but a live key was supplied');
  }
  if (c.SHIPBUBBLE_API_KEY) {
    const live = c.SHIPBUBBLE_API_KEY.startsWith('sb_prod');
    if (isNonProd && live) errors.push(`Live Shipbubble key is not allowed when APP_ENV=${c.APP_ENV}`);
    if (isProd && c.SHIPBUBBLE_API_KEY.startsWith('sb_sandbox')) errors.push('Sandbox Shipbubble key supplied in production');
  }
  if (isProd) {
    if (c.JWT_ACCESS_SECRET.length < 32 || c.JWT_ACCESS_SECRET.startsWith('dev-')) errors.push('JWT_ACCESS_SECRET must be a strong secret (>=32 chars) in production');
    if (c.DATA_ENCRYPTION_KEY === 'ZGV2LWRhdGEta2V5LWNoYW5nZS1tZS0zMmJ5dGVzISE=') errors.push('DATA_ENCRYPTION_KEY must be replaced in production');
    if (!c.COOKIE_SECURE) errors.push('COOKIE_SECURE must be true in production');
    if (c.EMAIL_TRANSPORT === 'console') errors.push('EMAIL_TRANSPORT=console is not allowed in production');
    if (c.PHONE_OTP_TRANSPORT === 'console') errors.push('PHONE_OTP_TRANSPORT=console is not allowed in production');
    if (c.ENABLE_SEED_DATA) errors.push('ENABLE_SEED_DATA must be false in production');
  }
  const keyBuf = Buffer.from(c.DATA_ENCRYPTION_KEY, 'base64');
  if (keyBuf.length !== 32) errors.push('DATA_ENCRYPTION_KEY must be 32 bytes, base64-encoded');
  if (errors.length) throw new Error(`Configuration rejected: ${errors.join('; ')}`);

  const corsOrigins = (c.CORS_ORIGINS || c.FRONTEND_URL).split(',').map((s) => s.trim()).filter(Boolean);

  return Object.freeze({
    ...c,
    isProduction: isProd,
    isTest: c.APP_ENV === 'test',
    corsOrigins,
    encryptionKey: keyBuf,
    integrations: Object.freeze({
      google: Boolean(c.GOOGLE_CLIENT_ID),
      paystack: Boolean(c.PAYSTACK_SECRET_KEY),
      paystackTransfers: Boolean(c.PAYSTACK_SECRET_KEY) && c.PAYSTACK_TRANSFERS_ENABLED,
      brevo: c.EMAIL_TRANSPORT === 'brevo' && Boolean(c.BREVO_API_KEY),
      cloudinary: Boolean(c.CLOUDINARY_CLOUD_NAME && c.CLOUDINARY_API_KEY && c.CLOUDINARY_API_SECRET),
      shipbubble: Boolean(c.SHIPBUBBLE_API_KEY),
      nominatim: Boolean(c.NOMINATIM_USER_AGENT),
      whatsapp: Boolean(c.WHATSAPP_PHONE_NUMBER_ID && c.WHATSAPP_ACCESS_TOKEN),
      redis: Boolean(c.REDIS_URL),
    }),
  });
}

let current = load();

module.exports = new Proxy(
  {},
  {
    get(_t, prop) {
      if (prop === '__reload') return (env) => (current = load(env || process.env));
      if (prop === '__load') return load;
      return current[prop];
    },
    has(_t, prop) {
      return prop in current;
    },
    ownKeys() {
      return Reflect.ownKeys(current);
    },
    getOwnPropertyDescriptor(_t, prop) {
      return Object.getOwnPropertyDescriptor(current, prop);
    },
  }
);
