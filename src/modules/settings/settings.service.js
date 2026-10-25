'use strict';
const { z } = require('zod');
const DEFAULTS = require('./settings.defaults');
const { PlatformSetting, SettingVersion, FeatureFlag } = require('./settings.model');
const { withTransaction } = require('../../lib/db');
const { E } = require('../../lib/errors');
const audit = require('../audit/audit.service');
const config = require('../../config');

const CACHE_TTL_MS = 5000;
const cache = new Map(); // key -> { value, at }

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}
function deepMerge(base, over) {
  if (!isPlainObject(base) || !isPlainObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const k of Object.keys(over)) out[k] = deepMerge(base[k], over[k]);
  return out;
}

async function get(key, { fresh = false, session } = {}) {
  if (!(key in DEFAULTS)) throw E.notFound(`Setting ${key}`);
  const c = cache.get(key);
  if (!fresh && !session && c && Date.now() - c.at < CACHE_TTL_MS) return c.value;
  const doc = await PlatformSetting.findOne({ key }).session(session || null).lean();
  const value = deepMerge(DEFAULTS[key], doc?.value || {});
  if (!session) cache.set(key, { value, at: Date.now() });
  return value;
}

async function getAll() {
  const out = {};
  for (const k of Object.keys(DEFAULTS)) out[k] = await get(k);
  return out;
}

function invalidate(key) {
  if (key) cache.delete(key);
  else cache.clear();
}

// ---------- validation of updates ----------
const feeRule = z.object({
  type: z.enum(['none', 'fixed', 'percent', 'percent_plus_fixed']),
  fixedKobo: z.number().int().min(0).optional(),
  bp: z.number().int().min(0).max(10000).optional(),
  minKobo: z.number().int().min(0).optional(),
  maxKobo: z.number().int().min(0).optional(),
});
const kobo = z.number().int().min(0);
const validators = {
  fees: z.record(feeRule),
  feeCaps: z.object({ maxPercentBp: z.number().int().min(0).max(10000), maxFixedKobo: kobo, earlyExitMaxBp: z.number().int().min(0).max(5000), earlyExitMaxFixedKobo: kobo, maxViewingFeeKobo: kobo }).partial(),
  limits: z.object({ tiers: z.record(z.record(kobo)), minFundingKobo: kobo, minWithdrawalKobo: kobo }).partial(),
  verification: z.object({ financialMinTier: z.number().int().min(0).max(3), withdrawalMinTier: z.number().int().min(1).max(3), usedSellerMinTier: z.number().int().min(0).max(3), acceptedIdTypes: z.array(z.string()) }).partial(),
  risk: z.object({ holdTransferAboveKobo: kobo, dualApprovalWithdrawalAboveKobo: kobo, dualApprovalAdjustmentAlways: z.boolean(), maxTransfersPerHour: z.number().int().min(1), newAccountHoldDays: z.number().int().min(0) }).partial(),
  savings: z.object({ allowedFrequencies: z.array(z.enum(['daily', 'weekly', 'monthly'])), minDurationDays: z.number().int().min(1), maxDurationDays: z.number().int().min(1), minContributionKobo: kobo, graceDays: z.number().int().min(0).max(30), reminderHoursBefore: z.number().int().min(0), maxConsecutiveMissedBeforePause: z.number().int().min(1) }).partial(),
  marketplace: z.object({ reportAutoHideDistinctReporters: z.number().int().min(1), reportAutoHideSeriousCategories: z.array(z.string()), reportAutoHideSeriousThreshold: z.number().int().min(1), settlementHoldHoursAfterDelivery: z.number().int().min(0), refundRequestWindowDays: z.number().int().min(0), paymentTimeoutMinutes: z.number().int().min(5), collectionCodeTtlDays: z.number().int().min(1) }).partial(),
  delivery: z.object({
    coverageStates: z.array(z.string().min(2)),
    providerPriority: z.array(z.string()),
    selectionStrategy: z.enum(['cheapest', 'fastest', 'priority']),
    configuredRates: z.array(z.object({ fromState: z.string(), toState: z.string(), feeKobo: kobo, etaDays: z.number().int().min(0) })),
    configuredRateEnabled: z.boolean(),
    maxRedeliveryAttempts: z.number().int().min(0).max(10),
    collectionPoints: z.array(z.object({ id: z.string(), name: z.string(), address: z.string(), state: z.string() })),
    defaultOrigin: z.object({ state: z.string(), city: z.string(), addressCode: z.union([z.string(), z.number(), z.null()]) }).partial(),
  }).partial(),
  property: z.object({ viewingCancellationHours: z.number().int().min(0), viewingFeeReleaseHoursAfter: z.number().int().min(0), noShowReportWindowHours: z.number().int().min(1), maxMediaPerListing: z.number().int().min(1).max(100) }).partial(),
  notifications: z.object({ mandatoryCategories: z.array(z.string()) }).partial(),
  security: z.object({ staffTwoFactorRequired: z.literal(true), maxFailedLogins: z.number().int().min(3).max(20), lockMinutes: z.number().int().min(1), ipLoginAttemptsPerHour: z.number().int().min(5) }).partial(),
  compliance: z.object({ walletOperationsAuthorized: z.boolean(), authorizationReference: z.string().nullable(), savingsAuthorized: z.boolean(), settlementHoldingAuthorized: z.boolean() }).partial(),
  maintenance: z.object({ enabled: z.boolean(), message: z.string().max(300) }).partial(),
  branding: z.object({ appName: z.string().max(40), supportEmail: z.string().email(), supportWhatsApp: z.string().nullable(), primaryColor: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).partial(),
};

async function validateFeesAgainstCaps(fees, caps) {
  for (const [name, rule] of Object.entries(fees)) {
    if (rule.bp != null && rule.bp > caps.maxPercentBp) throw E.validation([{ path: `fees.${name}.bp`, message: `Exceeds permitted maximum of ${caps.maxPercentBp} bp` }]);
    if (rule.fixedKobo != null && rule.fixedKobo > caps.maxFixedKobo) throw E.validation([{ path: `fees.${name}.fixedKobo`, message: 'Exceeds permitted maximum fixed fee' }]);
  }
}

/**
 * Update a settings key. Superadmin only (enforced by route permission and here).
 * Some keys (compliance) are routed through dual approval by the caller.
 */
async function update(key, patch, { actor, reason, req, bypassDualApproval = false } = {}) {
  if (!validators[key]) throw E.notFound(`Setting ${key}`);
  if (!actor?.roles?.includes('superadmin')) throw E.forbidden('Only superadmins can change platform settings');
  if (key === 'compliance' && !bypassDualApproval) throw E.forbidden('Compliance settings must be changed through dual approval');
  if (!reason || reason.trim().length < 5) throw E.validation([{ path: 'reason', message: 'A reason of at least 5 characters is required' }]);
  const parsed = validators[key].safeParse(patch);
  if (!parsed.success) throw E.validation(parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })));
  const current = await get(key, { fresh: true });
  const next = deepMerge(current, parsed.data);
  if (key === 'fees') await validateFeesAgainstCaps(next, await get('feeCaps', { fresh: true }));
  if (key === 'savings' && next.minDurationDays > next.maxDurationDays) throw E.validation([{ path: 'minDurationDays', message: 'Must be <= maxDurationDays' }]);
  if (key === 'compliance' && next.walletOperationsAuthorized && !next.authorizationReference) {
    throw E.validation([{ path: 'authorizationReference', message: 'A licence or partner-arrangement reference is required' }]);
  }

  const saved = await withTransaction(async (session) => {
    const doc = await PlatformSetting.findOneAndUpdate(
      { key },
      { $set: { value: next, updatedBy: actor._id }, $inc: { version: 1 } },
      { upsert: true, new: true, session, setDefaultsOnInsert: true }
    );
    await SettingVersion.create([{ key, version: doc.version, value: next, previous: current, changedBy: actor._id, reason }], { session });
    await audit.record(
      { ...audit.ctxFrom(req), actor, action: 'settings.update', category: 'config', targetType: 'setting', targetId: key, reason, metadata: { version: doc.version, patch: parsed.data } },
      { session }
    );
    return doc;
  });
  invalidate(key);
  await audit.raiseAlert({ severity: key === 'compliance' || key === 'limits' || key === 'fees' ? 'warning' : 'info', type: 'settings.changed', message: `Setting "${key}" changed to v${saved.version} by ${actor.email}`, refType: 'setting', refId: key });
  return { key, version: saved.version, value: next };
}

async function history(key, limit = 50) {
  return SettingVersion.find({ key }).sort({ version: -1 }).limit(limit).populate('changedBy', 'email firstName lastName').lean();
}

// ---------- feature flags ----------
const FLAG_DEFAULTS = {
  wallet_funding: { enabled: true, description: 'Wallet funding via Paystack' },
  transfers: { enabled: true, description: 'Wallet-to-wallet transfers' },
  withdrawals: { enabled: true, description: 'Withdrawal requests' },
  personal_savings: { enabled: true, description: 'Personal savings plans' },
  marketplace_checkout: { enabled: true, description: 'Marketplace checkout' },
  used_listings: { enabled: true, description: 'Fairly-used product submissions' },
  seller_settlements: { enabled: true, description: 'Seller settlement release' },
  property_listings: { enabled: true, description: 'Property listing submissions' },
  property_viewing_fees: { enabled: true, description: 'Paid viewing appointments' },
  logistics_shipbubble: { enabled: true, description: 'Shipbubble logistics provider' },
  logistics_configured_rate: { enabled: true, description: 'Operator-configured delivery rates' },
  live_chat: { enabled: true, description: 'Live support chat' },
  whatsapp_support: { enabled: true, description: 'WhatsApp support channel' },
  sponsored_listings: { enabled: false, description: 'Paid promotions (always labelled as sponsored)' },
  group_savings: { enabled: false, description: 'Group savings (later phase — not available)', laterPhase: true },
  purpose_savings: { enabled: false, description: 'Purpose-based savings (later phase — not available)', laterPhase: true },
};

const flagCache = { value: null, at: 0 };

async function listFlags() {
  if (flagCache.value && Date.now() - flagCache.at < CACHE_TTL_MS) return flagCache.value;
  const stored = await FeatureFlag.find({}).lean();
  const map = {};
  for (const [k, d] of Object.entries(FLAG_DEFAULTS)) map[k] = { key: k, ...d, laterPhase: Boolean(d.laterPhase) };
  for (const f of stored) if (map[f.key]) map[f.key] = { ...map[f.key], enabled: map[f.key].laterPhase ? false : f.enabled, updatedAt: f.updatedAt };
  flagCache.value = map;
  flagCache.at = Date.now();
  return map;
}

async function isEnabled(key) {
  const flags = await listFlags();
  return Boolean(flags[key]?.enabled);
}

async function setFlag(key, enabled, { actor, reason, req }) {
  if (!FLAG_DEFAULTS[key]) throw E.notFound(`Feature flag ${key}`);
  if (!actor?.roles?.includes('superadmin')) throw E.forbidden('Only superadmins can change feature flags');
  if (FLAG_DEFAULTS[key].laterPhase && enabled) throw E.conflict('This module is scheduled for a later phase and cannot be enabled in this release', 'LATER_PHASE');
  if (!reason || reason.trim().length < 5) throw E.validation([{ path: 'reason', message: 'A reason is required' }]);
  await withTransaction(async (session) => {
    await FeatureFlag.findOneAndUpdate({ key }, { $set: { enabled, updatedBy: actor._id, description: FLAG_DEFAULTS[key].description } }, { upsert: true, session });
    await audit.record({ ...audit.ctxFrom(req), actor, action: 'feature_flag.set', category: 'config', targetType: 'feature_flag', targetId: key, reason, metadata: { enabled } }, { session });
  });
  flagCache.value = null;
  await audit.raiseAlert({ severity: 'warning', type: 'feature_flag.changed', message: `Feature "${key}" ${enabled ? 'enabled' : 'disabled'} by ${actor.email}`, refType: 'feature_flag', refId: key });
  return (await listFlags())[key];
}

function invalidateFlags() {
  flagCache.value = null;
}

/**
 * Gate for financial features. Feature flags can only DISABLE functionality;
 * they never bypass auth, verification, approvals or compliance controls.
 * In production, custody features additionally require an explicit compliance
 * authorisation recorded by superadmins via dual approval.
 */
async function assertFeature(flagKey, { complianceKey } = {}) {
  if (!(await isEnabled(flagKey))) throw E.featureDisabled(flagKey);
  if (config.isProduction && complianceKey) {
    const compliance = await get('compliance');
    if (!compliance[complianceKey]) {
      throw new (require('../../lib/errors').AppError)(
        503,
        'REGULATORY_AUTHORIZATION_REQUIRED',
        'This financial service is not yet available. Required regulatory/partner authorisation has not been confirmed.'
      );
    }
  }
}

module.exports = { get, getAll, update, history, invalidate, listFlags, isEnabled, setFlag, invalidateFlags, assertFeature, DEFAULTS, FLAG_DEFAULTS, deepMerge };
