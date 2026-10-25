'use strict';
/**
 * Paystack adapter — uses only documented Paystack REST endpoints:
 *   POST /transaction/initialize            create a checkout
 *   GET  /transaction/verify/:reference     server-side verification
 *   GET  /transaction?from&to&perPage&page  list (reconciliation)
 *   POST /transaction/charge_authorization  charge a saved, reusable card (scheduled savings)
 *   GET  /bank?country=nigeria              list banks
 *   GET  /bank/resolve                      resolve account name
 *   POST /transferrecipient                 create NUBAN recipient
 *   POST /transfer                          initiate payout (requires Transfers enabled on the Paystack account)
 *   GET  /transfer/verify/:reference        verify payout
 *   POST /refund                            refund a transaction
 * Webhooks: HMAC-SHA512 of the raw body with the secret key, header `x-paystack-signature`.
 *
 * Amounts sent to / received from Paystack are in kobo (subunit), matching our internal unit.
 */
const crypto = require('crypto');
const config = require('../../config');
const { request } = require('../http');
const { E } = require('../../lib/errors');

function requireConfigured() {
  if (!config.integrations.paystack) {
    throw E.notConfigured('Paystack', 'Set PAYSTACK_SECRET_KEY (sk_test_… for development/staging, sk_live_… for production) and PAYSTACK_PUBLIC_KEY. See documentation/integrations/paystack.md');
  }
}

const call = (path, opts = {}) => {
  requireConfigured();
  return request(`${config.PAYSTACK_BASE_URL}${path}`, { ...opts, headers: { authorization: `Bearer ${config.PAYSTACK_SECRET_KEY}`, ...(opts.headers || {}) } });
};

async function initializeTransaction({ email, amountKobo, reference, callbackUrl, metadata, channels }) {
  const res = await call('/transaction/initialize', {
    method: 'POST',
    body: { email, amount: amountKobo, reference, currency: 'NGN', callback_url: callbackUrl, metadata, channels },
  });
  if (!res.status) throw E.provider(res.message || 'Paystack rejected the initialisation');
  return { authorizationUrl: res.data.authorization_url, accessCode: res.data.access_code, reference: res.data.reference };
}

/**
 * Normalised verification result:
 *  { found, status: 'success'|'failed'|'abandoned'|'pending'|'reversed'|..., amountKobo, currency, paidAt, feesKobo, channel, authorization, customerEmail, raw }
 */
async function verifyTransaction(reference) {
  let res;
  try {
    res = await call(`/transaction/verify/${encodeURIComponent(reference)}`);
  } catch (err) {
    if (err.status === 404 || (err.status === 400 && /not found/i.test(err.message))) return { found: false };
    throw err;
  }
  const d = res.data || {};
  return {
    found: true,
    status: d.status,
    amountKobo: d.amount,
    currency: d.currency,
    paidAt: d.paid_at || d.paidAt,
    feesKobo: d.fees ?? null,
    channel: d.channel,
    gatewayResponse: d.gateway_response,
    providerTransactionId: d.id != null ? String(d.id) : undefined,
    authorization: d.authorization && d.authorization.reusable
      ? { authorizationCode: d.authorization.authorization_code, last4: d.authorization.last4, brand: d.authorization.brand, expMonth: d.authorization.exp_month, expYear: d.authorization.exp_year, bank: d.authorization.bank, reusable: true, signature: d.authorization.signature }
      : null,
    customerEmail: d.customer?.email,
    raw: { id: d.id, status: d.status, amount: d.amount, currency: d.currency, reference: d.reference, gateway_response: d.gateway_response, paid_at: d.paid_at, channel: d.channel, fees: d.fees },
  };
}

async function listTransactions({ from, to, page = 1, perPage = 100 }) {
  const qs = new URLSearchParams({ from: new Date(from).toISOString(), to: new Date(to).toISOString(), page: String(page), perPage: String(perPage) });
  const res = await call(`/transaction?${qs}`);
  return {
    items: (res.data || []).map((d) => ({ reference: d.reference, status: d.status, amountKobo: d.amount, currency: d.currency, paidAt: d.paid_at, id: String(d.id) })),
    meta: res.meta || {},
  };
}

async function chargeAuthorization({ authorizationCode, email, amountKobo, reference, metadata }) {
  const res = await call('/transaction/charge_authorization', {
    method: 'POST',
    body: { authorization_code: authorizationCode, email, amount: amountKobo, reference, currency: 'NGN', metadata },
  });
  return { status: res.data?.status, reference: res.data?.reference, gatewayResponse: res.data?.gateway_response };
}

async function listBanks() {
  const res = await call('/bank?country=nigeria&perPage=100');
  return (res.data || []).filter((b) => b.active !== false).map((b) => ({ name: b.name, code: b.code, slug: b.slug }));
}

async function resolveAccount({ accountNumber, bankCode }) {
  const res = await call(`/bank/resolve?account_number=${encodeURIComponent(accountNumber)}&bank_code=${encodeURIComponent(bankCode)}`);
  return { accountName: res.data?.account_name, accountNumber: res.data?.account_number };
}

async function createTransferRecipient({ name, accountNumber, bankCode }) {
  const res = await call('/transferrecipient', { method: 'POST', body: { type: 'nuban', name, account_number: accountNumber, bank_code: bankCode, currency: 'NGN' } });
  return { recipientCode: res.data?.recipient_code };
}

/** Initiate a payout. Acceptance (status 'pending'/'otp') is NOT success. */
async function initiateTransfer({ amountKobo, recipientCode, reference, reason }) {
  if (!config.integrations.paystackTransfers) {
    throw E.notConfigured('Paystack Transfers', 'Enable Transfers on your Paystack business account, disable OTP for API transfers, then set PAYSTACK_TRANSFERS_ENABLED=true');
  }
  const res = await call('/transfer', { method: 'POST', body: { source: 'balance', amount: amountKobo, recipient: recipientCode, reference, reason } });
  return { status: res.data?.status, transferCode: res.data?.transfer_code, reference: res.data?.reference };
}

async function verifyTransfer(reference) {
  try {
    const res = await call(`/transfer/verify/${encodeURIComponent(reference)}`);
    return { found: true, status: res.data?.status, amountKobo: res.data?.amount, transferCode: res.data?.transfer_code, reason: res.data?.reason, raw: { status: res.data?.status, amount: res.data?.amount, reference: res.data?.reference } };
  } catch (err) {
    if (err.status === 404) return { found: false };
    throw err;
  }
}

async function refundTransaction({ reference, amountKobo, merchantNote }) {
  const res = await call('/refund', { method: 'POST', body: { transaction: reference, amount: amountKobo, merchant_note: merchantNote } });
  return { status: res.data?.status, refundId: res.data?.id != null ? String(res.data.id) : undefined };
}

/** GET /refund/:id — statuses include pending, processing, processed, failed, needs-attention. */
async function fetchRefund(id) {
  const res = await call(`/refund/${encodeURIComponent(id)}`);
  return { status: res.data?.status, amountKobo: res.data?.amount, transactionReference: res.data?.transaction_reference || res.data?.transaction?.reference };
}

/** Verify `x-paystack-signature` (HMAC SHA512 of raw body using the secret key). */
function verifyWebhookSignature(rawBody, signature) {
  if (!config.PAYSTACK_SECRET_KEY || !signature || !rawBody) return false;
  const expected = crypto.createHmac('sha512', config.PAYSTACK_SECRET_KEY).update(rawBody).digest('hex');
  const a = Buffer.from(expected);
  const b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function status() {
  return {
    implemented: true,
    configured: config.integrations.paystack,
    mode: config.integrations.paystack ? (config.PAYSTACK_SECRET_KEY.startsWith('sk_live_') ? 'live' : 'test') : null,
    transfersEnabled: config.integrations.paystackTransfers,
  };
}

module.exports = {
  initializeTransaction, verifyTransaction, listTransactions, chargeAuthorization, listBanks, resolveAccount,
  createTransferRecipient, initiateTransfer, verifyTransfer, refundTransaction, fetchRefund, verifyWebhookSignature, status, requireConfigured,
};
