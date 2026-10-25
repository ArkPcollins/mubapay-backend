'use strict';
/**
 * Viewing appointments and viewing fees.
 * Fee flow: customer pays → VIEWING_FEE_CLEARING (held). After the viewing
 * (+ release window, no open dispute/no-show claim) the fee is released:
 * provider wallet (net) + platform commission. Cancellations follow the
 * platform policy snapshotted on the appointment:
 *   - provider cancels / provider no-show → full refund to customer
 *   - customer cancels ≥ N hours before → full refund
 *   - customer cancels later, or customer no-show → no refund (fee released)
 * Rent, deposits and purchase prices are NEVER collected through MubaPay.
 */
const crypto = require('crypto');
const { Property, ViewingAppointment } = require('./realestate.models');
const ledger = require('../ledger/ledger.service');
const payments = require('../payments/payments.service');
const refunds = require('../refunds/refunds.service');
const messaging = require('../messaging/messaging.service');
const settings = require('../settings/settings.service');
const notifications = require('../notifications/notifications.service');
const audit = require('../audit/audit.service');
const consent = require('../legal/consent.service');
const { Dispute, RefundRequest } = require('../marketplace/marketplace.models');
const { withTransaction } = require('../../lib/db');
const { defineMachine } = require('../../lib/stateMachine');
const { E } = require('../../lib/errors');
const { percentBp, koboToNairaString } = require('../../lib/money');
const { hasPermission } = require('../../middleware/auth');
const logger = require('../../lib/logger');

const machine = defineMachine('Appointment', {
  requested: ['proposed', 'awaiting_payment', 'confirmed', 'declined', 'cancelled_by_customer', 'expired'],
  proposed: ['awaiting_payment', 'confirmed', 'requested', 'cancelled_by_customer', 'cancelled_by_provider', 'expired'],
  awaiting_payment: ['confirmed', 'cancelled_by_customer', 'cancelled_by_provider', 'expired'],
  confirmed: ['completed', 'cancelled_by_customer', 'cancelled_by_provider', 'no_show_customer', 'no_show_provider', 'disputed'],
  completed: ['disputed'],
  no_show_customer: ['disputed'],
  no_show_provider: ['disputed'],
  disputed: ['completed', 'no_show_customer', 'no_show_provider', 'cancelled_by_provider'],
  cancelled_by_customer: [],
  cancelled_by_provider: [],
  declined: [],
  expired: [],
});

const ref = () => `VW-${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;

function role(user, a) {
  if (String(a.customerId) === String(user._id)) return 'customer';
  if (String(a.providerId) === String(user._id)) return 'provider';
  return null;
}

async function load(user, id, { allowStaff = true } = {}) {
  const a = await ViewingAppointment.findById(id);
  if (!a) throw E.notFound('Appointment');
  const r = role(user, a);
  if (!r) {
    // managers of the property (other agents/owner) may also act as provider
    const p = await Property.findById(a.propertyId, { managers: 1 }).lean();
    if (p?.managers?.some((m) => m.status === 'active' && String(m.userId) === String(user._id))) return { a, r: 'provider' };
    if (allowStaff && hasPermission(user, 'appointments.view')) return { a, r: 'staff' };
    throw E.notFound('Appointment');
  }
  return { a, r };
}

async function request(user, propertyId, { slots, note, acceptedPolicies }, req) {
  const p = await Property.findOne({ _id: propertyId, status: 'published' });
  if (!p) throw E.notFound('Property');
  if (p.managers.some((m) => String(m.userId) === String(user._id))) throw E.badRequest('This is your listing');
  const valid = (slots || []).map((s) => new Date(s)).filter((d) => !Number.isNaN(d.getTime()) && d > new Date(Date.now() + 2 * 3600e3));
  if (!valid.length || valid.length > 3) throw E.validation([{ path: 'slots', message: 'Choose 1-3 preferred times at least 2 hours from now' }]);
  if (acceptedPolicies?.length) await consent.recordAcceptances(user._id, acceptedPolicies, { context: 'viewing', ip: req.ip, userAgent: req.get('user-agent') });
  await consent.assertUserAccepted(user._id, 'viewing');
  const open = await ViewingAppointment.countDocuments({ propertyId, customerId: user._id, status: { $in: ['requested', 'proposed', 'awaiting_payment', 'confirmed'] } });
  if (open) throw E.conflict('You already have an active viewing request for this property');
  const provider = p.managers.find((m) => m.status === 'active' && m.role === 'agent') || p.managers.find((m) => m.status === 'active');
  const ps = await settings.get('property');
  const fees = await settings.get('fees');
  const conv = await messaging.openConversation({ contextType: 'property', contextId: p._id, userIds: [user._id, provider.userId], subject: p.title });
  const a = await ViewingAppointment.create({
    reference: ref(), propertyId: p._id, customerId: user._id, providerId: provider.userId, requestedSlots: valid, note, conversationId: conv._id,
    fee: { amountKobo: p.viewingFee?.required ? p.viewingFee.amountKobo : 0, status: p.viewingFee?.required ? 'pending_payment' : 'none', commissionBp: fees.viewingFeeCommission.type === 'percent' ? fees.viewingFeeCommission.bp : 0, cancellationHours: ps.viewingCancellationHours, releaseHoursAfter: ps.viewingFeeReleaseHoursAfter },
    history: [{ at: new Date(), status: 'requested', by: user._id }],
  });
  await Property.updateOne({ _id: p._id }, { $inc: { 'stats.viewingRequests': 1 } });
  await notifications.notify(provider.userId, { category: 'property', type: 'viewing_requested', title: 'New viewing request', body: `${p.title}: ${valid.map((d) => d.toUTCString()).join(' / ')}`, link: `/app/provider/appointments/${a._id}` });
  await audit.fromReq(req, { action: 'appointment.requested', category: 'operations', targetType: 'appointment', targetId: a._id });
  return present(a, 'customer');
}

function present(a, viewerRole) {
  return { id: String(a._id), reference: a.reference, propertyId: String(a.propertyId), status: a.status, requestedSlots: a.requestedSlots, proposedSlots: a.proposedSlots, scheduledAt: a.scheduledAt, note: a.note, fee: { amountKobo: a.fee.amountKobo, status: a.fee.status, cancellationHours: a.fee.cancellationHours, refundedKobo: a.fee.refundedKobo }, attendance: a.attendance, cancellation: a.cancellation, noShowReport: a.noShowReport, conversationId: a.conversationId && String(a.conversationId), history: a.history, viewerRole, createdAt: a.createdAt };
}

/** Provider confirms one of the requested slots, or proposes alternatives. */
async function respond(user, id, { action, slot, slots, reason }, req) {
  const { a, r } = await load(user, id, { allowStaff: false });
  if (r !== 'provider') throw E.forbidden();
  let updated;
  if (action === 'confirm') {
    const chosen = new Date(slot);
    if (!a.requestedSlots.some((s) => s.getTime() === chosen.getTime())) throw E.validation([{ path: 'slot', message: 'Choose one of the requested times, or propose new ones' }]);
    const next = a.fee.amountKobo > 0 && a.fee.status !== 'paid' ? 'awaiting_payment' : 'confirmed';
    updated = await machine.transition(ViewingAppointment, a._id, 'requested', next, { scheduledAt: chosen }, { push: { history: { at: new Date(), status: next, by: user._id } } });
  } else if (action === 'propose') {
    const valid = (slots || []).map((s) => new Date(s)).filter((d) => d > new Date(Date.now() + 2 * 3600e3));
    if (!valid.length || valid.length > 3) throw E.validation([{ path: 'slots', message: 'Propose 1-3 future times' }]);
    updated = await machine.transition(ViewingAppointment, a._id, ['requested', 'proposed'], 'proposed', { proposedSlots: valid }, { push: { history: { at: new Date(), status: 'proposed', by: user._id, note: reason } } });
  } else if (action === 'decline') {
    updated = await machine.transition(ViewingAppointment, a._id, 'requested', 'declined', {}, { push: { history: { at: new Date(), status: 'declined', by: user._id, note: reason } } });
  } else throw E.badRequest('Invalid action');
  await notifications.notify(a.customerId, { category: 'property', type: `viewing_${updated.status}`, title: { awaiting_payment: 'Viewing accepted — payment needed', confirmed: 'Viewing confirmed', proposed: 'New times proposed for your viewing', declined: 'Viewing request declined' }[updated.status], body: updated.scheduledAt ? updated.scheduledAt.toUTCString() : reason || '', link: `/app/appointments/${a._id}` });
  await audit.fromReq(req, { action: `appointment.${action}`, category: 'operations', targetType: 'appointment', targetId: a._id, reason });
  return present(updated, 'provider');
}

/** Customer accepts a proposed time. */
async function acceptProposal(user, id, { slot }) {
  const { a, r } = await load(user, id, { allowStaff: false });
  if (r !== 'customer') throw E.forbidden();
  const chosen = new Date(slot);
  if (!a.proposedSlots.some((s) => s.getTime() === chosen.getTime())) throw E.validation([{ path: 'slot', message: 'Choose one of the proposed times' }]);
  const next = a.fee.amountKobo > 0 && a.fee.status !== 'paid' ? 'awaiting_payment' : 'confirmed';
  const updated = await machine.transition(ViewingAppointment, a._id, 'proposed', next, { scheduledAt: chosen }, { push: { history: { at: new Date(), status: next, by: user._id } } });
  await notifications.notify(a.providerId, { category: 'property', type: 'viewing_time_accepted', title: 'Viewing time accepted', body: chosen.toUTCString(), link: `/app/provider/appointments/${a._id}` });
  return present(updated, 'customer');
}

// ---------------------------------------------------------------- fees
async function payFee(user, id, { method }, { idempotencyKey, req }) {
  await settings.assertFeature('property_viewing_fees', { complianceKey: 'walletOperationsAuthorized' });
  const { a, r } = await load(user, id, { allowStaff: false });
  if (r !== 'customer') throw E.forbidden();
  if (a.status !== 'awaiting_payment' || a.fee.status !== 'pending_payment') throw E.invalidState('No viewing fee is due');
  if (method === 'wallet') {
    const v = await settings.get('verification');
    if (user.verificationTier < v.financialMinTier) throw E.verificationRequired('Wallet payments require a verified phone number');
    await withTransaction(async (session) => {
      await ledger.post({ reference: `VWF-${a._id}`, type: 'viewing_fee_payment', description: `Viewing fee ${a.reference}`, entries: [{ account: ledger.userCodes(user._id).wallet, direction: 'debit', amount: a.fee.amountKobo }, { account: ledger.SYS.VIEWING_CLEARING, direction: 'credit', amount: a.fee.amountKobo }], initiatedBy: user._id, relatedType: 'appointment', relatedId: a._id }, session);
      await markFeePaid(a._id, 'wallet', null, session);
    });
    await audit.fromReq(req, { action: 'appointment.fee_paid', category: 'finance', targetType: 'appointment', targetId: a._id, metadata: { method } });
    return present(await ViewingAppointment.findById(a._id), 'customer');
  }
  const attempt = await payments.initPayment({ user, purpose: 'viewing_fee', amountKobo: a.fee.amountKobo, relatedType: 'appointment', relatedId: a._id, idempotencyKey, callbackPath: `/app/appointments/${a._id}` });
  await ViewingAppointment.updateOne({ _id: a._id }, { $set: { 'fee.paymentReference': attempt.reference, 'fee.paymentMethod': 'paystack' } });
  return { ...present(await ViewingAppointment.findById(a._id), 'customer'), authorizationUrl: attempt.authorizationUrl, paymentReference: attempt.reference };
}

async function markFeePaid(appointmentId, method, reference, session) {
  const a = await ViewingAppointment.findOneAndUpdate({ _id: appointmentId, 'fee.status': 'pending_payment', status: 'awaiting_payment' }, { $set: { 'fee.status': 'paid', 'fee.paymentMethod': method, ...(reference ? { 'fee.paymentReference': reference } : {}), status: 'confirmed' }, $push: { history: { at: new Date(), status: 'confirmed', note: 'Viewing fee paid' } } }, { new: true, session });
  if (!a) throw E.invalidState('Appointment is no longer awaiting payment');
  await notifications.notify(a.customerId, { category: 'property', type: 'viewing_confirmed', title: 'Viewing confirmed', body: `Fee received. See you on ${a.scheduledAt.toUTCString()}.`, link: `/app/appointments/${a._id}` }, { session });
  await notifications.notify(a.providerId, { category: 'property', type: 'viewing_confirmed', title: 'Viewing confirmed (fee paid)', body: a.scheduledAt.toUTCString(), link: `/app/provider/appointments/${a._id}` }, { session });
  return a;
}

payments.registerPurpose('viewing_fee', {
  async creditTarget(attempt, session) {
    const a = await ViewingAppointment.findById(attempt.relatedId).session(session);
    if (!a || a.status !== 'awaiting_payment' || a.fee.status !== 'pending_payment' || a.fee.amountKobo !== attempt.amountKobo) throw E.invalidState('Appointment no longer awaiting this payment');
    return { account: ledger.SYS.VIEWING_CLEARING, ledgerType: 'viewing_fee_payment', description: `Viewing fee ${a.reference} via Paystack` };
  },
  async onSuccess(attempt, session) {
    await markFeePaid(attempt.relatedId, 'paystack', attempt.reference, session);
  },
});

async function refundFee(a, amount, reason, by, session) {
  if (amount <= 0) return 0;
  await ledger.post({ reference: `VWF-RFD-${a._id}-${a.fee.refundedKobo + amount}`, type: 'viewing_fee_refund', description: `Viewing fee refund ${a.reference}: ${reason}`, entries: [{ account: ledger.SYS.VIEWING_CLEARING, direction: 'debit', amount }, { account: ledger.userCodes(a.customerId).wallet, direction: 'credit', amount }], initiatedBy: by, relatedType: 'appointment', relatedId: a._id }, session);
  const total = a.fee.refundedKobo + amount;
  await ViewingAppointment.updateOne({ _id: a._id }, { $set: { 'fee.refundedKobo': total, 'fee.status': total >= a.fee.amountKobo ? 'refunded' : 'partially_refunded' } }, { session });
  await notifications.notify(a.customerId, { category: 'financial', type: 'viewing_fee_refunded', title: 'Viewing fee refunded', body: `${koboToNairaString(amount)} returned to your wallet.`, link: '/app/wallet' }, { session });
  return amount;
}

async function releaseFee(appointmentId) {
  return withTransaction(async (session) => {
    const a = await ViewingAppointment.findOneAndUpdate({ _id: appointmentId, 'fee.status': { $in: ['paid', 'partially_refunded'] }, status: { $in: ['completed', 'no_show_customer', 'cancelled_by_customer'] } }, { $set: { 'fee.status': 'released', 'fee.releasedAt': new Date() } }, { new: true, session });
    if (!a) return null;
    const remaining = a.fee.amountKobo - a.fee.refundedKobo;
    if (remaining <= 0) return a;
    await ledger.ensureUserAccounts(a.providerId);
    const commission = percentBp(remaining, a.fee.commissionBp || 0);
    const entries = [{ account: ledger.SYS.VIEWING_CLEARING, direction: 'debit', amount: remaining }];
    if (remaining - commission > 0) entries.push({ account: ledger.userCodes(a.providerId).wallet, direction: 'credit', amount: remaining - commission });
    if (commission > 0) entries.push({ account: ledger.SYS.REVENUE_VIEWING, direction: 'credit', amount: commission });
    await ledger.post({ reference: `VWF-REL-${a._id}`, type: 'viewing_fee_release', description: `Viewing fee released ${a.reference}`, entries, relatedType: 'appointment', relatedId: a._id, metadata: { commission } }, session);
    await notifications.notify(a.providerId, { category: 'financial', type: 'viewing_fee_released', title: 'Viewing fee received', body: `${koboToNairaString(remaining - commission)} credited to your wallet for ${a.reference}.`, link: '/app/wallet' }, { session });
    return a;
  });
}

async function cancel(user, id, { reason }, req) {
  const { a, r } = await load(user, id, { allowStaff: false });
  if (!['customer', 'provider'].includes(r)) throw E.forbidden();
  if (!reason || reason.length < 3) throw E.validation([{ path: 'reason', message: 'Give a short reason' }]);
  const to = r === 'customer' ? 'cancelled_by_customer' : 'cancelled_by_provider';
  let refundKobo = 0;
  let policy = 'no_fee';
  const paid = ['paid'].includes(a.fee.status);
  if (paid) {
    const hoursBefore = (a.scheduledAt.getTime() - Date.now()) / 3600e3;
    if (r === 'provider') { refundKobo = a.fee.amountKobo; policy = 'provider_cancelled_full_refund'; }
    else if (hoursBefore >= a.fee.cancellationHours) { refundKobo = a.fee.amountKobo; policy = `customer_cancelled_${a.fee.cancellationHours}h_before_full_refund`; }
    else { refundKobo = 0; policy = 'late_customer_cancellation_no_refund'; }
  }
  await withTransaction(async (session) => {
    const updated = await machine.transition(ViewingAppointment, a._id, a.status, to, { cancellation: { by: user._id, party: r, at: new Date(), reason, refundKobo, policyApplied: policy }, ...(a.fee.status === 'pending_payment' ? { 'fee.status': 'none' } : {}) }, { session, push: { history: { at: new Date(), status: to, by: user._id, note: reason } } });
    if (refundKobo) await refundFee(updated, refundKobo, policy, user._id, session);
    const other = r === 'customer' ? a.providerId : a.customerId;
    await notifications.notify(other, { category: 'property', type: 'viewing_cancelled', title: 'Viewing cancelled', body: `${a.reference} was cancelled by the ${r}: ${reason}`, link: r === 'customer' ? `/app/provider/appointments/${a._id}` : `/app/appointments/${a._id}` }, { session });
    await audit.record({ ...audit.ctxFrom(req), actor: user, action: 'appointment.cancelled', category: 'operations', targetType: 'appointment', targetId: a._id, reason, metadata: { policy, refundKobo } }, { session });
  });
  // late customer cancellation: fee goes to provider per policy
  if (paid && policy === 'late_customer_cancellation_no_refund') await releaseFee(a._id);
  return present(await ViewingAppointment.findById(a._id), r);
}

async function confirmAttendance(user, id) {
  const { a, r } = await load(user, id, { allowStaff: false });
  if (a.status !== 'confirmed') throw E.invalidState('Viewing is not confirmed');
  if (a.scheduledAt > new Date()) throw E.invalidState('You can confirm attendance after the viewing time');
  const field = r === 'customer' ? 'attendance.customerConfirmedAt' : 'attendance.providerConfirmedAt';
  const updated = await ViewingAppointment.findOneAndUpdate({ _id: a._id }, { $set: { [field]: new Date() } }, { new: true });
  if (updated.attendance.customerConfirmedAt || updated.attendance.providerConfirmedAt) {
    await machine.transition(ViewingAppointment, a._id, 'confirmed', 'completed', {}, { push: { history: { at: new Date(), status: 'completed', by: user._id } } }).catch(() => {});
  }
  return present(await ViewingAppointment.findById(a._id), r);
}

async function reportNoShow(user, id, { note }, req) {
  const { a, r } = await load(user, id, { allowStaff: false });
  if (!['confirmed', 'completed'].includes(a.status)) throw E.invalidState('No-show can only be reported for confirmed viewings');
  if (a.scheduledAt > new Date()) throw E.invalidState('The viewing time has not passed');
  const ps = await settings.get('property');
  if (Date.now() - a.scheduledAt.getTime() > ps.noShowReportWindowHours * 3600e3) throw E.conflict('The no-show reporting window has closed');
  if (a.fee.status === 'released') throw E.conflict('The fee was already released; open a dispute instead');
  const to = r === 'customer' ? 'no_show_provider' : 'no_show_customer';
  await withTransaction(async (session) => {
    const updated = await machine.transition(ViewingAppointment, a._id, a.status, to, { noShowReport: { by: user._id, party: r === 'customer' ? 'provider' : 'customer', at: new Date(), note } }, { session, push: { history: { at: new Date(), status: to, by: user._id, note } } });
    if (to === 'no_show_provider' && ['paid', 'partially_refunded'].includes(updated.fee.status)) await refundFee(updated, updated.fee.amountKobo - updated.fee.refundedKobo, 'provider_no_show', user._id, session);
    await notifications.notify(r === 'customer' ? a.providerId : a.customerId, { category: 'property', type: 'no_show_reported', title: 'No-show reported', body: `A no-show was reported for ${a.reference}. If this is wrong, open a dispute within 48 hours.`, link: `/app/disputes` }, { session });
    await audit.record({ ...audit.ctxFrom(req), actor: user, action: `appointment.${to}`, category: 'operations', targetType: 'appointment', targetId: a._id, reason: note }, { session });
  });
  return present(await ViewingAppointment.findById(a._id), r);
}

/** Jobs: release eligible fees; expire stale requests. */
async function runReleases() {
  const due = await ViewingAppointment.find({ 'fee.status': { $in: ['paid', 'partially_refunded'] }, status: { $in: ['completed', 'no_show_customer', 'confirmed'] } }).limit(200);
  let released = 0;
  for (const a of due) {
    const wait = (a.fee.releaseHoursAfter ?? 24) * 3600e3;
    if (!a.scheduledAt || a.scheduledAt.getTime() + wait > Date.now()) continue;
    const disputeOpen = await Dispute.exists({ subjectType: 'appointment', subjectId: a._id, status: { $in: ['open', 'under_review'] } });
    const refundOpen = await RefundRequest.exists({ subjectType: 'appointment', subjectId: a._id, status: { $in: ['pending_review', 'approved', 'processing'] } });
    if (disputeOpen || refundOpen) continue;
    if (a.status === 'confirmed') {
      // nobody reported a problem within the window: treat as completed
      await machine.transition(ViewingAppointment, a._id, 'confirmed', 'completed', {}, { push: { history: { at: new Date(), status: 'completed', note: 'Auto-completed after release window' } } }).catch(() => {});
    }
    // eslint-disable-next-line no-await-in-loop
    if (await releaseFee(a._id).catch((err) => logger.error({ err }, 'viewing fee release failed'))) released += 1;
  }
  const stale = await ViewingAppointment.updateMany({ status: { $in: ['requested', 'proposed', 'awaiting_payment'] }, $or: [{ scheduledAt: { $lt: new Date() } }, { scheduledAt: null, createdAt: { $lt: new Date(Date.now() - 14 * 864e5) } }] }, { $set: { status: 'expired' }, $push: { history: { at: new Date(), status: 'expired' } } });
  return { checked: due.length, released, expired: stale.modifiedCount };
}

async function sendReminders() {
  const soon = await ViewingAppointment.find({ status: 'confirmed', scheduledAt: { $gt: new Date(), $lt: new Date(Date.now() + 24 * 3600e3) } }).limit(500);
  for (const a of soon) {
    for (const uid of [a.customerId, a.providerId]) await notifications.notify(uid, { category: 'property', type: 'viewing_reminder', title: 'Viewing reminder', body: `${a.reference} is scheduled for ${a.scheduledAt.toUTCString()}.`, link: `/app/appointments/${a._id}`, dedupeKey: `vw_rem:${a._id}:${uid}` });
  }
  return { reminded: soon.length };
}

async function list(user, { as = 'customer', status }) {
  const filter = as === 'provider' ? { providerId: user._id } : { customerId: user._id };
  if (as === 'provider') {
    const props = await Property.find({ 'managers.userId': user._id, 'managers.status': 'active' }, { _id: 1 }).lean();
    delete filter.providerId;
    filter.$or = [{ providerId: user._id }, { propertyId: { $in: props.map((p) => p._id) } }];
  }
  if (status) filter.status = status;
  const rows = await ViewingAppointment.find(filter).sort({ scheduledAt: -1, createdAt: -1 }).limit(200);
  const props = await Property.find({ _id: { $in: rows.map((r) => r.propertyId) } }, { title: 1, slug: 1, location: 1 }).lean();
  const pm = new Map(props.map((p) => [String(p._id), p]));
  return rows.map((a) => ({ ...present(a, as), property: { title: pm.get(String(a.propertyId))?.title, slug: pm.get(String(a.propertyId))?.slug, area: pm.get(String(a.propertyId))?.location?.area } }));
}

async function get(user, id) {
  const { a, r } = await load(user, id);
  return present(a, r);
}

// Register appointments as a refund/dispute subject.
refunds.registerSubject('appointment', {
  async load(id, session) {
    const a = await ViewingAppointment.findById(id).session(session || null);
    if (!a) throw E.notFound('Appointment');
    return a;
  },
  customerId: (a) => a.customerId,
  providerId: (a) => a.providerId,
  label: (a) => `viewing ${a.reference}`,
  clearingAccount: () => ledger.SYS.VIEWING_CLEARING,
  refundableKobo: (a) => (['paid', 'partially_refunded'].includes(a.fee.status) ? a.fee.amountKobo - a.fee.refundedKobo : 0),
  async paymentReference(a) {
    return a.fee.paymentMethod === 'paystack' ? a.fee.paymentReference : null;
  },
  async assertCanRequest(a, user) {
    if (String(a.customerId) !== String(user._id)) throw E.notFound('Appointment');
  },
  async hold(a, status, session) {
    if (status === 'disputed' && machine.canTransition(a.status, 'disputed')) {
      await ViewingAppointment.updateOne({ _id: a._id }, { $set: { status: 'disputed', statusBeforeHold: a.status }, $push: { history: { at: new Date(), status: 'disputed' } } }, { session });
    }
  },
  async release(a, session) {
    if (a.status === 'disputed') await ViewingAppointment.updateOne({ _id: a._id }, { $set: { status: a.statusBeforeHold || 'completed' } }, { session });
  },
  async applyRefund(a, amount, session) {
    const total = a.fee.refundedKobo + amount;
    await ViewingAppointment.updateOne({ _id: a._id }, { $set: { 'fee.refundedKobo': total, 'fee.status': total >= a.fee.amountKobo ? 'refunded' : 'partially_refunded', ...(a.status === 'disputed' ? { status: a.statusBeforeHold || 'completed' } : {}) } }, { session });
  },
});

module.exports = { machine, request, respond, acceptProposal, payFee, cancel, confirmAttendance, reportNoShow, runReleases, sendReminders, list, get, releaseFee };
