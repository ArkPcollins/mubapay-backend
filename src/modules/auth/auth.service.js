'use strict';
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { authenticator } = require('otplib');
const { OAuth2Client } = require('google-auth-library');
const config = require('../../config');
const { User } = require('../users/user.model');
const { Session, OneTimeToken, LoginAttempt } = require('./auth.models');
const { E, AppError } = require('../../lib/errors');
const { sha256, randomToken, randomDigits, encryptString, decryptString } = require('../../lib/crypto');
const audit = require('../audit/audit.service');
const notifications = require('../notifications/notifications.service');
const usersService = require('../users/users.service');
const settings = require('../settings/settings.service');
const whatsapp = require('../../providers/whatsapp/whatsapp.adapter');
const logger = require('../../lib/logger');
const consent = require('../legal/consent.service');

authenticator.options = { step: 30, window: 1 };

const ARGON_OPTS = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
let dummyHashPromise; // real argon2 hash used to equalise timing for unknown emails
const dummyHash = () => (dummyHashPromise = dummyHashPromise || argon2.hash(randomToken(16), ARGON_OPTS));
const devPhoneOutbox = [];

function validatePasswordStrength(pw) {
  const issues = [];
  if (typeof pw !== 'string' || pw.length < 10) issues.push('at least 10 characters');
  if (pw && pw.length > 128) issues.push('at most 128 characters');
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw)) issues.push('upper and lower case letters');
  if (!/\d/.test(pw)) issues.push('a number');
  if (issues.length) throw E.validation([{ path: 'password', message: `Password needs ${issues.join(', ')}` }]);
}

const hashPassword = (pw) => argon2.hash(pw, ARGON_OPTS);

// ---------------------------------------------------------------- sessions
function signAccess(user, session, mfa) {
  return jwt.sign({ sub: String(user._id), sid: String(session._id), mfa: Boolean(mfa) }, config.JWT_ACCESS_SECRET, {
    algorithm: 'HS256', expiresIn: config.ACCESS_TOKEN_TTL_SECONDS, issuer: 'mubapay',
  });
}

async function createSession(user, { ip, userAgent, twoFactorVerified = false, familyId }) {
  const refreshToken = randomToken(48);
  const session = await Session.create({
    userId: user._id, tokenHash: sha256(refreshToken), familyId: familyId || crypto.randomUUID(),
    expiresAt: new Date(Date.now() + config.REFRESH_TOKEN_TTL_DAYS * 864e5), ip, userAgent, lastUsedAt: new Date(), twoFactorVerified,
  });
  return { session, refreshToken, accessToken: signAccess(user, session, twoFactorVerified) };
}

/**
 * Rotate a refresh token. Reuse of an already-rotated token revokes the whole
 * session family (indicates token theft).
 */
async function refresh(refreshToken, { ip, userAgent }) {
  if (!refreshToken) throw E.unauthorized('Session expired. Please sign in again.');
  const hash = sha256(refreshToken);
  const session = await Session.findOne({ tokenHash: hash });
  if (!session) throw E.unauthorized('Session expired. Please sign in again.');
  if (session.rotatedAt || session.revokedAt) {
    if (session.rotatedAt && !session.revokedAt) {
      await Session.updateMany({ familyId: session.familyId, revokedAt: null }, { $set: { revokedAt: new Date(), revokeReason: 'refresh_token_reuse' } });
      await audit.record({ actorType: 'system', action: 'session.refresh_reuse_detected', category: 'security', targetType: 'user', targetId: session.userId, ip, metadata: { familyId: session.familyId } });
      await notifications.notify(session.userId, { category: 'security', type: 'session_revoked', title: 'We signed you out for your safety', body: 'A previously used sign-in token was presented again. All sessions in that sign-in were ended. If this was not you, change your password.' });
    }
    throw E.unauthorized('Session expired. Please sign in again.');
  }
  if (session.expiresAt < new Date()) throw E.unauthorized('Session expired. Please sign in again.');
  const user = await User.findById(session.userId);
  if (!user || ['closed', 'suspended'].includes(user.status)) throw E.unauthorized();
  // Atomically mark as rotated (prevents two concurrent refreshes both succeeding).
  const newToken = randomToken(48);
  const rotated = await Session.findOneAndUpdate({ _id: session._id, rotatedAt: null, revokedAt: null }, { $set: { rotatedAt: new Date(), replacedByHash: sha256(newToken) } });
  if (!rotated) throw E.unauthorized('Session expired. Please sign in again.');
  const next = await Session.create({
    userId: user._id, tokenHash: sha256(newToken), familyId: session.familyId, expiresAt: session.expiresAt, ip, userAgent, lastUsedAt: new Date(), twoFactorVerified: session.twoFactorVerified,
  });
  return { user, refreshToken: newToken, accessToken: signAccess(user, next, next.twoFactorVerified), session: next };
}

async function logout(refreshToken, accessSessionId) {
  const ors = [];
  if (refreshToken) ors.push({ tokenHash: sha256(refreshToken) });
  if (accessSessionId) ors.push({ _id: accessSessionId });
  if (!ors.length) return;
  const s = await Session.findOne({ $or: ors });
  if (s) await Session.updateMany({ familyId: s.familyId, revokedAt: null }, { $set: { revokedAt: new Date(), revokeReason: 'logout' } });
}

async function revokeAllSessions(userId, reason, exceptFamilyId) {
  const filter = { userId, revokedAt: null };
  if (exceptFamilyId) filter.familyId = { $ne: exceptFamilyId };
  await Session.updateMany(filter, { $set: { revokedAt: new Date(), revokeReason: reason } });
}

async function listSessions(userId) {
  const rows = await Session.find({ userId, revokedAt: null, rotatedAt: null, expiresAt: { $gt: new Date() } }).sort({ lastUsedAt: -1 }).lean();
  return rows.map((s) => ({ id: String(s._id), familyId: s.familyId, ip: s.ip, userAgent: s.userAgent, createdAt: s.createdAt, lastUsedAt: s.lastUsedAt }));
}

async function revokeSession(userId, sessionId) {
  const s = await Session.findOne({ _id: sessionId, userId });
  if (!s) throw E.notFound('Session');
  await Session.updateMany({ familyId: s.familyId, revokedAt: null }, { $set: { revokedAt: new Date(), revokeReason: 'user_revoked' } });
}

// ---------------------------------------------------------------- one-time tokens
async function issueToken(userId, purpose, ttlMs, { target, meta, digits } = {}) {
  await OneTimeToken.updateMany({ userId, purpose, usedAt: null }, { $set: { usedAt: new Date(), meta: { superseded: true } } });
  const raw = digits ? randomDigits(digits) : randomToken(32);
  await OneTimeToken.create({ userId, purpose, tokenHash: sha256(`${purpose}:${userId}:${raw}`), target, meta, expiresAt: new Date(Date.now() + ttlMs) });
  return raw;
}

/** Consume a token atomically (single use, attempt-limited). */
async function consumeToken(purpose, raw, userId) {
  if (userId) {
    const tok = await OneTimeToken.findOne({ userId, purpose, usedAt: null, expiresAt: { $gt: new Date() } }).sort({ createdAt: -1 });
    if (!tok) return null;
    if (tok.attempts >= 5) return null;
    if (tok.tokenHash !== sha256(`${purpose}:${userId}:${raw}`)) {
      await OneTimeToken.updateOne({ _id: tok._id }, { $inc: { attempts: 1 } });
      return null;
    }
    return OneTimeToken.findOneAndUpdate({ _id: tok._id, usedAt: null }, { $set: { usedAt: new Date() } }, { new: true });
  }
  // Link tokens embed the user id: <userId>.<raw>
  const [uid, secret] = String(raw).split('.');
  if (!uid || !secret || !/^[a-f0-9]{24}$/.test(uid)) return null;
  return OneTimeToken.findOneAndUpdate(
    { tokenHash: sha256(`${purpose}:${uid}:${secret}`), purpose, usedAt: null, expiresAt: { $gt: new Date() } },
    { $set: { usedAt: new Date() } },
    { new: true }
  );
}

// ---------------------------------------------------------------- registration & verification
async function register({ email, password, firstName, lastName, phone, acceptedPolicies, marketingOptIn }, ctx) {
  validatePasswordStrength(password);
  const normalisedPhone = phone ? usersService.normalisePhone(phone) : undefined;
  if (phone && !normalisedPhone) throw E.validation([{ path: 'phone', message: 'Enter a valid Nigerian phone number' }]);
  await consent.assertRequiredAccepted(acceptedPolicies, 'registration');
  const existing = await User.findOne({ email: email.toLowerCase() });
  if (existing) {
    // Do not reveal account existence: send a "someone tried to register" email instead.
    await notifications.notify(existing._id, { category: 'security', type: 'registration_attempt', title: 'Someone tried to create an account with your email', body: 'If this was you, sign in or reset your password instead.', link: '/login' });
    return { userId: null, existing: true };
  }
  const passwordHash = await hashPassword(password);
  let user;
  try {
    user = await User.create({ email, passwordHash, firstName, lastName, phone: normalisedPhone, roles: ['customer'], 'preferences.marketingEmail': Boolean(marketingOptIn), security: { passwordChangedAt: new Date() } });
  } catch (err) {
    if (err.code === 11000) return { userId: null, existing: true };
    throw err;
  }
  await usersService.onUserCreated(user);
  await consent.recordAcceptances(user._id, acceptedPolicies, { ip: ctx.ip, userAgent: ctx.userAgent, context: 'registration' });
  if (marketingOptIn) await consent.recordMarketing(user._id, true, ctx);
  await sendEmailVerification(user);
  await audit.record({ actor: user, action: 'user.registered', category: 'security', targetType: 'user', targetId: user._id, ip: ctx.ip, userAgent: ctx.userAgent, requestId: ctx.requestId });
  return { userId: String(user._id), existing: false };
}

async function sendEmailVerification(user) {
  if (user.emailVerifiedAt) return;
  const raw = await issueToken(user._id, 'email_verify', 24 * 3600e3);
  await notifications.notify(user._id, {
    category: 'security', type: 'email_verify', title: 'Verify your email address', body: 'Confirm your email to continue setting up MubaPay.',
    emailTemplate: 'email_verify', data: { token: `${user._id}.${raw}` }, forceEmail: true,
  });
}

async function verifyEmail(token, ctx) {
  const tok = await consumeToken('email_verify', token);
  if (!tok) throw E.badRequest('This verification link is invalid or has expired. Request a new one.');
  const user = await User.findByIdAndUpdate(tok.userId, { $set: { emailVerifiedAt: new Date() } }, { new: true });
  await usersService.recomputeTier(user._id);
  await audit.record({ actor: user, action: 'user.email_verified', category: 'security', targetType: 'user', targetId: user._id, ip: ctx?.ip });
  return user;
}

async function sendPhoneOtp(user, phone) {
  const normalised = usersService.normalisePhone(phone || user.phone);
  if (!normalised) throw E.validation([{ path: 'phone', message: 'Enter a valid Nigerian phone number' }]);
  const taken = await User.findOne({ phone: normalised, phoneVerifiedAt: { $ne: null }, _id: { $ne: user._id } }, { _id: 1 });
  if (taken) throw E.conflict('This phone number is already verified on another account', 'PHONE_IN_USE');
  const recent = await OneTimeToken.countDocuments({ userId: user._id, purpose: 'phone_verify', createdAt: { $gt: new Date(Date.now() - 3600e3) } });
  if (recent >= 5) throw E.tooMany('Too many codes requested. Try again in an hour.');
  const code = await issueToken(user._id, 'phone_verify', 10 * 60e3, { target: normalised, digits: 6 });
  if (config.PHONE_OTP_TRANSPORT === 'console') {
    if (config.isProduction) throw new Error('console OTP transport forbidden in production');
    devPhoneOutbox.push({ phone: normalised, code, at: new Date() });
    logger.info({ phone: normalised }, '[console-otp] phone OTP captured (not sent)');
    return { channel: 'console', delivered: false, note: 'Development mode: code captured in server console outbox, not sent' };
  }
  if (config.PHONE_OTP_TRANSPORT === 'disabled') throw E.notConfigured('Phone verification', 'SMS is outside launch scope; configure WhatsApp OTP delivery (PHONE_OTP_TRANSPORT=whatsapp)');
  await whatsapp.sendOtp(normalised, code);
  return { channel: 'whatsapp', delivered: true };
}

async function verifyPhone(user, code) {
  const tok = await consumeToken('phone_verify', String(code), user._id);
  if (!tok) throw E.badRequest('Incorrect or expired code');
  try {
    await User.updateOne({ _id: user._id }, { $set: { phone: tok.target, phoneVerifiedAt: new Date() } });
  } catch (err) {
    if (err.code === 11000) throw E.conflict('This phone number is already verified on another account', 'PHONE_IN_USE');
    throw err;
  }
  const u = await usersService.recomputeTier(user._id);
  await audit.record({ actor: u, action: 'user.phone_verified', category: 'security', targetType: 'user', targetId: u._id });
  return u;
}

// ---------------------------------------------------------------- login
async function checkIpThrottle(ip) {
  const sec = await settings.get('security');
  const n = await LoginAttempt.countDocuments({ ip, success: false, at: { $gt: new Date(Date.now() - 3600e3) } });
  if (n >= sec.ipLoginAttemptsPerHour) throw E.tooMany('Too many failed sign-in attempts from your network. Try again later.');
}

async function login({ email, password }, ctx) {
  await checkIpThrottle(ctx.ip);
  const sec = await settings.get('security');
  const emailHash = sha256(String(email).toLowerCase());
  const user = await User.findOne({ email: String(email).toLowerCase() }).select('+passwordHash +twoFactor.secretEnc');
  const fail = async (reason) => {
    await LoginAttempt.create({ emailHash, ip: ctx.ip, success: false, reason });
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Incorrect email or password');
  };
  if (!user || !user.passwordHash) {
    await argon2.verify(await dummyHash(), String(password)).catch(() => false); // equalise timing
    return fail('unknown_or_no_password');
  }
  if (user.security?.lockedUntil && user.security.lockedUntil > new Date()) {
    await LoginAttempt.create({ emailHash, ip: ctx.ip, success: false, reason: 'locked' });
    throw new AppError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Your account is temporarily locked; try again later or reset your password.');
  }
  const okPw = await argon2.verify(user.passwordHash, String(password)).catch(() => false);
  if (!okPw) {
    const count = (user.security?.failedLoginCount || 0) + 1;
    const set = { 'security.failedLoginCount': count };
    if (count >= sec.maxFailedLogins) {
      set['security.lockedUntil'] = new Date(Date.now() + sec.lockMinutes * 60e3);
      set['security.failedLoginCount'] = 0;
      await audit.record({ actorType: 'system', action: 'user.locked', category: 'security', targetType: 'user', targetId: user._id, ip: ctx.ip });
      await notifications.notify(user._id, { category: 'security', type: 'account_locked', title: 'Your account was temporarily locked', body: 'Several incorrect passwords were entered. If this wasn\'t you, reset your password.' });
    }
    await User.updateOne({ _id: user._id }, { $set: set });
    return fail('bad_password');
  }
  if (['suspended', 'closed'].includes(user.status)) throw new AppError(403, 'ACCOUNT_UNAVAILABLE', 'This account is not available. Contact support.');
  if (argon2.needsRehash?.(user.passwordHash, ARGON_OPTS)) {
    await User.updateOne({ _id: user._id }, { $set: { passwordHash: await hashPassword(password) } });
  }
  await User.updateOne({ _id: user._id }, { $set: { 'security.failedLoginCount': 0, 'security.lockedUntil': null } });
  if (user.twoFactor?.enabled) {
    const challenge = await issueToken(user._id, 'login_challenge', 5 * 60e3, { meta: { ip: ctx.ip } });
    return { twoFactorRequired: true, challengeToken: `${user._id}.${challenge}` };
  }
  return completeLogin(user, ctx, { twoFactorVerified: false, method: 'password' });
}

async function completeLogin(user, ctx, { twoFactorVerified, method }) {
  await LoginAttempt.create({ emailHash: sha256(user.email), ip: ctx.ip, success: true, reason: method });
  const tokens = await createSession(user, { ip: ctx.ip, userAgent: ctx.userAgent, twoFactorVerified });
  const deviceHash = sha256(`${ctx.userAgent || ''}|${(ctx.ip || '').split('.').slice(0, 3).join('.')}`);
  const full = await User.findById(user._id).select('+security.knownDeviceHashes');
  const known = full.security?.knownDeviceHashes || [];
  if (!known.includes(deviceHash)) {
    await User.updateOne({ _id: user._id }, { $push: { 'security.knownDeviceHashes': { $each: [deviceHash], $slice: -20 } } });
    if (known.length > 0) {
      await notifications.notify(user._id, { category: 'security', type: 'login_alert', title: 'New sign-in to your account', body: `New sign-in from ${ctx.ip}.`, emailTemplate: 'login_alert', data: { ip: ctx.ip, userAgent: ctx.userAgent }, link: '/app/settings/security' });
    }
  }
  await User.updateOne({ _id: user._id }, { $set: { 'security.lastLoginAt': new Date(), 'security.lastLoginIp': ctx.ip } });
  await audit.record({ actor: user, action: 'user.login', category: 'security', targetType: 'user', targetId: user._id, ip: ctx.ip, userAgent: ctx.userAgent, metadata: { method, twoFactorVerified } });
  return { user: await User.findById(user._id), ...tokens };
}

/** Verify TOTP with replay protection (each 30s step usable once). */
async function verifyTotp(userId, code, { pending = false } = {}) {
  const user = await User.findById(userId).select('+twoFactor.secretEnc +twoFactor.pendingSecretEnc +twoFactor.lastUsedStep');
  const enc = pending ? user.twoFactor?.pendingSecretEnc : user.twoFactor?.secretEnc;
  if (!enc) return false;
  const secret = decryptString(enc);
  const clean = String(code).replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return false;
  const delta = authenticator.checkDelta(clean, secret);
  if (delta === null) return false;
  const step = Math.floor(Date.now() / 30000) + delta;
  const r = await User.updateOne({ _id: userId, $or: [{ 'twoFactor.lastUsedStep': { $lt: step } }, { 'twoFactor.lastUsedStep': null }] }, { $set: { 'twoFactor.lastUsedStep': step } });
  return r.modifiedCount === 1; // 0 → code already used (replay)
}

async function useRecoveryCode(userId, code) {
  const h = sha256(String(code).trim().toUpperCase());
  const r = await User.updateOne({ _id: userId, 'twoFactor.recoveryCodeHashes': h }, { $pull: { 'twoFactor.recoveryCodeHashes': h } });
  return r.modifiedCount === 1;
}

async function verifyLoginChallenge({ challengeToken, code, recoveryCode }, ctx) {
  const [uid, secret] = String(challengeToken || '').split('.');
  if (!uid || !secret) throw E.badRequest('Invalid challenge');
  const tok = await OneTimeToken.findOne({ tokenHash: sha256(`login_challenge:${uid}:${secret}`), purpose: 'login_challenge', usedAt: null, expiresAt: { $gt: new Date() } });
  if (!tok) throw E.unauthorized('Sign-in session expired. Please sign in again.');
  if (tok.attempts >= 5) throw E.tooMany('Too many incorrect codes. Sign in again.');
  let ok = false;
  let method = 'totp';
  if (recoveryCode) {
    ok = await useRecoveryCode(uid, recoveryCode);
    method = 'recovery_code';
  } else ok = await verifyTotp(uid, code);
  if (!ok) {
    await OneTimeToken.updateOne({ _id: tok._id }, { $inc: { attempts: 1 } });
    throw new AppError(401, 'INVALID_2FA_CODE', 'Incorrect or already-used code');
  }
  const consumed = await OneTimeToken.findOneAndUpdate({ _id: tok._id, usedAt: null }, { $set: { usedAt: new Date() } });
  if (!consumed) throw E.unauthorized('Sign-in session expired. Please sign in again.');
  const user = await User.findById(uid);
  if (method === 'recovery_code') {
    await notifications.notify(user._id, { category: 'security', type: '2fa_recovery_used', title: 'A recovery code was used to sign in', body: 'If this was not you, contact support immediately.' });
  }
  return completeLogin(user, ctx, { twoFactorVerified: true, method });
}

// ---------------------------------------------------------------- google
let googleClient;
async function googleLogin({ credential }, ctx) {
  if (!config.integrations.google) throw E.notConfigured('Google sign-in', 'Set GOOGLE_CLIENT_ID (OAuth 2.0 Web client ID) and add your frontend origin to the authorised JavaScript origins.');
  googleClient = googleClient || new OAuth2Client(config.GOOGLE_CLIENT_ID);
  let payload;
  try {
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: config.GOOGLE_CLIENT_ID });
    payload = ticket.getPayload();
  } catch (err) {
    logger.warn({ err: err.message }, 'google token verification failed');
    throw E.unauthorized('Google sign-in could not be verified');
  }
  if (!payload?.email || !payload.email_verified) throw E.unauthorized('Your Google account email is not verified');
  let user = await User.findOne({ googleId: payload.sub }).select('+googleId +twoFactor.secretEnc');
  let created = false;
  if (!user) {
    user = await User.findOne({ email: payload.email.toLowerCase() }).select('+googleId +passwordHash');
    if (user) {
      const set = { googleId: payload.sub };
      if (!user.emailVerifiedAt) {
        // An unverified account with this email may have been created by someone else:
        // the Google-verified owner takes over; revoke sessions and clear the unverified password.
        set.emailVerifiedAt = new Date();
        set.passwordHash = null;
        await revokeAllSessions(user._id, 'google_account_takeover_protection');
      }
      await User.updateOne({ _id: user._id }, { $set: set });
      await audit.record({ actor: user, action: 'user.google_linked', category: 'security', targetType: 'user', targetId: user._id, ip: ctx.ip });
    } else {
      if (!ctx.acceptedPolicies) {
        return { needsConsent: true, email: payload.email, firstName: payload.given_name, lastName: payload.family_name };
      }
      await consent.assertRequiredAccepted(ctx.acceptedPolicies, 'registration');
      user = await User.create({ email: payload.email, googleId: payload.sub, emailVerifiedAt: new Date(), firstName: payload.given_name, lastName: payload.family_name, roles: ['customer'] });
      await usersService.onUserCreated(user);
      await consent.recordAcceptances(user._id, ctx.acceptedPolicies, { ip: ctx.ip, userAgent: ctx.userAgent, context: 'registration_google' });
      created = true;
      await audit.record({ actor: user, action: 'user.registered', category: 'security', targetType: 'user', targetId: user._id, ip: ctx.ip, metadata: { method: 'google' } });
    }
    user = await User.findById(user._id).select('+twoFactor.secretEnc');
  }
  if (['suspended', 'closed'].includes(user.status)) throw new AppError(403, 'ACCOUNT_UNAVAILABLE', 'This account is not available. Contact support.');
  if (user.twoFactor?.enabled) {
    const challenge = await issueToken(user._id, 'login_challenge', 5 * 60e3);
    return { twoFactorRequired: true, challengeToken: `${user._id}.${challenge}` };
  }
  const r = await completeLogin(user, ctx, { twoFactorVerified: false, method: 'google' });
  return { ...r, created };
}

// ---------------------------------------------------------------- password reset / change
async function forgotPassword(email) {
  const user = await User.findOne({ email: String(email).toLowerCase() });
  if (!user || user.status === 'closed') return; // never reveal existence
  const raw = await issueToken(user._id, 'password_reset', 30 * 60e3);
  await notifications.notify(user._id, { category: 'security', type: 'password_reset', title: 'Password reset requested', body: 'Use the link we emailed you to reset your password.', emailTemplate: 'password_reset', data: { token: `${user._id}.${raw}` }, forceEmail: true });
}

async function resetPassword({ token, password }, ctx) {
  validatePasswordStrength(password);
  const tok = await consumeToken('password_reset', token);
  if (!tok) throw E.badRequest('This reset link is invalid or has expired');
  const passwordHash = await hashPassword(password);
  const user = await User.findByIdAndUpdate(tok.userId, { $set: { passwordHash, 'security.passwordChangedAt': new Date(), 'security.failedLoginCount': 0, 'security.lockedUntil': null } }, { new: true });
  if (!user.emailVerifiedAt) await User.updateOne({ _id: user._id }, { $set: { emailVerifiedAt: new Date() } }); // reset link proves email ownership
  await revokeAllSessions(user._id, 'password_reset');
  await audit.record({ actor: user, action: 'user.password_reset', category: 'security', targetType: 'user', targetId: user._id, ip: ctx.ip });
  await notifications.notify(user._id, { category: 'security', type: 'password_changed', title: 'Your password was changed', body: 'All other sessions have been signed out. If you did not do this, contact support immediately.' });
}

async function changePassword(user, { currentPassword, newPassword }, ctx) {
  validatePasswordStrength(newPassword);
  const full = await User.findById(user._id).select('+passwordHash');
  if (full.passwordHash && !(await argon2.verify(full.passwordHash, String(currentPassword || '')).catch(() => false))) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Current password is incorrect');
  }
  await User.updateOne({ _id: user._id }, { $set: { passwordHash: await hashPassword(newPassword), 'security.passwordChangedAt': new Date() } });
  await revokeAllSessions(user._id, 'password_changed', ctx.familyId);
  await audit.record({ actor: user, action: 'user.password_changed', category: 'security', targetType: 'user', targetId: user._id, ip: ctx.ip });
  await notifications.notify(user._id, { category: 'security', type: 'password_changed', title: 'Your password was changed', body: 'Other sessions were signed out.' });
}

// ---------------------------------------------------------------- 2FA management
async function begin2fa(user) {
  if (user.twoFactor?.enabled) throw E.conflict('Two-factor authentication is already enabled');
  const secret = authenticator.generateSecret(20);
  await User.updateOne({ _id: user._id }, { $set: { 'twoFactor.pendingSecretEnc': encryptString(secret) } });
  const otpauth = authenticator.keyuri(user.email, 'MubaPay', secret);
  const qr = await require('qrcode').toDataURL(otpauth);
  return { otpauthUrl: otpauth, qrDataUrl: qr, secret };
}

async function enable2fa(user, code, ctx) {
  const ok = await verifyTotp(user._id, code, { pending: true });
  if (!ok) throw new AppError(400, 'INVALID_2FA_CODE', 'Incorrect code. Check your authenticator app time settings.');
  const codes = Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex').toUpperCase());
  const full = await User.findById(user._id).select('+twoFactor.pendingSecretEnc');
  await User.updateOne(
    { _id: user._id },
    { $set: { 'twoFactor.enabled': true, 'twoFactor.secretEnc': full.twoFactor.pendingSecretEnc, 'twoFactor.pendingSecretEnc': null, 'twoFactor.enabledAt': new Date(), 'twoFactor.recoveryCodeHashes': codes.map((c) => sha256(c)) } }
  );
  // Current session becomes 2FA-verified; other sessions must re-authenticate.
  if (ctx.sessionId) await Session.updateOne({ _id: ctx.sessionId }, { $set: { twoFactorVerified: true } });
  await revokeAllSessions(user._id, '2fa_enabled', ctx.familyId);
  await audit.record({ actor: user, action: 'user.2fa_enabled', category: 'security', targetType: 'user', targetId: user._id, ip: ctx.ip });
  await notifications.notify(user._id, { category: 'security', type: '2fa_enabled', title: 'Two-factor authentication enabled', body: 'Keep your recovery codes somewhere safe.' });
  return { recoveryCodes: codes };
}

async function disable2fa(user, { password, code }, ctx) {
  if (user.isStaff()) throw E.forbidden('Staff accounts cannot disable two-factor authentication. A superadmin-approved reset is required.');
  const full = await User.findById(user._id).select('+passwordHash');
  if (full.passwordHash && !(await argon2.verify(full.passwordHash, String(password || '')).catch(() => false))) throw new AppError(401, 'INVALID_CREDENTIALS', 'Password is incorrect');
  if (!(await verifyTotp(user._id, code))) throw new AppError(400, 'INVALID_2FA_CODE', 'Incorrect or already-used code');
  await User.updateOne({ _id: user._id }, { $set: { 'twoFactor.enabled': false, 'twoFactor.secretEnc': null, 'twoFactor.recoveryCodeHashes': [], 'twoFactor.lastUsedStep': 0 } });
  await audit.record({ actor: user, action: 'user.2fa_disabled', category: 'security', targetType: 'user', targetId: user._id, ip: ctx.ip });
  await notifications.notify(user._id, { category: 'security', type: '2fa_disabled', title: 'Two-factor authentication turned off', body: 'If this was not you, secure your account immediately.' });
}

async function regenerateRecoveryCodes(user, code, ctx) {
  if (!(await verifyTotp(user._id, code))) throw new AppError(400, 'INVALID_2FA_CODE', 'Incorrect or already-used code');
  const codes = Array.from({ length: 10 }, () => crypto.randomBytes(5).toString('hex').toUpperCase());
  await User.updateOne({ _id: user._id }, { $set: { 'twoFactor.recoveryCodeHashes': codes.map((c) => sha256(c)) } });
  await audit.record({ actor: user, action: 'user.2fa_recovery_regenerated', category: 'security', targetType: 'user', targetId: user._id, ip: ctx.ip });
  return { recoveryCodes: codes };
}

/** Executed only after dual approval (see approvals module). */
async function resetTwoFactorForStaff(targetUserId) {
  await User.updateOne({ _id: targetUserId }, { $set: { 'twoFactor.enabled': false, 'twoFactor.secretEnc': null, 'twoFactor.recoveryCodeHashes': [], 'twoFactor.lastUsedStep': 0 } });
  await revokeAllSessions(targetUserId, '2fa_reset_by_approval');
}

module.exports = {
  register, verifyEmail, sendEmailVerification, sendPhoneOtp, verifyPhone, login, verifyLoginChallenge, googleLogin, refresh, logout,
  listSessions, revokeSession, revokeAllSessions, forgotPassword, resetPassword, changePassword, begin2fa, enable2fa, disable2fa,
  regenerateRecoveryCodes, resetTwoFactorForStaff, verifyTotp, hashPassword, validatePasswordStrength, createSession, devPhoneOutbox, consumeToken,
};
