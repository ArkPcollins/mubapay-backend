'use strict';
const express = require('express');
const c = require('./auth.controller');
const v = require('./auth.validation');
const { asyncHandler: h, validate } = require('../../lib/http');
const { requireAuth } = require('../../middleware/auth');
const { limiter } = require('../../middleware/common');

const r = express.Router();
const authLimit = limiter({ name: 'auth', windowMs: 15 * 60e3, max: 30, message: 'Too many attempts. Please wait a few minutes.' });
const otpLimit = limiter({ name: 'otp', windowMs: 60 * 60e3, max: 10, keyBy: 'user' });
const emailLimit = limiter({ name: 'email', windowMs: 60 * 60e3, max: 5 });

r.post('/register', authLimit, validate(v.register), h(c.register));
r.post('/verify-email', authLimit, validate(v.token), h(c.verifyEmail));
r.post('/resend-verification', requireAuth, emailLimit, h(c.resendVerification));
r.post('/login', authLimit, validate(v.login), h(c.login));
r.post('/login/2fa', authLimit, validate(v.challenge), h(c.verifyChallenge));
r.get('/google/config', h(c.googleConfig));
r.post('/google', authLimit, validate(v.google), h(c.google));
r.post('/refresh', h(c.refresh));
r.post('/logout', h(async (req, res, next) => {
  // logout works with or without a valid access token
  const { optionalAuth } = require('../../middleware/auth');
  await new Promise((resolve) => optionalAuth(req, res, resolve));
  return c.logout(req, res, next);
}));
r.post('/logout-all', requireAuth, h(c.logoutAll));
r.get('/me', requireAuth, h(c.me));
r.post('/password/forgot', emailLimit, validate(v.email), h(c.forgot));
r.post('/password/reset', authLimit, validate(v.reset), h(c.reset));
r.post('/password/change', requireAuth, authLimit, validate(v.changePassword), h(c.changePassword));
r.post('/phone/send-code', requireAuth, otpLimit, validate(v.phone), h(c.sendPhoneOtp));
r.post('/phone/verify', requireAuth, otpLimit, validate(v.code), h(c.verifyPhone));
r.post('/2fa/setup', requireAuth, h(c.begin2fa));
r.post('/2fa/enable', requireAuth, authLimit, validate(v.code), h(c.enable2fa));
r.post('/2fa/disable', requireAuth, authLimit, validate(v.disable2fa), h(c.disable2fa));
r.post('/2fa/recovery-codes', requireAuth, authLimit, validate(v.code), h(c.recoveryCodes));
r.get('/sessions', requireAuth, h(c.sessions));
r.delete('/sessions/:id', requireAuth, h(c.revokeSession));

module.exports = r;
