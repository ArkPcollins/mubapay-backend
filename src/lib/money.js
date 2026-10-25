'use strict';
/**
 * Money helpers. ALL monetary values are integer kobo (1 NGN = 100 kobo).
 * Never use floating point for money. Percentages are expressed in basis
 * points (1 bp = 0.01%), so 2.5% = 250 bp.
 *
 * Rounding rule for percentage fees: round half up to the nearest kobo
 * (computed with integer arithmetic only).
 */
const { E } = require('./errors');

const MAX_KOBO = 1_000_000_000_000_00; // ₦1 trillion safety ceiling

function assertKobo(v, field = 'amount') {
  if (!Number.isSafeInteger(v)) throw E.validation([{ path: field, message: 'Amount must be an integer number of kobo' }]);
  if (v < 0) throw E.validation([{ path: field, message: 'Amount cannot be negative' }]);
  if (v > MAX_KOBO) throw E.validation([{ path: field, message: 'Amount exceeds the maximum supported value' }]);
  return v;
}

function assertPositiveKobo(v, field = 'amount') {
  assertKobo(v, field);
  if (v === 0) throw E.validation([{ path: field, message: 'Amount must be greater than zero' }]);
  return v;
}

/** Parse a naira string like "1,500.50" into kobo exactly (no floats). */
function nairaToKobo(input) {
  const s = String(input).replace(/[₦,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) throw E.validation([{ path: 'amount', message: 'Invalid naira amount' }]);
  const [whole, frac = ''] = s.split('.');
  return assertKobo(Number(whole) * 100 + Number(frac.padEnd(2, '0')));
}

function koboToNairaString(kobo) {
  const neg = kobo < 0;
  const abs = Math.abs(kobo);
  const naira = Math.floor(abs / 100);
  const k = abs % 100;
  const whole = naira.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}₦${whole}${k ? '.' + String(k).padStart(2, '0') : ''}`;
}

/** Percentage of an amount in basis points, rounded half-up, integer-only. */
function percentBp(amountKobo, bp) {
  assertKobo(amountKobo);
  if (!Number.isInteger(bp) || bp < 0 || bp > 10000) throw E.validation([{ path: 'bp', message: 'Basis points must be 0..10000' }]);
  // (a*bp + 5000) / 10000 using BigInt to avoid overflow
  const r = (BigInt(amountKobo) * BigInt(bp) + 5000n) / 10000n;
  return Number(r);
}

/**
 * Compute a fee from a fee rule: { type: 'fixed'|'percent'|'none', fixedKobo, bp, minKobo, maxKobo }
 */
function computeFee(amountKobo, rule) {
  if (!rule || rule.type === 'none') return 0;
  let fee = 0;
  if (rule.type === 'fixed') fee = rule.fixedKobo || 0;
  else if (rule.type === 'percent') fee = percentBp(amountKobo, rule.bp || 0);
  else if (rule.type === 'percent_plus_fixed') fee = percentBp(amountKobo, rule.bp || 0) + (rule.fixedKobo || 0);
  if (rule.minKobo != null) fee = Math.max(fee, rule.minKobo);
  if (rule.maxKobo != null) fee = Math.min(fee, rule.maxKobo);
  return assertKobo(fee, 'fee');
}

function sum(values) {
  return values.reduce((a, b) => a + b, 0);
}

module.exports = { assertKobo, assertPositiveKobo, nairaToKobo, koboToNairaString, percentBp, computeFee, sum, MAX_KOBO };
