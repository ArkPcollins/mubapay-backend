'use strict';
const { mongoose } = require('../../lib/db');
const { Schema } = mongoose;

/**
 * Refresh-token sessions. Tokens are opaque random strings; only their SHA-256
 * hash is stored. Each refresh rotates the token; reuse of a rotated token
 * revokes the whole family (theft detection).
 */
const sessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    tokenHash: { type: String, required: true },
    familyId: { type: String, required: true, index: true },
    replacedByHash: String,
    rotatedAt: Date,
    expiresAt: { type: Date, required: true },
    revokedAt: Date,
    revokeReason: String,
    ip: String,
    userAgent: String,
    lastUsedAt: Date,
    twoFactorVerified: { type: Boolean, default: false },
  },
  { timestamps: true }
);
sessionSchema.index({ tokenHash: 1 }, { unique: true });
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 7 }); // purge a week after expiry

/** Single-use, short-lived tokens/codes (email verification, reset, OTP, 2FA challenge). */
const oneTimeTokenSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    purpose: { type: String, required: true, enum: ['email_verify', 'password_reset', 'phone_verify', 'login_challenge', 'account_recovery', 'email_change'] },
    tokenHash: { type: String, required: true },
    target: String, // e.g. phone number being verified
    expiresAt: { type: Date, required: true },
    usedAt: Date,
    attempts: { type: Number, default: 0 },
    meta: Schema.Types.Mixed,
  },
  { timestamps: true }
);
oneTimeTokenSchema.index({ tokenHash: 1, purpose: 1 }, { unique: true });
oneTimeTokenSchema.index({ userId: 1, purpose: 1, createdAt: -1 });
oneTimeTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 3600 });

/** Login attempt log for brute-force & credential-stuffing detection. */
const loginAttemptSchema = new Schema(
  {
    emailHash: String,
    ip: String,
    success: Boolean,
    reason: String,
    at: { type: Date, default: Date.now },
  },
  { versionKey: false }
);
loginAttemptSchema.index({ ip: 1, at: -1 });
loginAttemptSchema.index({ emailHash: 1, at: -1 });
loginAttemptSchema.index({ at: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 });

const Session = mongoose.models.Session || mongoose.model('Session', sessionSchema);
const OneTimeToken = mongoose.models.OneTimeToken || mongoose.model('OneTimeToken', oneTimeTokenSchema);
const LoginAttempt = mongoose.models.LoginAttempt || mongoose.model('LoginAttempt', loginAttemptSchema);

module.exports = { Session, OneTimeToken, LoginAttempt };
