'use strict';
const jwt = require('jsonwebtoken');
const config = require('../config');
const { E } = require('../lib/errors');
const { User } = require('../modules/users/user.model');
const { Session } = require('../modules/auth/auth.models');
const { ALL_PERMISSIONS } = require('../modules/rbac/permissions');
const audit = require('../modules/audit/audit.service');

const ACCESS_COOKIE = 'mp_at';

function readToken(req) {
  const h = req.get('authorization');
  if (h && h.startsWith('Bearer ')) return { token: h.slice(7), via: 'bearer' };
  if (req.cookies?.[ACCESS_COOKIE]) return { token: req.cookies[ACCESS_COOKIE], via: 'cookie' };
  return null;
}

async function resolveUser(token) {
  let payload;
  try {
    payload = jwt.verify(token, config.JWT_ACCESS_SECRET, { algorithms: ['HS256'], issuer: 'mubapay' });
  } catch {
    return null;
  }
  const [user, session] = await Promise.all([
    User.findById(payload.sub),
    Session.findById(payload.sid, { revokedAt: 1, expiresAt: 1, twoFactorVerified: 1 }).lean(),
  ]);
  if (!user || !session || session.revokedAt || session.expiresAt < new Date()) return null;
  if (user.status === 'closed' || user.status === 'suspended') return null;
  if (user.security?.passwordChangedAt && payload.iat * 1000 < user.security.passwordChangedAt.getTime() - 1000) return null;
  return { user, session, payload };
}

/** Attach req.user when a valid token is present; never rejects. */
const optionalAuth = async (req, _res, next) => {
  try {
    const t = readToken(req);
    if (t) {
      const r = await resolveUser(t.token);
      if (r) {
        req.user = r.user;
        req.authSession = r.session;
        req.authVia = t.via;
        req.mfa = Boolean(r.payload.mfa);
      }
    }
    next();
  } catch (err) {
    next(err);
  }
};

/** Require authentication. Staff without 2FA may only reach 2FA setup routes. */
const requireAuth = async (req, res, next) => {
  await optionalAuth(req, res, (err) => {
    if (err) return next(err);
    if (!req.user) return next(E.unauthorized());
    if (req.user.isStaff()) {
      const setupRoute = req.originalUrl.startsWith('/api/v1/auth/2fa') || req.originalUrl.startsWith('/api/v1/auth/me') || req.originalUrl.startsWith('/api/v1/auth/logout');
      if (!req.user.twoFactor?.enabled && !setupRoute) {
        return next(new (require('../lib/errors').AppError)(403, 'TWO_FACTOR_SETUP_REQUIRED', 'Staff accounts must enable two-factor authentication before continuing'));
      }
      if (req.user.twoFactor?.enabled && !req.mfa && !setupRoute) return next(E.twoFactorRequired());
    }
    next();
  });
};

function hasPermission(user, perm) {
  if (!user) return false;
  if (user.roles.includes('superadmin')) return ALL_PERMISSIONS.includes(perm);
  if (!user.roles.includes('admin')) return false;
  return user.staffPermissions.includes(perm);
}

/** Require ALL listed permissions. Denials of staff routes are audited. */
const requirePermission = (...perms) => (req, _res, next) => {
  if (!req.user) return next(E.unauthorized());
  const missing = perms.filter((p) => !hasPermission(req.user, p));
  if (missing.length) {
    if (req.user.isStaff() || perms.some((p) => p.startsWith('staff.') || p.startsWith('finance'))) {
      audit.fromReq(req, { action: 'permission.denied', category: 'access', outcome: 'denied', metadata: { missing, path: req.originalUrl } }).catch(() => {});
    }
    return next(E.forbidden());
  }
  next();
};

const requireAnyPermission = (...perms) => (req, _res, next) => {
  if (!req.user) return next(E.unauthorized());
  if (!perms.some((p) => hasPermission(req.user, p))) return next(E.forbidden());
  next();
};

const requireRole = (...roles) => (req, _res, next) => {
  if (!req.user) return next(E.unauthorized());
  if (!roles.some((r) => req.user.roles.includes(r))) return next(E.forbidden());
  next();
};

const requireCapability = (cap) => (req, _res, next) => {
  if (!req.user) return next(E.unauthorized());
  if (!req.user.capabilities?.[cap]) return next(E.forbidden(`Your account is not approved for this capability (${cap}). Submit an application first.`));
  next();
};

/** Financial actions blocked while account restricted. */
const requireActive = (req, _res, next) => {
  if (req.user.status !== 'active') return next(E.forbidden(`Your account is ${req.user.status}. Contact support for help.`));
  next();
};

module.exports = { optionalAuth, requireAuth, requirePermission, requireAnyPermission, requireRole, requireCapability, requireActive, hasPermission, ACCESS_COOKIE, resolveUser };
