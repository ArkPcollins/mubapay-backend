'use strict';
/**
 * Central refund & dispute workflow for orders and viewing appointments.
 * Refunds move money that MubaPay is still holding (clearing accounts) back to
 * the customer — the wallet by default, or the original card via Paystack
 * where the payment was made that way. Money is never created: a refund can
 * never exceed what remains in clearing for that subject. Once funds have been
 * settled to a seller/provider, a refund requires a dual-approved correction.
 */
const crypto = require('crypto');
const { RefundRequest, Dispute, Order } = require('../marketplace/marketplace.models');
const { PaymentAttempt } = require('../payments/payment.models');
const ledger = require('../ledger/ledger.service');
const paystack = require('../../providers/paystack/paystack.adapter');
const notifications = require('../notifications/notifications.service');
const audit = require('../audit/audit.service');
const settings = require('../settings/settings.service');
const { withTransaction } = require('../../lib/db');
const { E } = require('../../lib/errors');
const { assertPositiveKobo, koboToNairaString } = require('../../lib/money');
const { hasPermission } = require('../../middleware/auth');
const logger = require('../../lib/logger');

const ref = (p) => `${p}-${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

/** Subject adapters: order (here) and appointment (registered by the appointments module). */
const subjects = new Map();
function registerSubject(type, adapter) {
  subjects.set(type, adapter);
}

const HOLD_STATES = ['refund_requested', 'disputed'];
const orderAdapter = {
  async load(id, session) {
    const o = await Order.findById(id).session(session || null);
    if (!o) throw E.notFound('Order');
    return o;
  },
  customerId: (o) => o.buyerId,
  providerId: (o) => o.sellerId,
  label: (o) => `order ${o.orderNumber}`,
  clearingAccount: () => ledger.SYS.ORDER_CLEARING,
  refundableKobo: (o) => (['settled', 'refunded', 'cancelled', 'pending_payment', 'payment_processing'].includes(o.status) ? 0 : o.totalKobo - o.refundedKobo),
  async paymentReference(o) {
    const { Checkout } = require('../marketplace/marketplace.models');
    const c = await Checkout.findById(o.checkoutId).lean();
    return c?.paymentMethod === 'paystack' ? c.paymentReference : null;
  },
  async assertCanRequest(o, user) {
    if (String(o.buyerId) !== String(user._id)) throw E.notFound('Order');
    const mk = await settings.get('marketplace');
    const windowDays = o.terms?.refundWindowDays ?? mk.refundRequestWindowDays;
    if (o.deliveredAt && Date.now() - o.deliveredAt.getTime() > windowDays * 864e5) throw E.conflict(`Refund requests must be made within ${windowDays} days of delivery`, 'REFUND_WINDOW_CLOSED');
  },
  async hold(o, status, session) {
    if (HOLD_STATES.includes(o.status)) return;
    const { orderMachine } = require('../marketplace/orders.service');
    await orderMachine.transition(Order, o._id, o.status, status, { statusBeforeHold: o.status }, { session, push: { statusHistory: { at: new Date(), status } } });
  },
  async release(o, session) {
    if (!HOLD_STATES.includes(o.status)) return;
    const prior = o.statusBeforeHold || 'paid';
    await Order.updateOne({ _id: o._id, status: o.status }, { $set: { status: prior }, $push: { statusHistory: { at: new Date(), status: prior, note: 'Resumed after review' } } }, { session });
  },
  async applyRefund(o, amount, session) {
    const refunded = o.refundedKobo + amount;
    const full = refunded >= o.totalKobo;
    const prior = HOLD_STATES.includes(o.status) ? o.statusBeforeHold : o.status;
    const postDelivery = ['delivered', 'collected', 'settlement_pending', 'partially_refunded'].includes(prior);
    const status = full ? 'refunded' : postDelivery ? 'partially_refunded' : prior;
    await Order.updateOne({ _id: o._id }, { $set: { refundedKobo: refunded, status }, $push: { statusHistory: { at: new Date(), status, note: `Refund ${koboToNairaString(amount)}` } } }, { session });
    if (full) {
      const { Product } = require('../marketplace/marketplace.models');
      if (!['delivered', 'collected', 'settlement_pending', 'partially_refunded', 'dispatched'].includes(prior)) {
        for (const it of o.items) await Product.updateOne({ _id: it.productId }, { $inc: { stock: it.quantity } }, { session });
      }
    }
  },
};
registerSubject('order', orderAdapter);

async function requestRefund(user, { subjectType, subjectId, amountKobo, reason, description, evidence, destination = 'wallet' }, req) {
  const a = subjects.get(subjectType);
  if (!a) throw E.badRequest('Unsupported refund subject');
  assertPositiveKobo(amountKobo);
  const s = await a.load(subjectId);
  await a.assertCanRequest(s, user);
  const pendingAgg = await RefundRequest.aggregate([{ $match: { subjectType, subjectId: s._id, status: { $in: ['pending_review', 'approved', 'processing'] } } }, { $group: { _id: null, t: { $sum: '$amountKobo' } } }]);
  const available = a.refundableKobo(s) - (pendingAgg[0]?.t || 0);
  if (amountKobo > available) throw E.conflict(`The most that can be refunded is ${koboToNairaString(Math.max(0, available))}`, 'REFUND_EXCEEDS_REMAINING', { availableKobo: Math.max(0, available) });
  if (destination === 'original_method' && !(await a.paymentReference(s))) throw E.badRequest('This payment cannot be refunded to a card; choose wallet');
  const doc = await withTransaction(async (session) => {
    const [r] = await RefundRequest.create([{ reference: ref('RFD'), subjectType, subjectId: s._id, requesterId: user._id, amountKobo, reason, description, evidence, destination, history: [{ at: new Date(), status: 'pending_review', by: user._id }] }], { session });
    await a.hold(s, 'refund_requested', session);
    await notifications.notify(user._id, { category: 'disputes', type: 'refund_requested', title: 'Refund request received', body: `We're reviewing your refund request for ${a.label(s)}.`, link: subjectType === 'order' ? `/app/orders/${s._id}` : `/app/appointments/${s._id}` }, { session });
    if (a.providerId(s)) await notifications.notify(a.providerId(s), { category: 'disputes', type: 'refund_requested_provider', title: 'Refund requested', body: `The customer requested a refund for ${a.label(s)}. Settlement is paused while we review.`, link: subjectType === 'order' ? `/app/seller/orders/${s._id}` : '/app/provider/appointments' }, { session });
    await audit.record({ ...audit.ctxFrom(req), actor: user, action: 'refund.requested', category: 'finance', targetType: subjectType, targetId: s._id, metadata: { amountKobo, reason } }, { session });
    return r;
  });
  await notifications.notifyStaff('refunds.decide', { category: 'system', type: 'refund_review', title: 'Refund request to review', body: `${koboToNairaString(amountKobo)} — ${a.label(s)}`, link: '/admin/refunds' });
  return doc;
}

/** Post the refund (system/staff path). Assumes caller validated permission. */
async function executeRefund(refund, { by, session }) {
  const a = subjects.get(refund.subjectType);
  const s = await a.load(refund.subjectId, session);
  if (refund.amountKobo > a.refundableKobo(s)) throw E.conflict('Refund exceeds the remaining refundable amount', 'REFUND_EXCEEDS_REMAINING');
  const customerId = a.customerId(s);
  await ledger.ensureUserAccounts(customerId);
  const destination = refund.destination === 'original_method' ? 'original_method' : 'wallet';
  const reference = `${refund.reference}-POST`;
  if (destination === 'wallet') {
    await ledger.post({ reference, type: 'order_refund', description: `Refund ${refund.reference} for ${a.label(s)}`, entries: [{ account: a.clearingAccount(s), direction: 'debit', amount: refund.amountKobo }, { account: ledger.userCodes(customerId).wallet, direction: 'credit', amount: refund.amountKobo }], initiatedBy: by, approvedBy: by ? [by] : undefined, relatedType: refund.subjectType, relatedId: s._id }, session);
    await RefundRequest.updateOne({ _id: refund._id }, { $set: { status: 'completed', ledgerReference: reference }, $push: { history: { at: new Date(), status: 'completed', by } } }, { session });
  } else {
    await ledger.post({ reference, type: 'card_refund', description: `Refund ${refund.reference} to original card`, entries: [{ account: a.clearingAccount(s), direction: 'debit', amount: refund.amountKobo }, { account: ledger.SYS.REFUND_PAYABLE, direction: 'credit', amount: refund.amountKobo }], initiatedBy: by, relatedType: refund.subjectType, relatedId: s._id }, session);
    await RefundRequest.updateOne({ _id: refund._id }, { $set: { status: 'processing', ledgerReference: reference }, $push: { history: { at: new Date(), status: 'processing', by } } }, { session });
  }
  await a.applyRefund(s, refund.amountKobo, session);
  await notifications.notify(customerId, { category: 'financial', type: 'refund_approved', title: 'Refund approved', body: destination === 'wallet' ? `${koboToNairaString(refund.amountKobo)} has been credited to your MubaPay wallet.` : `${koboToNairaString(refund.amountKobo)} is being returned to your card. Banks can take several working days.`, link: '/app/wallet', dedupeKey: `refund_ok:${refund.reference}` }, { session });
  return destination;
}

async function decide(staff, id, { decision, note, amountKobo }, req) {
  if (!['approve', 'reject'].includes(decision)) throw E.badRequest('decision must be approve or reject');
  if (!note || note.length < 5) throw E.validation([{ path: 'note', message: 'A decision note is required' }]);
  const r = await RefundRequest.findById(id);
  if (!r) throw E.notFound('Refund request');
  if (String(r.requesterId) === String(staff._id)) throw E.forbidden('You cannot decide your own refund');
  const a = subjects.get(r.subjectType);
  const subj = await a.load(r.subjectId);
  if (a.providerId(subj) && String(a.providerId(subj)) === String(staff._id)) throw E.forbidden('You are a party to this transaction');
  let destination;
  await withTransaction(async (session) => {
    const set = decision === 'approve' ? { status: 'approved', decision: { by: staff._id, at: new Date(), note } } : { status: 'rejected', decision: { by: staff._id, at: new Date(), note } };
    if (decision === 'approve' && amountKobo != null) {
      assertPositiveKobo(amountKobo);
      if (amountKobo > r.amountKobo) throw E.badRequest('Approved amount cannot exceed the requested amount');
      set.amountKobo = amountKobo;
    }
    const doc = await RefundRequest.findOneAndUpdate({ _id: r._id, status: 'pending_review' }, { $set: set, $push: { history: { at: new Date(), status: set.status, by: staff._id, note } } }, { new: true, session });
    if (!doc) throw E.invalidState('Refund request is not pending review');
    const s = await a.load(doc.subjectId, session);
    if (decision === 'approve') destination = await executeRefund(doc, { by: staff._id, session });
    else {
      const otherOpen = await RefundRequest.exists({ subjectType: r.subjectType, subjectId: r.subjectId, status: 'pending_review', _id: { $ne: r._id } }).session(session);
      const disputeOpen = await Dispute.exists({ subjectType: r.subjectType, subjectId: r.subjectId, status: { $in: ['open', 'under_review'] } }).session(session);
      if (!otherOpen && !disputeOpen) await a.release(s, session);
      await notifications.notify(doc.requesterId, { category: 'disputes', type: 'refund_rejected', title: 'Refund request declined', body: `Your refund request was declined: ${note}. You can open a dispute if you disagree.`, link: r.subjectType === 'order' ? `/app/orders/${r.subjectId}` : `/app/appointments/${r.subjectId}` }, { session });
    }
    await audit.record({ ...audit.ctxFrom(req), actor: staff, action: `refund.${decision}d`, category: 'finance', targetType: 'refund', targetId: r.reference, reason: note, metadata: { amountKobo: set.amountKobo || r.amountKobo } }, { session });
  });
  if (destination === 'original_method') await startCardRefund(r._id);
  return RefundRequest.findById(id);
}

async function startCardRefund(refundId) {
  const r = await RefundRequest.findById(refundId);
  const a = subjects.get(r.subjectType);
  const s = await a.load(r.subjectId);
  const paymentRef = await a.paymentReference(s);
  try {
    const res = await paystack.refundTransaction({ reference: paymentRef, amountKobo: r.amountKobo, merchantNote: r.reference });
    await RefundRequest.updateOne({ _id: r._id }, { $set: { providerRefundId: res.refundId } });
  } catch (err) {
    if (err.outcome === 'rejected' || err.code === 'INTEGRATION_NOT_CONFIGURED') await failCardRefundToWallet(r, `Card refund rejected: ${err.message}`);
    else logger.warn({ err: err.message, ref: r.reference }, 'card refund outcome unknown; will re-check');
  }
}

/** If a card refund fails, the money still belongs to the customer: credit their wallet. */
async function failCardRefundToWallet(r, reason) {
  const a = subjects.get(r.subjectType);
  const s = await a.load(r.subjectId);
  await withTransaction(async (session) => {
    const doc = await RefundRequest.findOneAndUpdate({ _id: r._id, status: 'processing' }, { $set: { status: 'completed', destination: 'wallet' }, $push: { history: { at: new Date(), status: 'card_refund_failed_credited_wallet', note: reason } } }, { new: true, session });
    if (!doc) return;
    await ledger.post({ reference: `${r.reference}-WALLET`, type: 'order_refund', description: `Card refund failed — credited to wallet (${r.reference})`, entries: [{ account: ledger.SYS.REFUND_PAYABLE, direction: 'debit', amount: r.amountKobo }, { account: ledger.userCodes(a.customerId(s)).wallet, direction: 'credit', amount: r.amountKobo }], relatedType: 'refund', relatedId: r.reference }, session);
    await notifications.notify(a.customerId(s), { category: 'financial', type: 'refund_to_wallet', title: 'Refund credited to wallet', body: `We couldn't return ${koboToNairaString(r.amountKobo)} to your card, so it was credited to your MubaPay wallet.`, link: '/app/wallet' }, { session });
  });
}

async function completeCardRefund(r) {
  await withTransaction(async (session) => {
    const doc = await RefundRequest.findOneAndUpdate({ _id: r._id, status: 'processing' }, { $set: { status: 'completed' }, $push: { history: { at: new Date(), status: 'completed', note: 'Processed by Paystack' } } }, { new: true, session });
    if (!doc) return;
    await ledger.post({ reference: `${r.reference}-CARD`, type: 'card_refund', description: `Card refund processed (${r.reference})`, entries: [{ account: ledger.SYS.REFUND_PAYABLE, direction: 'debit', amount: r.amountKobo }, { account: ledger.SYS.PAYSTACK_BALANCE, direction: 'credit', amount: r.amountKobo }], relatedType: 'refund', relatedId: r.reference }, session);
  });
}

/** Paystack refund.* webhooks and the sweeper: always re-check status via the API. */
async function checkCardRefunds() {
  const due = await RefundRequest.find({ status: 'processing', destination: 'original_method' }).limit(50);
  for (const r of due) {
    if (!r.providerRefundId) {
      if (Date.now() - r.updatedAt.getTime() > 3600e3) await startCardRefund(r._id);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const v = await paystack.fetchRefund(r.providerRefundId).catch(() => null);
    if (!v) continue;
    if (v.status === 'processed') await completeCardRefund(r);
    else if (v.status === 'failed') await failCardRefundToWallet(r, 'Paystack reported refund failure');
  }
  return { checked: due.length };
}

// ---------------------------------------------------------------- disputes
async function openDispute(user, { subjectType, subjectId, reason, description }, req) {
  const a = subjects.get(subjectType);
  if (!a) throw E.badRequest('Unsupported dispute subject');
  const s = await a.load(subjectId);
  const isCustomer = String(a.customerId(s)) === String(user._id);
  const isProvider = a.providerId(s) && String(a.providerId(s)) === String(user._id);
  if (!isCustomer && !isProvider) throw E.notFound(subjectType);
  if (await Dispute.exists({ subjectType, subjectId: s._id, status: { $in: ['open', 'under_review'] } })) throw E.conflict('A dispute is already open for this item');
  const d = await withTransaction(async (session) => {
    const [doc] = await Dispute.create([{ reference: ref('DSP'), subjectType, subjectId: s._id, raisedBy: user._id, counterpartyId: isCustomer ? a.providerId(s) : a.customerId(s), reason, description, statements: [{ by: user._id, role: isCustomer ? 'customer' : 'provider', text: description, at: new Date() }] }], { session });
    await a.hold(s, 'disputed', session);
    if (doc.counterpartyId) await notifications.notify(doc.counterpartyId, { category: 'disputes', type: 'dispute_opened', title: 'A dispute was opened', body: `A dispute was opened on ${a.label(s)}. You can add your statement.`, link: `/app/disputes/${doc._id}` }, { session });
    await audit.record({ ...audit.ctxFrom(req), actor: user, action: 'dispute.opened', category: 'support', targetType: subjectType, targetId: s._id, reason }, { session });
    return doc;
  });
  await notifications.notifyStaff('disputes.manage', { category: 'system', type: 'dispute_opened', title: 'New dispute', body: `${d.reference}: ${reason}`, link: '/admin/disputes' });
  return d;
}

async function addStatement(user, id, text) {
  const d = await Dispute.findById(id);
  if (!d) throw E.notFound('Dispute');
  const party = [String(d.raisedBy), String(d.counterpartyId)].includes(String(user._id));
  if (!party && !hasPermission(user, 'disputes.manage')) throw E.notFound('Dispute');
  if (!['open', 'under_review'].includes(d.status)) throw E.invalidState('Dispute is closed');
  const role = party ? (String(d.raisedBy) === String(user._id) ? 'raiser' : 'counterparty') : 'staff';
  await Dispute.updateOne({ _id: id }, { $push: { statements: { by: user._id, role, text: String(text).slice(0, 4000), at: new Date() } } });
  const notifyIds = [d.raisedBy, d.counterpartyId].filter((x) => x && String(x) !== String(user._id));
  for (const n of notifyIds) await notifications.notify(n, { category: 'disputes', type: 'dispute_update', title: `Update on dispute ${d.reference}`, body: 'A new statement was added.', link: `/app/disputes/${d._id}` });
  return Dispute.findById(id);
}

async function resolveDispute(staff, id, { outcome, note, refundKobo }, req) {
  if (!['resolved_for_customer', 'resolved_for_provider', 'under_review'].includes(outcome)) throw E.badRequest('Invalid outcome');
  const d = await Dispute.findById(id);
  if (!d) throw E.notFound('Dispute');
  if ([String(d.raisedBy), String(d.counterpartyId)].includes(String(staff._id))) throw E.forbidden('You are a party to this dispute');
  if (outcome === 'under_review') {
    await Dispute.updateOne({ _id: id, status: 'open' }, { $set: { status: 'under_review', assignedTo: staff._id } });
    return Dispute.findById(id);
  }
  if (!note || note.length < 10) throw E.validation([{ path: 'note', message: 'A resolution note (10+ characters) is required' }]);
  const a = subjects.get(d.subjectType);
  await withTransaction(async (session) => {
    const doc = await Dispute.findOneAndUpdate({ _id: id, status: { $in: ['open', 'under_review'] } }, { $set: { status: outcome, resolution: { by: staff._id, at: new Date(), note, refundKobo } } }, { new: true, session });
    if (!doc) throw E.invalidState('Dispute already resolved');
    const s = await a.load(d.subjectId, session);
    if (outcome === 'resolved_for_customer' && refundKobo > 0) {
      if (!hasPermission(staff, 'refunds.decide')) throw E.forbidden('Refund permission required to resolve with a refund');
      const [refund] = await RefundRequest.create([{ reference: ref('RFD'), subjectType: d.subjectType, subjectId: d.subjectId, requesterId: a.customerId(s), amountKobo: refundKobo, reason: 'other', description: `Dispute ${d.reference} resolution`, status: 'approved', decision: { by: staff._id, at: new Date(), note }, history: [{ at: new Date(), status: 'approved', by: staff._id, note: `Dispute ${d.reference}` }] }], { session });
      await executeRefund(refund, { by: staff._id, session });
    } else {
      const fresh = await a.load(d.subjectId, session);
      const openRefund = await RefundRequest.exists({ subjectType: d.subjectType, subjectId: d.subjectId, status: 'pending_review' }).session(session);
      if (!openRefund) await a.release(fresh, session);
    }
    for (const uid of [d.raisedBy, d.counterpartyId].filter(Boolean)) await notifications.notify(uid, { category: 'disputes', type: 'dispute_resolved', title: `Dispute ${d.reference} resolved`, body: note, link: `/app/disputes/${d._id}` }, { session });
    await audit.record({ ...audit.ctxFrom(req), actor: staff, action: `dispute.${outcome}`, category: 'support', targetType: 'dispute', targetId: d.reference, reason: note, metadata: { refundKobo } }, { session });
  });
  return Dispute.findById(id);
}

async function getDisputeFor(user, id) {
  const d = await Dispute.findById(id).lean();
  if (!d) throw E.notFound('Dispute');
  const party = [String(d.raisedBy), String(d.counterpartyId)].includes(String(user._id));
  if (!party && !hasPermission(user, 'disputes.manage')) throw E.notFound('Dispute');
  return d;
}

async function myDisputes(user) {
  return Dispute.find({ $or: [{ raisedBy: user._id }, { counterpartyId: user._id }] }).sort({ createdAt: -1 }).limit(100).lean();
}

async function myRefunds(user) {
  return RefundRequest.find({ requesterId: user._id }).sort({ createdAt: -1 }).limit(100).lean();
}

module.exports = { registerSubject, requestRefund, decide, executeRefund, checkCardRefunds, completeCardRefund, failCardRefundToWallet, openDispute, addStatement, resolveDispute, getDisputeFor, myDisputes, myRefunds, subjects, PaymentAttempt };
