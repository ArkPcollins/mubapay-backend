'use strict';
/** Lightweight in-process request metrics (per instance) for the system-performance report. */
const buckets = new Map();
const startedAt = Date.now();
let errors5xx = 0;

function routeKey(req) {
  const base = (req.baseUrl || '') + (req.route?.path || '');
  return `${req.method} ${base || 'unmatched'}`;
}

function middleware(req, res, next) {
  const t0 = process.hrtime.bigint();
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    const key = routeKey(req);
    let b = buckets.get(key);
    if (!b) {
      b = { count: 0, totalMs: 0, samples: [] };
      buckets.set(key, b);
    }
    b.count += 1;
    b.totalMs += ms;
    b.samples.push(ms);
    if (b.samples.length > 500) b.samples.shift();
    if (res.statusCode >= 500) errors5xx += 1;
  });
  next();
}

function pct(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] * 10) / 10;
}

function snapshot() {
  const routes = [...buckets.entries()].map(([k, b]) => ({ route: k, count: b.count, avgMs: Math.round((b.totalMs / b.count) * 10) / 10, p95Ms: pct(b.samples, 95) })).sort((a, b) => b.count - a.count).slice(0, 25);
  const mem = process.memoryUsage();
  return { uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), errors5xx, rssMb: Math.round(mem.rss / 1048576), heapUsedMb: Math.round(mem.heapUsed / 1048576), topRoutes: routes, scope: 'this instance since start' };
}

module.exports = { middleware, snapshot };
