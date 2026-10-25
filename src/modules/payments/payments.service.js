'use strict';
/**
 * Provider-agnostic payment collection workflow.
 *
 *  initPayment → (customer pays at provider) → verifyAndFulfil (from webhook,
 *  status poll, scheduled sweep or reconciliation) → purpose handler posts the
 *  ledger transaction with reference PAY-<reference> (unique) exactly once.
 *
 * We NEVER credit because the browser returned; only a server-side verify
 * call that reports success with the exact expected amount fulfils a payment.
 */
const crypto = require('crypto');
const { PaymentAttempt, SavedCard } = require('./payment.models');
const paystack = require('../../providers/paystack/paystack.adapter');
const ledger = require('../ledger/ledger.service');
const { withTransaction } = require('../../lib/db');
const { E } = require('../../lib/errors');
const { encryptString } = require('../../lib/crypto');
const audit = require('../audit/audit.service');
const logger = require('../../lib/logger');
const config = require('../../config');

/** purpose -> { creditAccount(attempt, session) => entries/target, onSuccess(attempt, session), onFailure(attempt) } */
const handlers = new Map();
function registerPurpose(purpose, handler) {
  handlers.set(purpose, handler);
}

let reconciliationHook = async () => {};
function setExceptionReporter(fn) {
  reconciliationHook = fn;
}

const PREFIX = { wallet_funding: 'FND', order: 'ORD', savings_contribution: 'SAV', viewing_fee: 'VWF' };

function makeReference(purpose, idempotencyKey, userId) {
  if (idempotencyKey) {
    const h = crypto.createHash('sha256').update(`${userId}:${purpose}:${idempotencyKey}`).digest('hex').slice(0, 20).toUpperCase();
    return `MP-${PREFIX[purpose]}-${h}`;
  }
  return `MP-${PREFIX[purpose]}-${crypto.randomBytes(10).toString('hex').toUpperCase()}`;
}

async function initPayment({ user, purpose, amountKobo, feeKobo = 0, relatedType, relatedId, metadata = {}, idempotencyKey, saveCard = false, callbackPath }) {
  if (!handlers.has(purpose)) throw new Error(`No payment handler for ${purpose}`);
  paystack.requireConfigured();
  const reference = makeReference(purpose, idempotencyKey, user._id);
  const existing = await PaymentAttempt.findOne({ reference });
  if (existing) return existing;
  const timeoutMin = 30;
  let attempt;
  try {
    attempt = await PaymentAttempt.create({
      reference, purpose, userId: user._id, amountKobo, feeKobo, relatedType, relatedId: relatedId && String(relatedId), saveCard,
      expiresAt: new Date(Date.now() + timeoutMin * 60000), history: [{ at: new Date(), status: 'initialized', source: 'api' }],
    });
  } catch (err) {
    if (err.code === 11000) return PaymentAttempt.findOne({ reference });
    throw err;
  }
  const callbackUrl = `${config.FRONTEND_URL}${callbackPath || '/app/payments/return'}?reference=${encodeURIComponent(reference)}`;
  try {
    const init = await paystack.initializeTransaction({
      email: user.email, amountKobo: amountKobo + feeKobo, reference, callbackUrl,
      metadata: { purpose, relatedType, relatedId: relatedId && String(relatedId), userId: String(user._id), ...metadata },
    });
    attempt.authorizationUrl = init.authorizationUrl;
    attempt.accessCode = init.accessCode;
    attempt.status = 'pending';
    attempt.history.push({ at: new Date(), status: 'pending', source: 'provider_init' });
    await attempt.save();
    return attempt;
  } catch (err) {
    // The customer never received a payment page, so no money can have moved.
    attempt.status = 'failed';
    attempt.lastVerifyError = err.message;
    attempt.history.push({ at: new Date(), status: 'failed', source: 'provider_init', note: err.message });
    await attempt.save();
    if (err.outcome) throw E.provider('Could not start the payment with Paystack. No money was taken. Please try again.');
    throw err;
  }
}

/**
 * Verify the provider status and fulfil once. Safe to call any number of
 * times, concurrently, from any trigger.
 * Returns the (updated) attempt.
 */
async function verifyAndFulfil(reference, { source = 'manual' } = {}) {
  let attempt = await PaymentAttempt.findOne({ reference });
  if (!attempt) throw E.notFound('Payment');
  if (attempt.fulfilledAt) return attempt;
  if (['failed', 'amount_mismatch'].includes(attempt.status) && source !== 'reconciliation') return attempt;

  let v;
  try {
    v = await paystack.verifyTransaction(reference);
  } catch (err) {
    // Timeout / 5xx: outcome unknown. Never treat as failure.
    await PaymentAttempt.updateOne(
      { _id: attempt._id, fulfilledAt: null },
      { $inc: { verifyAttempts: 1 }, $set: { lastVerifyError: err.message, ...(attempt.status === 'pending' && attempt.verifyAttempts >= 3 ? { status: 'uncertain' } : {}) } }
    );
    logger.warn({ reference, err: err.message }, 'payment verification inconclusive');
    return PaymentAttempt.findById(attempt._id);
  }

  if (!v.found) {
    if (attempt.expiresAt && attempt.expiresAt < new Date(Date.now() - 6 * 3600e3)) {
      await PaymentAttempt.updateOne({ _id: attempt._id, fulfilledAt: null, status: { $in: ['pending', 'initialized', 'uncertain'] } }, { $set: { status: 'abandoned', verifiedAt: new Date() }, $push: { history: { at: new Date(), status: 'abandoned', source } } });
    }
    return PaymentAttempt.findById(attempt._id);
  }

  if (v.status === 'success') {
    const expected = attempt.amountKobo + attempt.feeKobo;
    if (v.amountKobo !== expected || v.currency !== 'NGN') {
      await PaymentAttempt.updateOne({ _id: attempt._id, fulfilledAt: null }, { $set: { status: 'amount_mismatch', providerStatus: v.status, verifiedAt: new Date(), lastVerifyError: `expected ${expected} NGN, provider reported ${v.amountKobo} ${v.currency}` }, $push: { history: { at: new Date(), status: 'amount_mismatch', source } } });
      await reconciliationHook({ type: 'amount_mismatch', reference, details: { expectedKobo: expected, providerKobo: v.amountKobo, currency: v.currency } });
      await audit.raiseAlert({ severity: 'critical', type: 'payment.amount_mismatch', message: `Payment ${reference} amount mismatch`, refType: 'payment', refId: reference, dedupeKey: `amount_mismatch:${reference}` });
      return PaymentAttempt.findById(attempt._id);
    }
    return fulfil(attempt._id, v, source);
  }

  if (['failed', 'abandoned', 'reversed'].includes(v.status)) {
    const updated = await PaymentAttempt.findOneAndUpdate(
      { _id: attempt._id, fulfilledAt: null, status: { $nin: ['success'] } },
      { $set: { status: v.status === 'reversed' ? 'failed' : v.status, providerStatus: v.status, gatewayResponse: v.gatewayResponse, verifiedAt: new Date() }, $push: { history: { at: new Date(), status: v.status, source } } },
      { new: true }
    );
    const h = handlers.get(attempt.purpose);
    if (updated && h?.onFailure) await h.onFailure(updated).catch((err) => logger.error({ err, reference }, 'payment onFailure handler error'));
    return updated || PaymentAttempt.findById(attempt._id);
  }

  // ongoing / pending / processing / queued
  await PaymentAttempt.updateOne({ _id: attempt._id }, { $set: { providerStatus: v.status }, $inc: { verifyAttempts: 1 } });
  return PaymentAttempt.findById(attempt._id);
}

async function fulfil(attemptId, v, source) {
  const base = await PaymentAttempt.findById(attemptId, { purpose: 1, reference: 1 }).lean();
  const handler = handlers.get(base.purpose);
  const doFulfil = async (useFallback) =>
    withTransaction(async (session) => {
      const attempt = await PaymentAttempt.findOneAndUpdate(
        { _id: attemptId, fulfilledAt: null },
        { $set: { status: 'success', providerStatus: v.status, paidAt: v.paidAt ? new Date(v.paidAt) : new Date(), verifiedAt: new Date(), providerTransactionId: v.providerTransactionId, providerFeesKobo: v.feesKobo, channel: v.channel, gatewayResponse: v.gatewayResponse, fulfilledAt: new Date(), fulfillmentReference: `PAY-${base.reference}` }, $push: { history: { at: new Date(), status: 'success', source } } },
        { new: true, session }
      );
      if (!attempt) return null; // someone else fulfilled concurrently
      const target = useFallback ? { account: ledger.userCodes(attempt.userId).wallet } : await handler.creditTarget(attempt, session);
      const entries = [
        { account: ledger.SYS.PAYSTACK_BALANCE, direction: 'debit', amount: attempt.amountKobo + attempt.feeKobo },
        { account: target.account, direction: 'credit', amount: attempt.amountKobo },
      ];
      if (attempt.feeKobo > 0) entries.push({ account: ledger.SYS.REVENUE_FEES, direction: 'credit', amount: attempt.feeKobo });
      if (Number.isSafeInteger(v.feesKobo) && v.feesKobo > 0) {
        entries.push({ account: ledger.SYS.PROVIDER_FEES, direction: 'debit', amount: v.feesKobo });
        entries.push({ account: ledger.SYS.PAYSTACK_BALANCE, direction: 'credit', amount: v.feesKobo });
      }
      const tx = await ledger.post(
        {
          reference: attempt.fulfillmentReference,
          type: useFallback ? 'wallet_funding' : target.ledgerType,
          description: useFallback ? `Payment ${attempt.reference} credited to wallet (original purpose could not be completed)` : target.description,
          entries,
          relatedType: 'payment',
          relatedId: attempt.reference,
          metadata: { purpose: attempt.purpose, providerTransactionId: v.providerTransactionId, providerFeesKobo: v.feesKobo, fallback: useFallback },
        },
        session
      );
      if (useFallback) {
        attempt.fulfillmentError = 'Original purpose could not be completed; funds credited to wallet';
        await attempt.save({ session });
      } else if (handler.onSuccess) {
        await handler.onSuccess(attempt, session, tx);
      }
      if (attempt.saveCard && v.authorization?.reusable) {
        await SavedCard.updateOne(
          { userId: attempt.userId, signature: v.authorization.signature, status: 'active' },
          { $setOnInsert: { authorizationCodeEnc: encryptString(v.authorization.authorizationCode), last4: v.authorization.last4, brand: v.authorization.brand, bank: v.authorization.bank, expMonth: v.authorization.expMonth, expYear: v.authorization.expYear } },
          { upsert: true, session }
        );
      }
      return { attempt, tx };
    });

  let result;
  try {
    result = await doFulfil(false);
  } catch (err) {
    if (err instanceof ledger.DuplicatePostingError) return PaymentAttempt.findById(attemptId);
    if (!err.expose) throw err;
    // Business rule failure (e.g. order no longer payable). Money WAS received: credit wallet instead.
    logger.warn({ attemptId, err: err.message }, 'payment purpose failed, crediting wallet');
    result = await doFulfil(true);
  }
  if (result?.attempt) {
    const h = handler;
    if (h.afterCommit) await h.afterCommit(result.attempt, result.tx).catch((err) => logger.error({ err }, 'payment afterCommit error'));
  }
  return PaymentAttempt.findById(attemptId);
}

/** Status for the client — triggers a verify if still pending (throttled by verifiedAt). */
async function statusFor(user, reference) {
  let attempt = await PaymentAttempt.findOne({ reference, userId: user._id });
  if (!attempt) throw E.notFound('Payment');
  if (!attempt.fulfilledAt && ['pending', 'initialized', 'uncertain'].includes(attempt.status) && config.integrations.paystack) {
    const last = attempt.updatedAt?.getTime() || 0;
    if (Date.now() - last > 3000 || attempt.verifyAttempts === 0) attempt = await verifyAndFulfil(reference, { source: 'client_poll' });
  }
  return present(attempt);
}

function present(a) {
  return {
    reference: a.reference, purpose: a.purpose, amountKobo: a.amountKobo, feeKobo: a.feeKobo, status: a.status,
    fulfilled: Boolean(a.fulfilledAt), fulfillmentNote: a.fulfillmentError, relatedType: a.relatedType, relatedId: a.relatedId,
    authorizationUrl: a.fulfilledAt || a.status !== 'pending' ? undefined : a.authorizationUrl, createdAt: a.createdAt, paidAt: a.paidAt,
    statusExplanation: {
      pending: 'Waiting for confirmation from Paystack. This page updates automatically.',
      uncertain: 'We could not reach Paystack to confirm this payment yet. We will keep checking — do not pay again.',
      success: 'Payment confirmed.',
      failed: 'The payment was not completed. No money was taken by MubaPay.',
      abandoned: 'The payment was not completed.',
      amount_mismatch: 'The amount received did not match. Our team has been alerted and will contact you.',
      initialized: 'Payment is being prepared.',
    }[a.status],
  };
}

module.exports = { registerPurpose, initPayment, verifyAndFulfil, statusFor, present, setExceptionReporter, makeReference };
