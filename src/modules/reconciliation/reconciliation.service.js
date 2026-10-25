'use strict';
/**
 * Reconciliation compares internal records with provider records and with the
 * ledger's own invariants. It NEVER invents transactions or edits ledger
 * history: mismatches become exceptions for authorised staff to resolve
 * (typically via a dual-approved correction).
 */
const { mongoose } = require('../../lib/db');
const { PaymentAttempt, ProviderEvent } = require('../payments/payment.models');
const { Withdrawal } = require('../wallet/wallet.models');
const paystack = require('../../providers/paystack/paystack.adapter');
const payments = require('../payments/payments.service');
const wallet = require('../wallet/wallet.service');
const ledger = require('../ledger/ledger.service');
const audit = require('../audit/audit.service');
const config = require('../../config');
const logger = require('../../lib/logger');
const { E } = require('../../lib/errors');

const { Schema } = mongoose;
const runSchema = new Schema(
  {
    type: { type: String, enum: ['paystack_payments', 'payouts', 'ledger_invariants', 'pending_sweep'], required: true },
    from: Date,
    to: Date,
    status: { type: String, enum: ['running', 'completed', 'failed', 'skipped'], default: 'running' },
    stats: Schema.Types.Mixed,
    error: String,
    triggeredBy: { type: Schema.Types.ObjectId, ref: 'User' },
    finishedAt: Date,
  },
  { timestamps: true }
);
runSchema.index({ type: 1, createdAt: -1 });

const exceptionSchema = new Schema(
  {
    runId: { type: Schema.Types.ObjectId, ref: 'ReconciliationRun' },
    type: { type: String, required: true, enum: ['missing_internal', 'missing_at_provider', 'amount_mismatch', 'status_mismatch', 'duplicate_event', 'unmatched_provider_reference', 'uncertain_payout', 'ledger_invariant', 'stale_pending'] },
    reference: String,
    details: Schema.Types.Mixed,
    severity: { type: String, enum: ['low', 'medium', 'high', 'critical'], default: 'medium' },
    status: { type: String, enum: ['open', 'investigating', 'resolved', 'dismissed'], default: 'open' },
    dedupeKey: String,
    resolution: { by: { type: Schema.Types.ObjectId, ref: 'User' }, at: Date, note: String, approvalId: String },
  },
  { timestamps: true }
);
exceptionSchema.index({ status: 1, createdAt: -1 });
exceptionSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { status: { $in: ['open', 'investigating'] }, dedupeKey: { $type: 'string' } } });

const ReconciliationRun = mongoose.models.ReconciliationRun || mongoose.model('ReconciliationRun', runSchema);
const ReconciliationException = mongoose.models.ReconciliationException || mongoose.model('ReconciliationException', exceptionSchema);

async function addException({ runId, type, reference, details, severity = 'high' }) {
  const dedupeKey = `${type}:${reference || JSON.stringify(details).slice(0, 80)}`;
  try {
    return await ReconciliationException.create({ runId, type, reference, details, severity, dedupeKey });
  } catch (err) {
    if (err.code === 11000) return null;
    throw err;
  }
}
payments.setExceptionReporter((e) => addException({ ...e, severity: 'critical' }));

/** Re-verify payments stuck in pending/uncertain. */
async function sweepPendingPayments({ olderThanMs = 2 * 60e3, limit = 100 } = {}) {
  if (!config.integrations.paystack) return { skipped: 'paystack_not_configured' };
  const due = await PaymentAttempt.find({ fulfilledAt: null, status: { $in: ['pending', 'uncertain', 'initialized'] }, updatedAt: { $lt: new Date(Date.now() - olderThanMs) } }).limit(limit);
  let fulfilled = 0;
  for (const a of due) {
    // eslint-disable-next-line no-await-in-loop
    const r = await payments.verifyAndFulfil(a.reference, { source: 'sweeper' }).catch((err) => logger.warn({ err: err.message }, 'sweep verify failed'));
    if (r?.fulfilledAt) fulfilled += 1;
  }
  const stale = await PaymentAttempt.find({ fulfilledAt: null, status: 'uncertain', createdAt: { $lt: new Date(Date.now() - 24 * 3600e3) } }, { reference: 1 }).limit(50).lean();
  for (const s of stale) await addException({ type: 'stale_pending', reference: s.reference, details: { note: 'Payment outcome unknown for over 24 hours' }, severity: 'medium' });
  return { checked: due.length, fulfilled, stale: stale.length };
}

/** Compare Paystack's transaction list with internal payment attempts for a window. */
async function reconcilePaystack({ from, to, triggeredBy } = {}) {
  const end = to ? new Date(to) : new Date();
  const start = from ? new Date(from) : new Date(end.getTime() - 48 * 3600e3);
  if (!config.integrations.paystack) {
    return ReconciliationRun.create({ type: 'paystack_payments', from: start, to: end, status: 'skipped', error: 'Paystack not configured', finishedAt: new Date(), triggeredBy });
  }
  const run = await ReconciliationRun.create({ type: 'paystack_payments', from: start, to: end, triggeredBy });
  const stats = { providerRecords: 0, matched: 0, recoveredFulfilments: 0, exceptions: 0 };
  try {
    const providerByRef = new Map();
    for (let page = 1; page <= 50; page++) {
      // eslint-disable-next-line no-await-in-loop
      const { items, meta } = await paystack.listTransactions({ from: start, to: end, page, perPage: 100 });
      for (const t of items) providerByRef.set(t.reference, t);
      if (!meta.pageCount || page >= meta.pageCount || items.length === 0) break;
    }
    stats.providerRecords = providerByRef.size;
    const internal = await PaymentAttempt.find({ createdAt: { $gte: new Date(start.getTime() - 3600e3), $lte: end } }).lean();
    const internalByRef = new Map(internal.map((a) => [a.reference, a]));

    for (const [ref, p] of providerByRef) {
      const a = internalByRef.get(ref) || (await PaymentAttempt.findOne({ reference: ref }).lean());
      if (!a) {
        stats.exceptions += 1;
        await addException({ runId: run._id, type: 'unmatched_provider_reference', reference: ref, details: p });
        continue;
      }
      if (p.status === 'success') {
        if (p.amountKobo !== a.amountKobo + a.feeKobo) {
          stats.exceptions += 1;
          await addException({ runId: run._id, type: 'amount_mismatch', reference: ref, details: { providerKobo: p.amountKobo, expectedKobo: a.amountKobo + a.feeKobo }, severity: 'critical' });
        } else if (!a.fulfilledAt) {
          // eslint-disable-next-line no-await-in-loop
          const r = await payments.verifyAndFulfil(ref, { source: 'reconciliation' });
          if (r.fulfilledAt) stats.recoveredFulfilments += 1;
          else {
            stats.exceptions += 1;
            await addException({ runId: run._id, type: 'missing_internal', reference: ref, details: { note: 'Provider reports success but internal record not fulfilled', internalStatus: r.status } });
          }
        } else stats.matched += 1;
      } else if (a.fulfilledAt) {
        stats.exceptions += 1;
        await addException({ runId: run._id, type: 'status_mismatch', reference: ref, details: { providerStatus: p.status, internalStatus: a.status }, severity: 'critical' });
      }
    }
    for (const a of internal) {
      if (a.fulfilledAt && a.createdAt >= start && !providerByRef.has(a.reference)) {
        stats.exceptions += 1;
        await addException({ runId: run._id, type: 'missing_at_provider', reference: a.reference, details: { note: 'Fulfilled internally but absent from provider list for window' } });
      }
    }
    const dupes = await ProviderEvent.find({ receivedCount: { $gt: 1 }, updatedAt: { $gte: start } }, { eventKey: 1, reference: 1, receivedCount: 1 }).limit(100).lean();
    stats.duplicateWebhooksAbsorbed = dupes.length;
    run.status = 'completed';
    run.stats = stats;
  } catch (err) {
    run.status = 'failed';
    run.error = err.message;
    run.stats = stats;
    await audit.raiseAlert({ severity: 'warning', type: 'reconciliation.failed', message: `Paystack reconciliation failed: ${err.message}`, dedupeKey: 'recon_paystack_failed' });
  }
  run.finishedAt = new Date();
  await run.save();
  if (stats.exceptions) await audit.raiseAlert({ severity: 'critical', type: 'reconciliation.exceptions', message: `${stats.exceptions} reconciliation exception(s) found`, refType: 'reconciliation_run', refId: run._id });
  return run;
}

async function reconcilePayouts({ triggeredBy } = {}) {
  const run = await ReconciliationRun.create({ type: 'payouts', triggeredBy });
  const r = await wallet.sweepPayouts();
  const uncertain = await Withdrawal.find({ status: 'payout_uncertain', updatedAt: { $lt: new Date(Date.now() - 6 * 3600e3) } }, { reference: 1, payoutReference: 1 }).lean();
  for (const w of uncertain) await addException({ runId: run._id, type: 'uncertain_payout', reference: w.reference, details: { payoutReference: w.payoutReference } });
  run.status = 'completed';
  run.stats = { ...r, uncertain: uncertain.length };
  run.finishedAt = new Date();
  await run.save();
  return run;
}

async function checkLedger({ triggeredBy } = {}) {
  const run = await ReconciliationRun.create({ type: 'ledger_invariants', triggeredBy });
  const res = await ledger.checkInvariants();
  for (const p of res.problems) await addException({ runId: run._id, type: 'ledger_invariant', reference: p.account || p.transactionId, details: p, severity: 'critical' });
  if (!res.ok) await audit.raiseAlert({ severity: 'critical', type: 'ledger.invariant_violation', message: `${res.problems.length} ledger invariant problem(s) detected`, dedupeKey: 'ledger_invariants' });
  run.status = 'completed';
  run.stats = { ok: res.ok, problems: res.problems.length, accountsChecked: res.accountsChecked };
  run.finishedAt = new Date();
  await run.save();
  return run;
}

async function resolveException(staff, id, { status, note }, req) {
  if (!['investigating', 'resolved', 'dismissed'].includes(status)) throw E.badRequest('Invalid status');
  if (!note || note.length < 10) throw E.validation([{ path: 'note', message: 'Resolution note (10+ chars) required' }]);
  const ex = await ReconciliationException.findByIdAndUpdate(id, { $set: { status, resolution: { by: staff._id, at: new Date(), note } } }, { new: true });
  if (!ex) throw E.notFound('Exception');
  await audit.fromReq(req, { action: 'reconciliation.exception_updated', category: 'finance', targetType: 'reconciliation_exception', targetId: id, reason: note, metadata: { status } });
  return ex;
}

module.exports = { ReconciliationRun, ReconciliationException, sweepPendingPayments, reconcilePaystack, reconcilePayouts, checkLedger, resolveException, addException };
