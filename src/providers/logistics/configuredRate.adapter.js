'use strict';
/**
 * "Configured rate" provider: MubaPay's own, explicitly configured delivery
 * pricing rules (Settings → delivery.configuredRates), fulfilled by MubaPay
 * dispatch staff or contracted riders. There is no external API: booking
 * creates a shipment that staff progress manually, with evidence.
 */
const settings = require('../../modules/settings/settings.service');
const crypto = require('crypto');

const name = 'configured_rate';
const capabilities = { serviceability: true, quote: true, book: true, cancel: true, track: false, webhooks: false, evidence: true, manual: true };

const isConfigured = () => true;

async function quote({ originState, destinationState }) {
  const d = await settings.get('delivery');
  if (!d.configuredRateEnabled) return [];
  const rule = d.configuredRates.find((r) => r.fromState.toLowerCase() === String(originState).toLowerCase() && r.toState.toLowerCase() === String(destinationState).toLowerCase());
  if (!rule) return [];
  return [{
    provider: name, quoteRef: `CR-${crypto.randomBytes(6).toString('hex')}`, serviceCode: 'standard', courierId: 'mubapay-dispatch', courierName: 'MubaPay Dispatch',
    feeKobo: rule.feeKobo, currency: 'NGN', etaText: rule.etaDays <= 1 ? 'Next business day' : `${rule.etaDays} business days`, etaAt: new Date(Date.now() + rule.etaDays * 864e5),
    expiresAt: new Date(Date.now() + 864e5), raw: { rule },
  }];
}

async function book() {
  return { shipmentRef: `MPD-${crypto.randomBytes(5).toString('hex').toUpperCase()}`, trackingUrl: null, providerStatus: 'awaiting_dispatch', status: 'booked' };
}
async function cancel() {
  return { cancelled: true };
}

module.exports = { name, capabilities, isConfigured, quote, book, cancel };
