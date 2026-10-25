'use strict';
/**
 * Delivery orchestration across logistics providers.
 * Providers: shipbubble (documented API), configured_rate (operator-configured
 * rules, fulfilled manually). Additional providers plug in via the same
 * interface once their APIs and commercial terms are verified.
 */
const { mongoose, withTransaction } = require('../../lib/db');
const { DeliveryRequest, DeliveryEvent, Order, Product } = require('../marketplace/marketplace.models');
const shipbubble = require('../../providers/logistics/shipbubble.adapter');
const configuredRate = require('../../providers/logistics/configuredRate.adapter');
const settings = require('../settings/settings.service');
const notifications = require('../notifications/notifications.service');
const audit = require('../audit/audit.service');
const { E } = require('../../lib/errors');
const { sha256 } = require('../../lib/crypto');
const logger = require('../../lib/logger');

const PROVIDERS = { shipbubble, configured_rate: configuredRate };
const FLAG = { shipbubble: 'logistics_shipbubble', configured_rate: 'logistics_configured_rate' };

const quoteSchema = new mongoose.Schema(
  {
    buyerId: { type: mongoose.Schema.Types.ObjectId, required: true },
    groupKey: String,
    destination: mongoose.Schema.Types.Mixed,
    options: [mongoose.Schema.Types.Mixed],
    selected: mongoose.Schema.Types.Mixed,
    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);
quoteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const DeliveryQuote = mongoose.models.DeliveryQuote || mongoose.model('DeliveryQuote', quoteSchema);

const norm = (s) => String(s || '').trim().toLowerCase();

async function coverage() {
  const d = await settings.get('delivery');
  return { states: d.coverageStates, collectionPoints: d.collectionPoints };
}

async function assertServiceable(state) {
  const d = await settings.get('delivery');
  if (!d.coverageStates.map(norm).includes(norm(state))) {
    throw E.conflict(`Delivery is not yet available in ${state}. We currently deliver within ${d.coverageStates.join(', ')}.`, 'NOT_SERVICEABLE', { coverage: d.coverageStates });
  }
}

async function activeProviders() {
  const d = await settings.get('delivery');
  const out = [];
  for (const name of d.providerPriority) {
    const p = PROVIDERS[name];
    if (!p || !p.isConfigured()) continue;
    // eslint-disable-next-line no-await-in-loop
    if (FLAG[name] && !(await settings.isEnabled(FLAG[name]))) continue;
    out.push(p);
  }
  return out;
}

/**
 * Quote delivery for one seller group. Returns a stored quote id; checkout
 * uses only server-stored quotes, so clients cannot tamper with fees.
 */
async function quoteForGroup(buyer, { items, origin, destination }) {
  await assertServiceable(destination.state);
  await assertServiceable(origin.state);
  const providers = await activeProviders();
  if (!providers.length) throw E.notConfigured('Delivery', 'No logistics provider is enabled. Configure Shipbubble or enable configured delivery rates.');
  const options = [];
  const errors = [];
  for (const p of providers) {
    try {
      if (p.name === 'shipbubble') {
        if (!origin.addressCode && !require('../../config').SHIPBUBBLE_SENDER_ADDRESS_CODE) continue;
        // eslint-disable-next-line no-await-in-loop
        const recv = await shipbubble.validateAddress({ name: destination.recipientName || buyer.firstName || 'Customer', email: buyer.email, phone: destination.phone || buyer.phone, address: [destination.line1, destination.line2, destination.city, destination.state, 'Nigeria'].filter(Boolean).join(', '), latitude: destination.lat, longitude: destination.lng });
        const pickupDate = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
        // eslint-disable-next-line no-await-in-loop
        options.push(...(await shipbubble.quote({ senderAddressCode: origin.addressCode, receiverAddressCode: recv.addressCode, pickupDate, items })));
      } else {
        // eslint-disable-next-line no-await-in-loop
        options.push(...(await p.quote({ originState: origin.state, destinationState: destination.state, items })));
      }
    } catch (err) {
      errors.push({ provider: p.name, message: err.message });
      logger.warn({ provider: p.name, err: err.message }, 'delivery quote failed');
    }
  }
  if (!options.length) {
    throw E.conflict('No delivery option is currently available for this address. Try collection, or contact support.', 'NO_DELIVERY_OPTION', { providerErrors: errors.map((e) => e.provider) });
  }
  const d = await settings.get('delivery');
  const ranked = [...options].sort((a, b) => {
    if (d.selectionStrategy === 'fastest') return (a.etaAt?.getTime?.() || Infinity) - (b.etaAt?.getTime?.() || Infinity) || a.feeKobo - b.feeKobo;
    if (d.selectionStrategy === 'priority') return d.providerPriority.indexOf(a.provider) - d.providerPriority.indexOf(b.provider) || a.feeKobo - b.feeKobo;
    return a.feeKobo - b.feeKobo;
  });
  const expiresAt = new Date(Math.min(...ranked.map((o) => new Date(o.expiresAt).getTime()), Date.now() + 6 * 3600e3));
  const q = await DeliveryQuote.create({ buyerId: buyer._id, destination, options: ranked, selected: ranked[0], expiresAt });
  return { quoteId: String(q._id), selected: present(ranked[0]), alternatives: ranked.slice(1, 5).map(present), expiresAt };
}

const present = (o) => ({ provider: o.provider, courierName: o.courierName, serviceCode: o.serviceCode, feeKobo: o.feeKobo, etaText: o.etaText });

async function loadQuote(buyerId, quoteId, optionIndex = 0) {
  const q = await DeliveryQuote.findOne({ _id: quoteId, buyerId, expiresAt: { $gt: new Date() } }).lean();
  if (!q) throw E.conflict('Your delivery quote expired. Please get a new quote.', 'QUOTE_EXPIRED');
  const opt = q.options[optionIndex] || q.options[0];
  return { ...opt, destination: q.destination };
}

// ---------------------------------------------------------------- shipments
async function createForOrder(order, session) {
  const [dr] = await DeliveryRequest.create([{ orderId: order._id, provider: order.deliveryQuote.provider, quote: order.deliveryQuote, quotedFeeKobo: order.deliveryFeeKobo, manual: order.deliveryQuote.provider === 'configured_rate' }], { session });
  order.deliveryRequestId = dr._id;
  return dr;
}

async function recordEvent(dr, { source, status, providerStatus, note, by, key }, session) {
  const eventKey = key || sha256(`${dr._id}|${source}|${status}|${providerStatus}|${note || ''}|${Date.now()}`);
  // read-before-write: a caught duplicate-key error would abort the surrounding transaction
  if (await DeliveryEvent.exists({ eventKey }).session(session || null)) return false;
  try {
    await DeliveryEvent.create([{ deliveryRequestId: dr._id, source, eventKey, status, providerStatus, note, by }], { session });
    return true;
  } catch (err) {
    if (err.code === 11000 && !session) return false; // duplicate event → idempotent no-op
    throw err; // inside a transaction: abort; the retry will see the committed event and no-op
  }
}

/** Book the shipment with the provider when the seller marks the order ready for dispatch. */
async function book(deliveryRequestId) {
  const dr = await DeliveryRequest.findOneAndUpdate({ _id: deliveryRequestId, status: { $in: ['pending_booking', 'booking_failed', 'redelivery_scheduled'] } }, { $inc: { attempts: 1 } }, { new: true });
  if (!dr) return null;
  const p = PROVIDERS[dr.provider];
  try {
    if (dr.provider === 'shipbubble' && dr.quote?.expiresAt && new Date(dr.quote.expiresAt) < new Date()) {
      throw Object.assign(new Error('Shipbubble rate token expired; re-quote required'), { outcome: 'rejected' });
    }
    const r = await p.book({ quoteRef: dr.quote.quoteRef, serviceCode: dr.quote.serviceCode, courierId: dr.quote.courierId });
    await DeliveryRequest.updateOne({ _id: dr._id }, { $set: { status: 'booked', shipmentRef: r.shipmentRef, trackingUrl: r.trackingUrl, providerStatus: r.providerStatus } });
    await recordEvent(dr, { source: 'system', status: 'booked', providerStatus: r.providerStatus, note: `Shipment ${r.shipmentRef}` });
    return DeliveryRequest.findById(dr._id);
  } catch (err) {
    await DeliveryRequest.updateOne({ _id: dr._id }, { $set: { status: 'booking_failed', failure: { reason: err.message, at: new Date() } } });
    await recordEvent(dr, { source: 'system', status: 'booking_failed', note: err.message });
    await audit.raiseAlert({ severity: 'warning', type: 'delivery.booking_failed', message: `Delivery booking failed for order ${dr.orderId}: ${err.message}`, refType: 'delivery', refId: dr._id, dedupeKey: `booking_failed:${dr._id}` });
    if (err.outcome === 'unknown') throw err; // retry via job
    return DeliveryRequest.findById(dr._id);
  }
}

/** Apply a delivery status (from webhook, polling or staff). Forward-only for terminal states. */
async function applyStatus(dr, { status, providerStatus, source, note, by, evidence, key, eventAt }) {
  const order = await Order.findById(dr.orderId);
  const at = eventAt instanceof Date && !Number.isNaN(eventAt.getTime()) ? eventAt : null;
  return withTransaction(async (session) => {
    const fresh = await DeliveryRequest.findById(dr._id).session(session);
    if (['delivered', 'cancelled'].includes(fresh.status) && status !== fresh.status) {
      await recordEvent(fresh, { source, status: `ignored:${status}`, providerStatus, note: 'Late/out-of-order event after terminal state', key }, session);
      return fresh;
    }
    // Provider events can be delivered (and, with parallel workers, processed) out of
    // order. An event older than the newest one already applied must never move the
    // status backwards, so it is recorded for the timeline and otherwise ignored.
    if (at && fresh.lastProviderEventAt && at < fresh.lastProviderEventAt) {
      await recordEvent(fresh, { source, status: `ignored:${status}`, providerStatus, note: 'Stale provider event (older than the latest applied update)', key }, session);
      return fresh;
    }
    const isNew = await recordEvent(fresh, { source, status, providerStatus, note, by, key }, session);
    if (!isNew) return fresh;
    if (at) fresh.lastProviderEventAt = at;
    fresh.status = status;
    if (providerStatus) fresh.providerStatus = providerStatus;
    if (evidence) fresh.evidence.push({ at: new Date(), ...evidence, by });
    if (status === 'failed') fresh.failure = { reason: note || providerStatus, at: new Date() };
    await fresh.save({ session });
    const orders = require('../marketplace/orders.service');
    if (status === 'in_transit') await orders.transitionSystem(order._id, ['ready_for_dispatch', 'processing', 'paid'], 'dispatched', { note: 'Picked up by courier', session });
    if (status === 'delivered') await orders.markDelivered(order._id, { by, evidence: evidence || { type: 'provider_confirmation', note: providerStatus }, session });
    if (status === 'failed') {
      const d = await settings.get('delivery');
      if (fresh.redeliveryCount < d.maxRedeliveryAttempts) {
        await notifications.notify(order.buyerId, { category: 'delivery', type: 'delivery_failed_retry', title: 'Delivery attempt unsuccessful', body: `We couldn't deliver order ${order.orderNumber}. We'll arrange another attempt.`, link: `/app/orders/${order._id}` }, { session });
        await notifications.notifyStaff('deliveries.manage', { category: 'system', type: 'delivery_failed', title: 'Delivery failed — redelivery needed', body: order.orderNumber, link: `/admin/deliveries` }, { session });
      } else {
        await orders.transitionSystem(order._id, ['dispatched', 'ready_for_dispatch'], 'delivery_failed', { note: 'Delivery failed after maximum attempts', session });
        await audit.raiseAlert({ severity: 'warning', type: 'delivery.failed_final', message: `Order ${order.orderNumber} delivery failed after ${fresh.redeliveryCount} redeliveries`, refType: 'order', refId: order._id });
      }
    }
    await notifications.notify(order.buyerId, { category: 'delivery', type: `delivery_${status}`, title: `Order ${order.orderNumber}: ${status.replace(/_/g, ' ')}`, body: note || 'Your delivery status changed.', link: `/app/orders/${order._id}`, dedupeKey: `dlv:${fresh._id}:${status}:${providerStatus || ''}` }, { session });
    return fresh;
  });
}

async function handleShipbubbleEvent(ev) {
  const p = ev.payload || {};
  if (!String(ev.eventType || '').startsWith('shipment.')) return { ignored: true, reason: 'not_shipment_event' };
  const dr = await DeliveryRequest.findOne({ provider: 'shipbubble', shipmentRef: p.order_id });
  if (!dr) return { ignored: true, reason: 'unknown_shipment' };
  const status = ev.eventType === 'shipment.cancelled' ? 'cancelled' : shipbubble.mapStatus(p.status);
  if (ev.eventType === 'shipment.waybill.updated' || ev.eventType === 'shipment.sla.updated') {
    await DeliveryRequest.updateOne({ _id: dr._id }, { $set: { trackingUrl: p.tracking_url || dr.trackingUrl } });
    await recordEvent(dr, { source: 'webhook', status: dr.status, providerStatus: p.status, note: ev.eventType, key: `sb:${ev.eventKey}` });
    return { handled: true };
  }
  await applyStatus(dr, { status, providerStatus: p.status, source: 'webhook', note: p.courier?.tracking_message, key: `sb:${ev.eventKey}`, eventAt: p.date ? new Date(p.date) : undefined });
  return { handled: true };
}

/** Polling fallback for providers/webhooks that are delayed. */
async function pollTracking() {
  if (!shipbubble.isConfigured()) return { skipped: true };
  const due = await DeliveryRequest.find({ provider: 'shipbubble', status: { $in: ['booked', 'in_transit'] }, shipmentRef: { $ne: null }, $or: [{ lastTrackedAt: null }, { lastTrackedAt: { $lt: new Date(Date.now() - 30 * 60e3) } }] }).limit(50);
  if (!due.length) return { checked: 0 };
  const results = await shipbubble.track(due.map((d) => d.shipmentRef));
  for (const r of results) {
    const dr = due.find((d) => d.shipmentRef === r.shipmentRef);
    if (!dr) continue;
    await DeliveryRequest.updateOne({ _id: dr._id }, { $set: { lastTrackedAt: new Date(), trackingUrl: r.trackingUrl || dr.trackingUrl } });
    if (r.status !== dr.status) await applyStatus(dr, { status: r.status, providerStatus: r.providerStatus, source: 'poll', key: `poll:${dr._id}:${r.providerStatus}` });
  }
  return { checked: due.length };
}

/** Staff manual fallback for operations the provider does not support. */
async function manualUpdate(staff, deliveryRequestId, { status, note, evidenceRef }, req) {
  const allowed = ['booked', 'in_transit', 'delivered', 'failed', 'redelivery_scheduled', 'cancelled'];
  if (!allowed.includes(status)) throw E.badRequest('Invalid status');
  if (status === 'delivered' && !note && !evidenceRef) throw E.validation([{ path: 'note', message: 'Delivery evidence (note or reference) is required' }]);
  const dr = await DeliveryRequest.findById(deliveryRequestId);
  if (!dr) throw E.notFound('Delivery');
  if (status === 'redelivery_scheduled') {
    const d = await settings.get('delivery');
    if (dr.redeliveryCount >= d.maxRedeliveryAttempts) throw E.conflict('Maximum redelivery attempts reached');
    await DeliveryRequest.updateOne({ _id: dr._id }, { $set: { status: 'redelivery_scheduled' }, $inc: { redeliveryCount: 1 } });
    await recordEvent(dr, { source: 'manual', status, note, by: staff._id });
    await audit.fromReq(req, { action: 'delivery.redelivery_scheduled', category: 'operations', targetType: 'delivery', targetId: dr._id, reason: note });
    if (dr.provider === 'shipbubble') await book(dr._id);
    return DeliveryRequest.findById(dr._id);
  }
  const r = await applyStatus(dr, { status, source: 'manual', note, by: staff._id, evidence: status === 'delivered' ? { type: 'staff_confirmation', note, ref: evidenceRef } : undefined });
  await audit.fromReq(req, { action: 'delivery.manual_update', category: 'operations', targetType: 'delivery', targetId: dr._id, reason: note, metadata: { status } });
  return r;
}

async function cancelShipment(dr) {
  if (!dr.shipmentRef || ['delivered', 'cancelled'].includes(dr.status)) return;
  const p = PROVIDERS[dr.provider];
  try {
    await p.cancel(dr.shipmentRef);
    await applyStatus(dr, { status: 'cancelled', source: 'system', note: 'Cancelled with provider' });
  } catch (err) {
    await audit.raiseAlert({ severity: 'warning', type: 'delivery.cancel_failed', message: `Could not cancel shipment ${dr.shipmentRef}: ${err.message}`, refType: 'delivery', refId: dr._id });
  }
}

async function timeline(deliveryRequestId) {
  return DeliveryEvent.find({ deliveryRequestId }).sort({ at: 1 }).lean();
}

function providerStatus() {
  return Object.values(PROVIDERS).map((p) => ({ name: p.name, configured: p.isConfigured(), capabilities: p.capabilities }));
}

module.exports = { coverage, assertServiceable, quoteForGroup, loadQuote, createForOrder, book, applyStatus, handleShipbubbleEvent, pollTracking, manualUpdate, cancelShipment, timeline, providerStatus, DeliveryQuote, Product };
