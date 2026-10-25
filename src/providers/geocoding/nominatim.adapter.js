'use strict';
/**
 * OpenStreetMap Nominatim geocoding (https://nominatim.org/release-docs/latest/api/Search/).
 * Usage policy compliance: identifying User-Agent (+ email), max 1 request/second
 * per instance, results cached, no bulk geocoding, attribution shown in the UI.
 * For production volume, point NOMINATIM_BASE_URL at a self-hosted or commercial
 * Nominatim-compatible service.
 */
const config = require('../../config');
const infra = require('../../infra');
const { E } = require('../../lib/errors');
const { request } = require('../http');

let last = 0;
async function throttle() {
  const wait = last + 1100 - Date.now();
  last = Math.max(Date.now(), last + 1100);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
}

function requireConfigured() {
  if (!config.NOMINATIM_USER_AGENT) throw E.notConfigured('Geocoding', 'Set NOMINATIM_USER_AGENT to an identifying value (e.g. "MubaPay/1.0 (ops@yourdomain)") per the Nominatim usage policy');
}

async function search(q) {
  requireConfigured();
  const query = String(q).trim().slice(0, 200);
  if (query.length < 3) return [];
  const key = `geo:s:${query.toLowerCase()}`;
  const cached = await infra.cache.get(key);
  if (cached) return cached;
  await throttle();
  const params = new URLSearchParams({ q: query, format: 'jsonv2', countrycodes: 'ng', addressdetails: '1', limit: '5' });
  if (config.NOMINATIM_EMAIL) params.set('email', config.NOMINATIM_EMAIL);
  const rows = await request(`${config.NOMINATIM_BASE_URL}/search?${params}`, { headers: { 'user-agent': config.NOMINATIM_USER_AGENT, 'accept-language': 'en' }, timeoutMs: 8000 });
  const out = (Array.isArray(rows) ? rows : []).map((r) => ({ displayName: r.display_name, lat: Number(r.lat), lng: Number(r.lon), state: r.address?.state?.replace(/ State$/, ''), city: r.address?.city || r.address?.town || r.address?.village, lga: r.address?.county }));
  await infra.cache.set(key, out, 7 * 86400);
  return out;
}

async function reverse(lat, lng) {
  requireConfigured();
  const key = `geo:r:${Number(lat).toFixed(4)},${Number(lng).toFixed(4)}`;
  const cached = await infra.cache.get(key);
  if (cached) return cached;
  await throttle();
  const params = new URLSearchParams({ lat: String(lat), lon: String(lng), format: 'jsonv2', addressdetails: '1' });
  const r = await request(`${config.NOMINATIM_BASE_URL}/reverse?${params}`, { headers: { 'user-agent': config.NOMINATIM_USER_AGENT }, timeoutMs: 8000 });
  const out = { displayName: r.display_name, state: r.address?.state?.replace(/ State$/, ''), city: r.address?.city || r.address?.town || r.address?.village, lga: r.address?.county };
  await infra.cache.set(key, out, 30 * 86400);
  return out;
}

module.exports = { search, reverse, status: () => ({ implemented: true, configured: Boolean(config.NOMINATIM_USER_AGENT), baseUrl: config.NOMINATIM_BASE_URL }) };
