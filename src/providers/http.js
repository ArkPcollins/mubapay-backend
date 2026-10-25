'use strict';
/**
 * Small fetch wrapper for provider APIs with timeouts and typed outcomes.
 * A timeout or network failure is NEVER treated as a definitive failure of a
 * financial operation: callers receive { outcome: 'unknown' } and must verify.
 */
class ProviderHttpError extends Error {
  constructor(message, { status, body, outcome }) {
    super(message);
    this.status = status;
    this.body = body;
    this.outcome = outcome; // 'rejected' (4xx — definitive) | 'unknown' (timeout/5xx/network)
  }
}

async function request(url, { method = 'GET', headers = {}, body, timeoutMs = 15000, fetchImpl } = {}) {
  const f = fetchImpl || globalThis.__providerFetch || fetch;
  let res;
  try {
    res = await f(url, {
      method,
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new ProviderHttpError(`Network error contacting provider: ${err.name === 'TimeoutError' ? 'timeout' : err.message}`, { outcome: 'unknown' });
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new ProviderHttpError('Provider returned a non-JSON response', { status: res.status, body: text.slice(0, 500), outcome: res.status >= 500 ? 'unknown' : 'rejected' });
  }
  if (!res.ok) {
    throw new ProviderHttpError(json?.message || `Provider HTTP ${res.status}`, { status: res.status, body: json, outcome: res.status >= 500 || res.status === 429 ? 'unknown' : 'rejected' });
  }
  return json;
}

module.exports = { request, ProviderHttpError };
