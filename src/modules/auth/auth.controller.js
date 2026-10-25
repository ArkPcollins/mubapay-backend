'use strict';
const config = require('../../config');
const svc = require('./auth.service');
const { ok, created } = require('../../lib/http');
const { ACCESS_COOKIE } = require('../../middleware/auth');
const { E } = require('../../lib/errors');

const REFRESH_COOKIE = 'mp_rt';
const ctx = (req) => ({ ip: req.ip, userAgent: req.get('user-agent'), requestId: req.id });

function setSessionCookies(res, { accessToken, refreshToken }) {
  const base = { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: config.COOKIE_SAMESITE, domain: config.COOKIE_DOMAIN };
  res.cookie(ACCESS_COOKIE, accessToken, { ...base, path: '/', maxAge: config.ACCESS_TOKEN_TTL_SECONDS * 1000 });
  res.cookie(REFRESH_COOKIE, refreshToken, { ...base, path: '/api/v1/auth', maxAge: config.REFRESH_TOKEN_TTL_DAYS * 864e5 });
}
function clearSessionCookies(res) {
  const base = { domain: config.COOKIE_DOMAIN, secure: config.COOKIE_SECURE, sameSite: config.COOKIE_SAMESITE };
  res.clearCookie(ACCESS_COOKIE, { ...base, path: '/' });
  res.clearCookie(REFRESH_COOKIE, { ...base, path: '/api/v1/auth' });
}
function sessionResponse(res, r) {
  if (r.twoFactorRequired) return ok(res, { twoFactorRequired: true, challengeToken: r.challengeToken });
  if (r.needsConsent) return ok(res, { needsConsent: true, email: r.email, firstName: r.firstName, lastName: r.lastName });
  setSessionCookies(res, r);
  return ok(res, { user: r.user.toSelf(), ...(config.isTest || res.req.get('x-client') === 'api' ? { accessToken: r.accessToken } : {}) });
}

module.exports = {
  async register(req, res) {
    await svc.register(req.body, ctx(req));
    // Identical response whether or not the email already exists (no account enumeration).
    created(res, { message: 'Check your email to verify your address and finish setting up your account.' });
  },
  async verifyEmail(req, res) {
    const u = await svc.verifyEmail(req.body.token, ctx(req));
    ok(res, { verified: true, user: u.toSelf() });
  },
  async resendVerification(req, res) {
    await svc.sendEmailVerification(req.user);
    ok(res, { sent: true });
  },
  async login(req, res) {
    sessionResponse(res, await svc.login(req.body, ctx(req)));
  },
  async verifyChallenge(req, res) {
    sessionResponse(res, await svc.verifyLoginChallenge(req.body, ctx(req)));
  },
  async google(req, res) {
    sessionResponse(res, await svc.googleLogin(req.body, { ...ctx(req), acceptedPolicies: req.body.acceptedPolicies }));
  },
  googleConfig(_req, res) {
    ok(res, { configured: Boolean(config.GOOGLE_CLIENT_ID), clientId: config.GOOGLE_CLIENT_ID || null });
  },
  async refresh(req, res) {
    try {
      const r = await svc.refresh(req.cookies?.[REFRESH_COOKIE], ctx(req));
      setSessionCookies(res, r);
      ok(res, { user: r.user.toSelf() });
    } catch (err) {
      clearSessionCookies(res);
      throw err;
    }
  },
  async logout(req, res) {
    await svc.logout(req.cookies?.[REFRESH_COOKIE], req.authSession?._id);
    clearSessionCookies(res);
    ok(res, { loggedOut: true });
  },
  async logoutAll(req, res) {
    await svc.revokeAllSessions(req.user._id, 'logout_all');
    clearSessionCookies(res);
    ok(res, { loggedOut: true });
  },
  me(req, res) {
    ok(res, { user: req.user.toSelf(), twoFactorVerified: Boolean(req.mfa) });
  },
  async forgot(req, res) {
    await svc.forgotPassword(req.body.email);
    ok(res, { message: 'If an account exists for that email, a reset link has been sent.' });
  },
  async reset(req, res) {
    await svc.resetPassword(req.body, ctx(req));
    clearSessionCookies(res);
    ok(res, { reset: true });
  },
  async changePassword(req, res) {
    await svc.changePassword(req.user, req.body, { ...ctx(req), familyId: req.authSession?.familyId });
    ok(res, { changed: true });
  },
  async sendPhoneOtp(req, res) {
    ok(res, await svc.sendPhoneOtp(req.user, req.body.phone));
  },
  async verifyPhone(req, res) {
    const u = await svc.verifyPhone(req.user, req.body.code);
    ok(res, { user: u.toSelf() });
  },
  async begin2fa(req, res) {
    ok(res, await svc.begin2fa(req.user));
  },
  async enable2fa(req, res) {
    const r = await svc.enable2fa(req.user, req.body.code, { ...ctx(req), sessionId: req.authSession?._id, familyId: req.authSession?.familyId });
    // reissue access token flagged as MFA-verified
    const { Session } = require('./auth.models');
    const s = await Session.findById(req.authSession._id);
    const jwt = require('jsonwebtoken');
    const at = jwt.sign({ sub: String(req.user._id), sid: String(s._id), mfa: true }, config.JWT_ACCESS_SECRET, { algorithm: 'HS256', expiresIn: config.ACCESS_TOKEN_TTL_SECONDS, issuer: 'mubapay' });
    res.cookie(ACCESS_COOKIE, at, { httpOnly: true, secure: config.COOKIE_SECURE, sameSite: config.COOKIE_SAMESITE, domain: config.COOKIE_DOMAIN, path: '/', maxAge: config.ACCESS_TOKEN_TTL_SECONDS * 1000 });
    ok(res, { ...r, ...(config.isTest ? { accessToken: at } : {}) });
  },
  async disable2fa(req, res) {
    await svc.disable2fa(req.user, req.body, ctx(req));
    ok(res, { disabled: true });
  },
  async recoveryCodes(req, res) {
    ok(res, await svc.regenerateRecoveryCodes(req.user, req.body.code, ctx(req)));
  },
  async sessions(req, res) {
    const rows = await svc.listSessions(req.user._id);
    ok(res, rows.map((s) => ({ ...s, current: s.familyId === req.authSession?.familyId })));
  },
  async revokeSession(req, res) {
    if (!/^[a-f0-9]{24}$/.test(req.params.id)) throw E.badRequest('Invalid session');
    await svc.revokeSession(req.user._id, req.params.id);
    ok(res, { revoked: true });
  },
  setSessionCookies,
  clearSessionCookies,
};
