'use strict';
const { User } = require('./user.model');
const ledger = require('../ledger/ledger.service');

/**
 * Verification tiers
 *  0: account created (browse, non-financial features)
 *  1: email + phone verified (limited wallet funding/transfers/savings)
 *  2: identity verified by staff (withdrawals, used-item selling, higher limits)
 *  3: enhanced review (granted by staff after additional checks)
 */
function computeTier(user) {
  if (!user.emailVerifiedAt || !user.phoneVerifiedAt) return 0;
  if (user.kycStatus === 'approved') return user.verificationTier === 3 ? 3 : 2;
  return 1;
}

async function recomputeTier(userId, session) {
  const user = await User.findById(userId).session(session || null);
  if (!user) return null;
  const tier = computeTier(user);
  if (tier !== user.verificationTier) {
    user.verificationTier = tier;
    await user.save({ session });
  }
  return user;
}

async function onUserCreated(user) {
  await ledger.ensureUserAccounts(user._id);
}

function normalisePhone(phone) {
  const d = String(phone || '').replace(/[^\d+]/g, '');
  if (/^\+234\d{10}$/.test(d)) return d;
  if (/^234\d{10}$/.test(d)) return `+${d}`;
  if (/^0\d{10}$/.test(d)) return `+234${d.slice(1)}`;
  return null;
}

module.exports = { computeTier, recomputeTier, onUserCreated, normalisePhone };
