'use strict';
const request = require('supertest');
const H = require('../helpers/harness');
const email = require('../../src/providers/email/brevo.adapter');
const authService = require('../../src/modules/auth/auth.service');
const { Notification } = require('../../src/modules/notifications/notification.model');
const notificationsSvc = require('../../src/modules/notifications/notifications.service');
const { User } = require('../../src/modules/users/user.model');
const { Session } = require('../../src/modules/auth/auth.models');
const { LegalDocument } = require('../../src/modules/legal/legal.models');
const { AuditEvent } = require('../../src/modules/audit/audit.model');

let app;
let policies;
beforeAll(async () => {
  app = await H.start();
  policies = (await LegalDocument.find({ slug: { $in: ['terms_of_service', 'privacy_policy'] }, status: 'published' }).lean()).map((d) => ({ slug: d.slug, version: d.version }));
});
afterAll(H.stop);

/** Browser-like agent: cookies + double-submit CSRF header. */
async function browser() {
  const agent = request.agent(app);
  const r = await agent.get('/api/v1/health');
  const csrf = (r.headers['set-cookie'] || []).find((c) => c.startsWith('mp_csrf=')).split(';')[0].split('=')[1];
  const wrap = (m) => (url) => agent[m](url).set('x-csrf-token', csrf);
  return { agent, csrf, get: (u) => agent.get(u), post: wrap('post'), patch: wrap('patch'), delete: wrap('delete') };
}

async function lastEmailToken(to, template) {
  await notificationsSvc.sweepPendingEmails();
  const n = await Notification.findOne({ 'email.to': to, 'email.template': template }).sort({ createdAt: -1 }).lean();
  return n?.data?.token;
}

describe('registration, verification, login, refresh, reset', () => {
  const addr = `new_${Date.now()}@test.local`;
  const pw = 'Str0ngPassword!';

  test('registration requires current policy acceptance and strong password', async () => {
    const b = await browser();
    const weak = await b.post('/api/v1/auth/register').send({ email: addr, password: 'short', firstName: 'N', lastName: 'U', acceptedPolicies: policies });
    expect(weak.status).toBe(422);
    const noTerms = await b.post('/api/v1/auth/register').send({ email: addr, password: pw, firstName: 'N', lastName: 'U' });
    expect(noTerms.status).toBe(422);
    const ok = await b.post('/api/v1/auth/register').send({ email: addr, password: pw, firstName: 'New', lastName: 'User', phone: '08031112222', acceptedPolicies: policies });
    expect(ok.status).toBe(201);
    // no account enumeration: same response for existing email
    const dup = await b.post('/api/v1/auth/register').send({ email: addr, password: pw, firstName: 'New', lastName: 'User', acceptedPolicies: policies });
    expect(dup.status).toBe(201);
    expect(dup.body.data.message).toBe(ok.body.data.message);
    expect(await User.countDocuments({ email: addr })).toBe(1);
  });

  test('email verification link works once', async () => {
    const token = await lastEmailToken(addr, 'email_verify');
    expect(token).toBeTruthy();
    expect(email.devOutbox.some((m) => m.to === addr)).toBe(true);
    const b = await browser();
    expect((await b.post('/api/v1/auth/verify-email').send({ token })).status).toBe(200);
    expect((await b.post('/api/v1/auth/verify-email').send({ token })).status).toBe(400);
    expect((await User.findOne({ email: addr })).emailVerifiedAt).toBeTruthy();
  });

  test('login sets httpOnly cookies; CSRF is required for cookie-authenticated writes', async () => {
    const b = await browser();
    const r = await b.post('/api/v1/auth/login').send({ email: addr, password: pw });
    expect(r.status).toBe(200);
    const cookies = r.headers['set-cookie'].join(';');
    expect(cookies).toMatch(/mp_at=.*HttpOnly/);
    expect(cookies).toMatch(/mp_rt=.*HttpOnly/);
    expect((await b.get('/api/v1/auth/me')).body.data.user.email).toBe(addr);
    const noCsrf = await b.agent.post('/api/v1/auth/logout-all');
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.error.code).toBe('CSRF_FAILED');
  });

  test('phone verification by OTP raises tier to 1', async () => {
    const b = await browser();
    await b.post('/api/v1/auth/login').send({ email: addr, password: pw });
    const s = await b.post('/api/v1/auth/phone/send-code').send({});
    expect(s.status).toBe(200);
    expect(s.body.data.delivered).toBe(false); // console transport is honest: captured, not delivered
    const { code } = authService.devPhoneOutbox[authService.devPhoneOutbox.length - 1];
    expect((await b.post('/api/v1/auth/phone/verify').send({ code: '000000' === code ? '111111' : '000000' })).status).toBe(400);
    const v = await b.post('/api/v1/auth/phone/verify').send({ code });
    expect(v.status).toBe(200);
    expect(v.body.data.user.verificationTier).toBe(1);
  });

  test('refresh tokens rotate; reuse of an old token revokes the session family', async () => {
    const b = await browser();
    const login = await b.post('/api/v1/auth/login').send({ email: addr, password: pw });
    const oldRt = login.headers['set-cookie'].find((c) => c.startsWith('mp_rt=')).split(';')[0];
    const r1 = await b.post('/api/v1/auth/refresh');
    expect(r1.status).toBe(200);
    // attacker replays the old refresh token
    // (without a CSRF pair the request is already blocked by CSRF protection)
    expect((await request(app).post('/api/v1/auth/refresh').set('Cookie', oldRt)).status).toBe(403);
    const replay = await request(app).post('/api/v1/auth/refresh').set('Cookie', `${oldRt}; mp_csrf=forged`).set('x-csrf-token', 'forged');
    expect(replay.status).toBe(401);
    // the legitimate (rotated) session family is now revoked too
    const r2 = await b.post('/api/v1/auth/refresh');
    expect(r2.status).toBe(401);
    expect(await AuditEvent.exists({ action: 'session.refresh_reuse_detected' })).toBeTruthy();
  });

  test('wrong passwords lock the account; generic error for unknown emails', async () => {
    const u = await H.createUser();
    const b = await browser();
    const unknown = await b.post('/api/v1/auth/login').send({ email: 'nobody@test.local', password: 'whatever' });
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.message).toBe('Incorrect email or password');
    for (let i = 0; i < 5; i++) await b.post('/api/v1/auth/login').send({ email: u.email, password: 'Wrong-pass-1' });
    const locked = await b.post('/api/v1/auth/login').send({ email: u.email, password: u.password });
    expect(locked.status).toBe(423);
  });

  test('password reset: link works once and revokes other sessions', async () => {
    const u = await H.createUser();
    const b = await browser();
    await b.post('/api/v1/auth/password/forgot').send({ email: u.email });
    const r0 = await b.post('/api/v1/auth/password/forgot').send({ email: 'nobody@test.local' });
    expect(r0.status).toBe(200); // never reveals whether the account exists
    const token = await lastEmailToken(u.email, 'password_reset');
    const reset = await b.post('/api/v1/auth/password/reset').send({ token, password: 'BrandNewPass123' });
    expect(reset.status).toBe(200);
    expect((await b.post('/api/v1/auth/password/reset').send({ token, password: 'AnotherPass1234' })).status).toBe(400);
    expect((await H.as(u).get('/api/v1/auth/me')).status).toBe(401); // old session revoked
    expect((await b.post('/api/v1/auth/login').send({ email: u.email, password: 'BrandNewPass123' })).status).toBe(200);
  });

  test('Google sign-in unconfigured → explicit 503, never a fake login', async () => {
    const b = await browser();
    const cfg = await b.get('/api/v1/auth/google/config');
    expect(cfg.body.data.configured).toBe(false);
    const r = await b.post('/api/v1/auth/google').send({ credential: 'x'.repeat(40) });
    expect(r.status).toBe(503);
    expect(r.body.error.code).toBe('INTEGRATION_NOT_CONFIGURED');
  });

  test('Google sign-in configured path rejects an invalid ID token', async () => {
    const config = require('../../src/config');
    process.env.GOOGLE_CLIENT_ID = 'test-client.apps.googleusercontent.com';
    config.__reload();
    const b = await browser();
    const r = await b.post('/api/v1/auth/google').send({ credential: 'eyJhbGciOiJSUzI1NiJ9.invalid.signature' });
    expect(r.status).toBe(401);
    delete process.env.GOOGLE_CLIENT_ID;
    config.__reload();
  });
});

describe('two-factor authentication', () => {
  test('optional 2FA for customers: enable, login challenge, replay rejected, recovery code single-use', async () => {
    const u = await H.createUser();
    const setup = await H.as(u).post('/api/v1/auth/2fa/setup');
    const secret = setup.body.data.secret;
    const enable = await H.as(u).post('/api/v1/auth/2fa/enable').send({ code: H.authenticator.generate(secret) });
    expect(enable.status).toBe(200);
    const recovery = enable.body.data.recoveryCodes;
    expect(recovery).toHaveLength(10);
    const b = await browser();
    const login = await b.post('/api/v1/auth/login').send({ email: u.email, password: u.password });
    expect(login.body.data.twoFactorRequired).toBe(true);
    // the same TOTP code used to enable cannot be replayed within its time step
    const replay = await b.post('/api/v1/auth/login/2fa').send({ challengeToken: login.body.data.challengeToken, code: H.authenticator.generate(secret) });
    expect(replay.status).toBe(401);
    const ok = await b.post('/api/v1/auth/login/2fa').send({ challengeToken: login.body.data.challengeToken, recoveryCode: recovery[0] });
    expect(ok.status).toBe(200);
    const b2 = await browser();
    const l2 = await b2.post('/api/v1/auth/login').send({ email: u.email, password: u.password });
    expect((await b2.post('/api/v1/auth/login/2fa').send({ challengeToken: l2.body.data.challengeToken, recoveryCode: recovery[0] })).status).toBe(401);
  });

  test('staff without 2FA are blocked everywhere except 2FA setup; staff cannot disable 2FA', async () => {
    const staff = await H.createUser({ roles: ['admin'], permissions: ['users.view'] }); // no 2FA
    const blocked = await H.as(staff).get('/api/v1/admin/users');
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.code).toBe('TWO_FACTOR_SETUP_REQUIRED');
    expect((await H.as(staff).post('/api/v1/auth/2fa/setup')).status).toBe(200);
    const withMfa = await H.staffUser(['users.view']);
    expect((await H.as(withMfa).post('/api/v1/auth/2fa/disable').send({ password: withMfa.password, code: '123456' })).status).toBe(403);
    // a staff session without MFA verification cannot use staff routes
    const s = await authService.createSession(withMfa.user, { ip: '1.1.1.1', userAgent: 'x', twoFactorVerified: false });
    const r = await request(app).get('/api/v1/admin/users').set('Authorization', `Bearer ${s.accessToken}`);
    expect(r.body.error.code).toBe('TWO_FACTOR_REQUIRED');
  });
});

describe('authorization', () => {
  test('unauthenticated and expired requests are rejected', async () => {
    expect((await request(app).get('/api/v1/wallet')).status).toBe(401);
    expect((await request(app).get('/api/v1/wallet').set('Authorization', 'Bearer not.a.token')).status).toBe(401);
    const jwt = require('jsonwebtoken');
    const u = await H.createUser();
    const sess = await Session.findOne({ userId: u.user._id });
    const expired = jwt.sign({ sub: String(u.user._id), sid: String(sess._id), mfa: false, iat: Math.floor(Date.now() / 1000) - 3600, exp: Math.floor(Date.now() / 1000) - 60 }, require('../../src/config').JWT_ACCESS_SECRET, { issuer: 'mubapay' });
    expect((await request(app).get('/api/v1/wallet').set('Authorization', `Bearer ${expired}`)).status).toBe(401);
  });

  test('customers cannot reach staff operations; admins only within their permissions', async () => {
    const c = await H.createUser();
    for (const url of ['/api/v1/admin/users', '/api/v1/admin/withdrawals', '/api/v1/admin/settings', '/api/v1/admin/audit']) {
      expect((await H.as(c).get(url)).status).toBe(403);
    }
    const support = await H.staffUser('support_agent');
    expect((await H.as(support).get('/api/v1/admin/users')).status).toBe(200);
    expect((await H.as(support).get('/api/v1/admin/withdrawals')).status).toBe(403);
    expect((await H.as(support).get('/api/v1/admin/finance/accounts')).status).toBe(403);
    expect((await H.as(support).patch('/api/v1/admin/settings/fees').send({ value: {}, reason: 'testing' })).status).toBe(403);
    expect(await AuditEvent.exists({ action: 'permission.denied', actorId: support.user._id })).toBeTruthy();
  });

  test('admins without PII permission see masked contact details', async () => {
    const support = await H.staffUser('support_agent');
    const target = await H.createUser({ email: 'pii.check@test.local' });
    const r = await H.as(support).get(`/api/v1/admin/users/${target.user._id}`);
    expect(r.body.data.email).not.toBe('pii.check@test.local');
    expect(r.body.data.email).toMatch(/\*/);
  });

  test('users cannot read other users\' transactions or messages', async () => {
    const a = await H.createUser();
    const b = await H.createUser();
    const fake = H.fakePaystack();
    const ref = await H.fundWallet(a, fake, 10000);
    expect((await H.as(b).get(`/api/v1/wallet/transactions/PAY-${ref}`)).status).toBe(404);
    expect((await H.as(b).get(`/api/v1/wallet/payments/${ref}`)).status).toBe(404);
    fake.uninstall();
  });
});
