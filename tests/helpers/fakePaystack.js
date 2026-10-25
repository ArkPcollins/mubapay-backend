'use strict';
/**
 * Scripted Paystack stand-in for automated tests. It implements the subset of
 * Paystack's documented response shapes MubaPay consumes, so the real adapter
 * code (HTTP, parsing, error handling) is exercised. It is installed via
 * globalThis.__providerFetch and is NEVER used outside tests.
 */
const crypto = require('crypto');

class FakePaystack {
  constructor() {
    this.transactions = new Map(); // reference -> { status, amount, currency, fees, id }
    this.transfers = new Map();
    this.refunds = new Map();
    this.failNext = {}; // path fragment -> 'timeout' | 500 | 400
    this.calls = [];
  }

  /** Simulate the customer completing payment at Paystack. */
  pay(reference, { status = 'success', amount, fees = 150, currency = 'NGN' } = {}) {
    const t = this.transactions.get(reference);
    if (!t) throw new Error(`fake: unknown reference ${reference}`);
    Object.assign(t, { status, amount: amount ?? t.amount, fees, currency, paid_at: new Date().toISOString() });
    return t;
  }

  signature(body) {
    return crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(body).digest('hex');
  }

  webhookBody(event, data) {
    return JSON.stringify({ event, data });
  }

  json(status, body) {
    return { ok: status < 400, status, text: async () => JSON.stringify(body) };
  }

  install() {
    globalThis.__providerFetch = (url, opts) => this.handle(url, opts);
    return this;
  }

  uninstall() {
    delete globalThis.__providerFetch;
  }

  async handle(url, opts = {}) {
    const u = new URL(url);
    const p = u.pathname;
    const method = opts.method || 'GET';
    this.calls.push({ method, path: p });
    for (const [frag, mode] of Object.entries(this.failNext)) {
      if (p.includes(frag)) {
        delete this.failNext[frag];
        if (mode === 'timeout') {
          const e = new Error('The operation was aborted due to timeout');
          e.name = 'TimeoutError';
          throw e;
        }
        if (mode === 'garbage') return { ok: true, status: 200, text: async () => '<html>oops</html>' };
        return this.json(mode, { status: false, message: `fake ${mode}` });
      }
    }
    const body = opts.body ? JSON.parse(opts.body) : {};
    if (p === '/transaction/initialize' && method === 'POST') {
      if (this.transactions.has(body.reference)) return this.json(400, { status: false, message: 'Duplicate Transaction Reference' });
      const id = Math.floor(Math.random() * 1e9);
      this.transactions.set(body.reference, { id, reference: body.reference, amount: body.amount, currency: 'NGN', status: 'ongoing', email: body.email });
      return this.json(200, { status: true, data: { authorization_url: `https://checkout.paystack.test/${body.reference}`, access_code: `ac_${id}`, reference: body.reference } });
    }
    if (p.startsWith('/transaction/verify/')) {
      const ref = decodeURIComponent(p.split('/').pop());
      const t = this.transactions.get(ref);
      if (!t) return this.json(400, { status: false, message: 'Transaction reference not found' });
      return this.json(200, { status: true, data: { id: t.id, reference: ref, status: t.status === 'ongoing' ? 'ongoing' : t.status, amount: t.amount, currency: t.currency, fees: t.status === 'success' ? t.fees : null, paid_at: t.paid_at, channel: 'card', gateway_response: t.status === 'success' ? 'Approved' : 'Pending', customer: { email: t.email }, authorization: { authorization_code: 'AUTH_fake', reusable: true, last4: '4081', brand: 'visa', exp_month: '12', exp_year: '2030', bank: 'TEST BANK', signature: 'SIG_fake' } } });
    }
    if (p === '/transaction' && method === 'GET') {
      const items = [...this.transactions.values()].map((t) => ({ id: t.id, reference: t.reference, status: t.status === 'ongoing' ? 'abandoned' : t.status, amount: t.amount, currency: t.currency, paid_at: t.paid_at }));
      return this.json(200, { status: true, data: items, meta: { pageCount: 1, page: 1 } });
    }
    if (p === '/transaction/charge_authorization') {
      const id = Math.floor(Math.random() * 1e9);
      const status = this.chargeOutcome || 'success';
      this.transactions.set(body.reference, { id, reference: body.reference, amount: body.amount, currency: 'NGN', status, fees: 100, paid_at: new Date().toISOString(), email: body.email });
      return this.json(200, { status: true, data: { status, reference: body.reference } });
    }
    if (p === '/bank') return this.json(200, { status: true, data: [{ name: 'Test Bank', code: '999', slug: 'test-bank', active: true }] });
    if (p === '/bank/resolve') return this.json(200, { status: true, data: { account_name: this.accountName || 'ADA OKAFOR', account_number: u.searchParams.get('account_number') } });
    if (p === '/transferrecipient') return this.json(200, { status: true, data: { recipient_code: `RCP_${crypto.randomBytes(4).toString('hex')}` } });
    if (p === '/transfer' && method === 'POST') {
      this.transfers.set(body.reference, { reference: body.reference, amount: body.amount, status: this.transferInitialStatus || 'pending', transfer_code: `TRF_${crypto.randomBytes(4).toString('hex')}` });
      const t = this.transfers.get(body.reference);
      return this.json(200, { status: true, data: { status: t.status, reference: t.reference, transfer_code: t.transfer_code } });
    }
    if (p.startsWith('/transfer/verify/')) {
      const ref = decodeURIComponent(p.split('/').pop());
      const t = this.transfers.get(ref);
      if (!t) return this.json(404, { status: false, message: 'Transfer not found' });
      return this.json(200, { status: true, data: { status: t.status, amount: t.amount, reference: ref, transfer_code: t.transfer_code } });
    }
    if (p === '/refund' && method === 'POST') {
      const id = Math.floor(Math.random() * 1e9);
      this.refunds.set(String(id), { id, status: 'pending', amount: body.amount, transaction_reference: body.transaction });
      return this.json(200, { status: true, data: { id, status: 'pending' } });
    }
    if (p.startsWith('/refund/')) {
      const r = this.refunds.get(p.split('/').pop());
      if (!r) return this.json(404, { status: false, message: 'not found' });
      return this.json(200, { status: true, data: r });
    }
    return this.json(404, { status: false, message: `fake: no route ${method} ${p}` });
  }
}

module.exports = { FakePaystack };
