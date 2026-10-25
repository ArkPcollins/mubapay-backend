'use strict';
const { LimitCounter } = require('./payment.models');
const settings = require('../settings/settings.service');
const { E } = require('../../lib/errors');
const { isDuplicateKey } = require('../../lib/db');
const { koboToNairaString } = require('../../lib/money');

/** Calendar periods in Africa/Lagos (UTC+1, no DST). */
function lagosParts(date = new Date()) {
  const d = new Date(date.getTime() + 60 * 60 * 1000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return { day: `D:${y}-${m}-${day}`, month: `M:${y}-${m}` };
}

const KIND_FIELDS = {
  funding: { perTx: 'fundingPerTx', daily: 'fundingDaily', monthly: 'fundingMonthly' },
  transfer: { perTx: 'transferPerTx', daily: 'transferDaily' },
  withdrawal: { perTx: 'withdrawalPerTx', daily: 'withdrawalDaily', monthly: 'withdrawalMonthly' },
  savings: { perTx: 'savingsContributionPerTx' },
};

async function tierLimits(tier) {
  const limits = await settings.get('limits');
  return limits.tiers[String(tier)] || limits.tiers['0'];
}

/** Non-binding pre-check (used before redirecting to a provider). */
async function precheck(user, kind, amountKobo, { pendingKobo = 0 } = {}) {
  const lim = await tierLimits(user.verificationTier);
  const f = KIND_FIELDS[kind];
  if (!lim[f.perTx]) throw E.verificationRequired(`Your verification tier does not permit ${kind}. Complete verification to unlock it.`, { tier: user.verificationTier, kind });
  if (amountKobo > lim[f.perTx]) throw E.limitExceeded(`Maximum per ${kind} is ${koboToNairaString(lim[f.perTx])} for your verification tier`, { limitKobo: lim[f.perTx] });
  const { day, month } = lagosParts();
  for (const [period, field] of [[day, f.daily], [month, f.monthly]]) {
    if (!field) continue;
    const c = await LimitCounter.findOne({ userId: user._id, kind, period }).lean();
    const used = (c?.totalKobo || 0) + pendingKobo;
    if (used + amountKobo > lim[field]) throw E.limitExceeded(`This would exceed your ${period.startsWith('D') ? 'daily' : 'monthly'} ${kind} limit of ${koboToNairaString(lim[field])}`, { limitKobo: lim[field], usedKobo: used });
  }
  return lim;
}

/**
 * Binding, concurrency-safe consumption inside a MongoDB transaction.
 * Uses a conditional upsert: if the counter already exceeds (limit - amount),
 * the filter fails, the upsert collides with the unique index, and we reject.
 */
async function consume(user, kind, amountKobo, session, { enforce = true } = {}) {
  const lim = await tierLimits(user.verificationTier);
  const f = KIND_FIELDS[kind];
  if (enforce) {
    if (!lim[f.perTx]) throw E.verificationRequired(`Your verification tier does not permit ${kind}`, { tier: user.verificationTier });
    if (amountKobo > lim[f.perTx]) throw E.limitExceeded(`Maximum per ${kind} is ${koboToNairaString(lim[f.perTx])}`, { limitKobo: lim[f.perTx] });
  }
  const { day, month } = lagosParts();
  const exceeded = [];
  for (const [period, field, ttlDays] of [[day, f.daily, 3], [month, f.monthly, 40]]) {
    if (!field) continue;
    const limit = lim[field];
    const filter = { userId: user._id, kind, period };
    if (enforce) filter.totalKobo = { $lte: limit - amountKobo };
    try {
      await LimitCounter.findOneAndUpdate(
        filter,
        { $inc: { totalKobo: amountKobo, count: 1 }, $setOnInsert: { expiresAt: new Date(Date.now() + ttlDays * 864e5) } },
        { upsert: true, new: true, session }
      );
      if (enforce && amountKobo > limit) throw Object.assign(new Error('over'), { code: 11000 });
    } catch (err) {
      if (isDuplicateKey(err)) {
        throw E.limitExceeded(`This would exceed your ${period.startsWith('D') ? 'daily' : 'monthly'} ${kind} limit of ${koboToNairaString(limit)}`, { limitKobo: limit });
      }
      throw err;
    }
    if (!enforce) {
      const c = await LimitCounter.findOne({ userId: user._id, kind, period }).session(session).lean();
      if (c.totalKobo > limit) exceeded.push({ period, limit, total: c.totalKobo });
    }
  }
  return { exceeded };
}

/** Give back limit headroom (e.g. a rejected withdrawal). */
async function release(userId, kind, amountKobo, createdAt, session) {
  const { day, month } = lagosParts(createdAt);
  await LimitCounter.updateMany({ userId, kind, period: { $in: [day, month] } }, { $inc: { totalKobo: -amountKobo, count: -1 } }, { session });
}

async function usage(user) {
  const lim = await tierLimits(user.verificationTier);
  const { day, month } = lagosParts();
  const counters = await LimitCounter.find({ userId: user._id, period: { $in: [day, month] } }).lean();
  const used = (kind, period) => counters.find((c) => c.kind === kind && c.period === period)?.totalKobo || 0;
  return {
    tier: user.verificationTier,
    limits: lim,
    used: {
      fundingDaily: used('funding', day), fundingMonthly: used('funding', month),
      transferDaily: used('transfer', day),
      withdrawalDaily: used('withdrawal', day), withdrawalMonthly: used('withdrawal', month),
    },
  };
}

module.exports = { precheck, consume, release, usage, lagosParts, tierLimits };
