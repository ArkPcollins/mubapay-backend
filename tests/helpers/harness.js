'use strict';
/**
 * Test harness: boots the real app against the test replica set, applies
 * migrations, and provides helpers to create users, sessions and data.
 */
const request = require('supertest');
const { authenticator } = require('otplib');
const db = require('../../src/lib/db');
const { bootstrap } = require('../../src/bootstrap');
const { createApp } = require('../../src/app');
const jobs = require('../../src/jobs');
const { User } = require('../../src/modules/users/user.model');
const auth = require('../../src/modules/auth/auth.service');
const ledger = require('../../src/modules/ledger/ledger.service');
const { LegalDocument, ConsentRecord } = require('../../src/modules/legal/legal.models');
const { encryptString } = require('../../src/lib/crypto');
const { ADMIN_PRESETS } = require('../../src/modules/rbac/permissions');
const { FakePaystack } = require('./fakePaystack');

let app;
let counter = 0;

async function start() {
  await bootstrap();
  const migrate = require('../../scripts/migrate');
  for (const m of migrate.list()) await m.up({ mongoose: db.mongoose });
  if (!globalThis.__jobsRegistered) {
    jobs.register();
    globalThis.__jobsRegistered = true;
  }
  app = createApp();
  return app;
}

async function stop() {
  await require('../../src/infra').shutdown().catch(() => {});
  await db.mongoose.connection.dropDatabase().catch(() => {});
  await db.disconnect();
}

const api = () => request(app);

async function acceptAllPolicies(userId) {
  const docs = await LegalDocument.find({ status: 'published' }).lean();
  await ConsentRecord.insertMany(docs.map((d) => ({ userId, kind: 'policy_acceptance', documentSlug: d.slug, documentVersion: d.version, context: 'test' })));
}

/** Create a user directly. tier: 0 (email only), 1 (email+phone), 2 (KYC approved). */
async function createUser({ tier = 2, roles = ['customer'], capabilities = {}, permissions = [], staff = false, email, firstName = 'Test', lastName = 'User', password = 'Password-123!', state = 'Anambra' } = {}) {
  counter += 1;
  const e = email || `user${counter}_${Date.now()}@test.local`;
  const totpSecret = staff ? authenticator.generateSecret(20) : undefined;
  const u = await User.create({
    email: e, passwordHash: await auth.hashPassword(password), firstName, lastName, roles, capabilities, staffPermissions: permissions,
    emailVerifiedAt: new Date(), phone: tier >= 1 ? `+2348${String(require('crypto').randomInt(0, 999999999)).padStart(9, '0')}` : undefined, phoneVerifiedAt: tier >= 1 ? new Date() : undefined,
    kycStatus: tier >= 2 ? 'approved' : 'none', verificationTier: tier, security: { passwordChangedAt: new Date(Date.now() - 60000) },
    addresses: [{ label: 'Home', recipientName: `${firstName} ${lastName}`, phone: '08030000000', line1: '1 Test Street', city: 'Awka', state, isDefault: true }],
    ...(staff ? { twoFactor: { enabled: true, secretEnc: encryptString(totpSecret), enabledAt: new Date() } } : {}),
  });
  await ledger.ensureUserAccounts(u._id);
  await acceptAllPolicies(u._id);
  const session = await auth.createSession(u, { ip: '127.0.0.1', userAgent: 'jest', twoFactorVerified: staff });
  return { user: u, token: session.accessToken, totpSecret, password, email: e };
}

const staffUser = (preset, extra = {}) => createUser({ roles: ['admin'], permissions: Array.isArray(preset) ? preset : ADMIN_PRESETS[preset], staff: true, ...extra });
const superadmin = (extra = {}) => createUser({ roles: ['superadmin'], staff: true, ...extra });

/** Authenticated request helpers (Bearer token → CSRF-exempt). */
function as(actor) {
  const t = actor.token;
  const wrap = (method) => (url) => api()[method](url).set('Authorization', `Bearer ${t}`);
  return { get: wrap('get'), post: wrap('post'), put: wrap('put'), patch: wrap('patch'), delete: wrap('delete') };
}

let keyN = 0;
const idem = () => `test-key-${Date.now()}-${(keyN += 1)}`;

/** Credit a wallet through the real funding pipeline (fake Paystack). */
async function fundWallet(actor, fake, amountKobo) {
  const r = await as(actor).post('/api/v1/wallet/fund').set('Idempotency-Key', idem()).send({ amountKobo });
  if (r.status !== 201) throw new Error(`fund failed: ${r.status} ${JSON.stringify(r.body)}`);
  fake.pay(r.body.data.reference, { amount: amountKobo, fees: 0 });
  const payments = require('../../src/modules/payments/payments.service');
  await payments.verifyAndFulfil(r.body.data.reference, { source: 'test' });
  return r.body.data.reference;
}

async function walletBalance(userId) {
  return ledger.getBalance(ledger.userCodes(userId).wallet);
}

function fakePaystack() {
  return new FakePaystack().install();
}

/** Install fake Paystack + Shipbubble behind one fetch router. */
function fakeProviders() {
  const { FakeShipbubble } = require('./fakeShipbubble');
  const paystack = new FakePaystack();
  const shipbubble = new FakeShipbubble();
  globalThis.__providerFetch = (url, opts) => (String(url).includes('shipbubble') ? shipbubble.handle(url, opts) : paystack.handle(url, opts));
  return { paystack, shipbubble, uninstall: () => delete globalThis.__providerFetch };
}

/** Run all due background work synchronously (what the scheduler would do). */
async function runJobs(...names) {
  const infra = require('../../src/infra');
  const queue = infra.queue;
  const results = {};
  for (const n of names) {
    const fn = require('../../src/jobs').__handlers?.[n];
    results[n] = fn ? await fn() : undefined;
  }
  return { results, queue };
}

module.exports = { start, stop, api, as, createUser, staffUser, superadmin, idem, fundWallet, walletBalance, fakePaystack, fakeProviders, runJobs, acceptAllPolicies, authenticator };
