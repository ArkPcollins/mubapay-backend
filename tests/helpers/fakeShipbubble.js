'use strict';
/** Scripted Shipbubble stand-in (documented response shapes only). Tests only. */
const crypto = require('crypto');

class FakeShipbubble {
  constructor() {
    this.labels = new Map();
    this.failNext = {};
    this.calls = [];
  }
  json(status, body) {
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  }
  signature(body) {
    return crypto.createHmac('sha512', process.env.SHIPBUBBLE_API_KEY).update(body).digest('hex');
  }
  async handle(url, opts = {}) {
    const p = new URL(url).pathname;
    const method = opts.method || 'GET';
    this.calls.push({ method, path: p });
    for (const [frag, mode] of Object.entries(this.failNext)) {
      if (p.includes(frag)) {
        delete this.failNext[frag];
        if (mode === 'timeout') throw Object.assign(new Error('timeout'), { name: 'TimeoutError' });
        return this.json(mode, { status: 'failed', message: `fake ${mode}` });
      }
    }
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (p === '/v1/shipping/address/validate') return this.json(200, { status: 'success', data: { address_code: 7000000 + Math.floor(Math.random() * 99999), formatted_address: body.address, state: 'Anambra', city: 'Awka' } });
    if (p === '/v1/shipping/fetch_rates') {
      return this.json(200, { status: 'success', data: { request_token: `rt_${crypto.randomBytes(6).toString('hex')}`, couriers: [
        { courier_id: 'gigl', courier_name: 'GIG Logistics', service_code: 'gigl_std', total: 2850.5, currency: 'NGN', delivery_eta: 'Within 48 hrs', delivery_eta_time: new Date(Date.now() + 2 * 864e5).toISOString() },
        { courier_id: 'kwik', courier_name: 'Kwik', service_code: 'kwik_same_day', total: 4200, currency: 'NGN', delivery_eta: 'Within 6 hrs', delivery_eta_time: new Date(Date.now() + 6 * 3600e3).toISOString() },
      ] } });
    }
    if (p === '/v1/shipping/labels' && method === 'POST') {
      const id = `SB-${crypto.randomBytes(5).toString('hex').toUpperCase()}`;
      this.labels.set(id, { order_id: id, status: 'pending', tracking_url: `https://track.shipbubble.test/${id}` });
      return this.json(200, { status: 'success', data: this.labels.get(id) });
    }
    if (p.startsWith('/v1/shipping/labels/cancel/')) return this.json(200, { status: 'success', message: 'cancelled' });
    if (p.startsWith('/v1/shipping/labels/list/')) {
      const ids = decodeURIComponent(p.split('/').pop()).split(',');
      return this.json(200, { status: 'success', data: { results: ids.filter((i) => this.labels.has(i)).map((i) => this.labels.get(i)) } });
    }
    return this.json(404, { status: 'failed', message: `fake: no route ${p}` });
  }
}

module.exports = { FakeShipbubble };
