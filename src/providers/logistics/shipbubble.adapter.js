'use strict';
/**
 * Shipbubble adapter (multi-courier aggregator operating in Nigeria).
 * Documented endpoints used (https://docs.shipbubble.com):
 *   POST /v1/shipping/address/validate          → data.address_code
 *   GET  /v1/shipping/labels/categories         → package categories
 *   POST /v1/shipping/fetch_rates               → data.request_token, data.couriers[]
 *   POST /v1/shipping/labels                    → data.order_id, data.tracking_url, data.status
 *   POST /v1/shipping/labels/cancel/:order_id   → cancel
 *   GET  /v1/shipping/labels/list/:order_ids    → tracking (≤50 ids)
 * Auth: "Authorization: Bearer <API_KEY>" (sb_sandbox_… / sb_prod_…).
 * Webhooks: header x-ship-signature, HMAC-SHA512 keyed with the API key.
 *   NOTE: Shipbubble's docs do not state the digest encoding or exact signed
 *   payload. This implementation assumes hex(HMAC_SHA512(apiKey, rawBody)) and
 *   MUST be confirmed with the sandbox webhook simulator before go-live
 *   (see documentation/integrations/logistics.md).
 */
const crypto = require('crypto');
const config = require('../../config');
const { request } = require('../http');
const { E } = require('../../lib/errors');

const name = 'shipbubble';
const capabilities = { serviceability: true, quote: true, book: true, cancel: true, track: true, webhooks: true, evidence: false };

function isConfigured() {
  return config.integrations.shipbubble;
}
function requireConfigured() {
  if (!isConfigured()) throw E.notConfigured('Shipbubble logistics', 'Set SHIPBUBBLE_API_KEY (sb_sandbox_… for non-production) and SHIPBUBBLE_SENDER_ADDRESS_CODE.');
}
const call = (path, opts = {}) => {
  requireConfigured();
  return request(`${config.SHIPBUBBLE_BASE_URL}${path}`, { ...opts, headers: { authorization: `Bearer ${config.SHIPBUBBLE_API_KEY}` }, timeoutMs: 20000 });
};

/** Convert a provider naira amount (number or string) into integer kobo without float error. */
function nairaToKoboLoose(v) {
  const s = String(v).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw E.provider('Shipbubble returned an invalid amount');
  const [w, f = ''] = s.split('.');
  const frac = (f + '000').slice(0, 3);
  let kobo = Number(w) * 100 + Number(frac.slice(0, 2));
  if (Number(frac[2]) >= 5) kobo += 1;
  return kobo;
}

async function validateAddress({ name: n, email, phone, address, latitude, longitude }) {
  const res = await call('/v1/shipping/address/validate', { method: 'POST', body: { name: n, email, phone, address, latitude, longitude } });
  const d = res.data || {};
  return { addressCode: d.address_code, formattedAddress: d.formatted_address, state: d.state, city: d.city, latitude: d.latitude, longitude: d.longitude };
}

async function categories() {
  const res = await call('/v1/shipping/labels/categories');
  return (res.data || []).map((c) => ({ id: c.category_id, name: c.category }));
}

async function quote({ senderAddressCode, receiverAddressCode, pickupDate, categoryId, items, dimensions }) {
  const res = await call('/v1/shipping/fetch_rates', {
    method: 'POST',
    body: {
      sender_address_code: Number(senderAddressCode || config.SHIPBUBBLE_SENDER_ADDRESS_CODE),
      reciever_address_code: Number(receiverAddressCode), // field name spelled this way in Shipbubble's API
      pickup_date: pickupDate,
      category_id: Number(categoryId || config.SHIPBUBBLE_DEFAULT_CATEGORY_ID),
      package_items: items.map((i) => ({ name: i.name, description: i.description || i.name, unit_weight: String(i.unitWeightKg || 0.5), unit_amount: String(Math.round(i.unitAmountKobo / 100)), quantity: String(i.quantity) })),
      package_dimension: dimensions || { length: 30, width: 20, height: 15 },
    },
  });
  const d = res.data || {};
  return (d.couriers || []).map((c) => ({
    provider: name, quoteRef: d.request_token, serviceCode: c.service_code, courierId: String(c.courier_id), courierName: c.courier_name,
    feeKobo: nairaToKoboLoose(c.total), currency: c.currency, etaText: c.delivery_eta, etaAt: c.delivery_eta_time ? new Date(c.delivery_eta_time) : null,
    expiresAt: new Date(Date.now() + 6 * 864e5), raw: { service_type: c.service_type, tracking_level: c.tracking_level },
  }));
}

async function book({ quoteRef, serviceCode, courierId }) {
  const res = await call('/v1/shipping/labels', { method: 'POST', body: { request_token: quoteRef, service_code: serviceCode, courier_id: courierId } });
  const d = res.data || {};
  return { shipmentRef: d.order_id, trackingUrl: d.tracking_url, providerStatus: d.status, status: mapStatus(d.status) };
}

async function cancel(shipmentRef) {
  await call(`/v1/shipping/labels/cancel/${encodeURIComponent(shipmentRef)}`, { method: 'POST' });
  return { cancelled: true };
}

async function track(refs) {
  if (!refs.length) return [];
  const res = await call(`/v1/shipping/labels/list/${refs.slice(0, 50).map(encodeURIComponent).join(',')}`);
  return (res.data?.results || []).map((r) => ({ shipmentRef: r.order_id, providerStatus: r.status, status: mapStatus(r.status), trackingUrl: r.tracking_url, courier: r.courier?.name, events: r.package_status || [] }));
}

/** Map Shipbubble statuses to MubaPay delivery states. Unknown statuses are kept as "in_transit" with the raw value recorded. */
function mapStatus(s) {
  const v = String(s || '').toLowerCase();
  if (['pending', 'confirmed', 'created'].includes(v)) return 'booked';
  if (['picked_up', 'pickedup', 'in_transit', 'intransit', 'out_for_delivery'].includes(v)) return 'in_transit';
  if (['completed', 'delivered'].includes(v)) return 'delivered';
  if (['cancelled', 'canceled'].includes(v)) return 'cancelled';
  if (['failed', 'returned', 'rejected'].includes(v)) return 'failed';
  return 'in_transit';
}

function verifyWebhookSignature(rawBody, signature) {
  if (!config.SHIPBUBBLE_API_KEY || !signature || !rawBody) return false;
  const expected = crypto.createHmac('sha512', config.SHIPBUBBLE_API_KEY).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { name, capabilities, isConfigured, validateAddress, categories, quote, book, cancel, track, mapStatus, verifyWebhookSignature, nairaToKoboLoose };
