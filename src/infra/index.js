'use strict';
/**
 * Infrastructure implementation — VERSION A (no Redis).
 *
 *  queue / scheduler  → MongoDB-backed durable queue (mongoQueue.js)
 *  cache              → per-process in-memory TTL cache for NON-sensitive,
 *                       non-financial derived data only
 *  rate limiting      → MongoDB fixed-window store (shared across instances)
 *  Socket.IO          → single-instance in-memory adapter. Horizontal scaling of
 *                       Socket.IO is NOT supported in this version; run one API
 *                       instance, or use sticky sessions and accept that events
 *                       only reach sockets on the emitting instance (the
 *                       frontend falls back to polling /notifications).
 */
const queue = require('./mongoQueue');
const { mongoose } = require('../lib/db');
const logger = require('../lib/logger');

// ---------------- cache ----------------
const store = new Map();
const MAX_ENTRIES = 2000;
const cache = {
  backend: 'memory',
  async get(key) {
    const e = store.get(key);
    if (!e) return null;
    if (e.exp < Date.now()) {
      store.delete(key);
      return null;
    }
    return e.v;
  },
  async set(key, value, ttlSec = 60) {
    if (store.size >= MAX_ENTRIES) store.delete(store.keys().next().value);
    store.set(key, { v: value, exp: Date.now() + ttlSec * 1000 });
  },
  async del(key) {
    store.delete(key);
  },
  async invalidatePrefix(prefix) {
    for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
  },
};

// ---------------- rate limit store ----------------
const rlSchema = new mongoose.Schema({ key: String, hits: Number, expiresAt: Date }, { versionKey: false });
rlSchema.index({ key: 1 }, { unique: true });
rlSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
const RateLimitHit = mongoose.models.RateLimitHit || mongoose.model('RateLimitHit', rlSchema);

class MongoRateLimitStore {
  constructor(prefix) {
    this.prefix = prefix;
    this.localKeys = true;
  }
  init(options) {
    this.windowMs = options.windowMs;
  }
  bucket(key) {
    const start = Math.floor(Date.now() / this.windowMs) * this.windowMs;
    return { k: `${this.prefix}:${key}:${start}`, resetTime: new Date(start + this.windowMs) };
  }
  async get(key) {
    const { k, resetTime } = this.bucket(key);
    const d = await RateLimitHit.findOne({ key: k }).lean();
    return d ? { totalHits: d.hits, resetTime } : undefined;
  }
  async increment(key) {
    const { k, resetTime } = this.bucket(key);
    try {
      const d = await RateLimitHit.findOneAndUpdate({ key: k }, { $inc: { hits: 1 }, $setOnInsert: { expiresAt: new Date(resetTime.getTime() + 60000) } }, { upsert: true, new: true });
      return { totalHits: d.hits, resetTime };
    } catch (err) {
      if (err.code === 11000) return this.increment(key);
      logger.warn({ err: err.message }, 'rate limit store error — allowing request');
      return { totalHits: 0, resetTime };
    }
  }
  async decrement(key) {
    const { k } = this.bucket(key);
    await RateLimitHit.updateOne({ key: k }, { $inc: { hits: -1 } });
  }
  async resetKey(key) {
    const { k } = this.bucket(key);
    await RateLimitHit.deleteOne({ key: k });
  }
}

module.exports = {
  name: 'without-redis',
  queue,
  cache,
  async init() {},
  async shutdown() {
    await queue.stop();
  },
  rateLimitStore(prefix) {
    return new MongoRateLimitStore(prefix);
  },
  socketAdapter() {
    return null;
  },
  /** No Redis to lose: the MongoDB queue is already the durable path. */
  startDegradedFallback() {},
  isRedisReady: () => false,
  /** Worker processes cannot reach browser sockets in this version. */
  createWorkerEmitter() {
    return null;
  },
  async health() {
    const q = await queue.stats().catch((e) => ({ error: e.message }));
    return {
      redis: { status: 'not_used' },
      queue: { status: q.error ? 'degraded' : 'ok', backend: 'mongodb', pending: q.pending, running: q.running, failed: q.failed, stalled: q.stalled },
      realtime: { status: 'ok', adapter: 'in-memory (single instance)' },
      cache: { status: 'ok', backend: 'memory' },
    };
  },
};
