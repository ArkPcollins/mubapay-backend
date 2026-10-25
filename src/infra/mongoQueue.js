'use strict';
/**
 * Durable MongoDB-backed job queue (Version A — no Redis).
 *
 * Guarantees
 *  - Durability: jobs are documents; they survive restarts.
 *  - Exclusive claiming: a worker claims a job with a single atomic
 *    findOneAndUpdate that flips status pending→running and sets a lease
 *    (lockedBy + lockedUntil). MongoDB serialises writes to one document, so
 *    only one worker can win the claim.
 *  - Crash recovery: a running job whose lease expired (worker died) becomes
 *    claimable again. Long jobs renew their lease with a heartbeat.
 *  - Completion fencing: success/failure updates are conditional on
 *    lockedBy === this worker, so a worker that lost its lease cannot
 *    overwrite the outcome recorded by the worker that re-claimed it.
 *  - Duplicate prevention: optional jobId → unique dedupeKey index.
 *  - Retries with exponential backoff; permanent failures are kept as
 *    status "failed" for monitoring and manual retry.
 *
 * Because a job can, in rare crash cases, run more than once (at-least-once
 * delivery), every job handler in MubaPay is idempotent (ledger references,
 * conditional state transitions, notification delivery state).
 */
const os = require('os');
const crypto = require('crypto');
const { mongoose } = require('../lib/db');
const logger = require('../lib/logger');
const cron = require('../lib/cron');

const { Schema } = mongoose;

const jobSchema = new Schema(
  {
    name: { type: String, required: true },
    data: Schema.Types.Mixed,
    status: { type: String, enum: ['pending', 'running', 'succeeded', 'failed'], default: 'pending' },
    dedupeKey: String,
    runAt: { type: Date, default: Date.now },
    attempts: { type: Number, default: 0 },
    maxAttempts: { type: Number, default: 5 },
    backoffMs: { type: Number, default: 10000 },
    lockedBy: String,
    lockedUntil: Date,
    lastError: String,
    startedAt: Date,
    finishedAt: Date,
    expiresAt: Date,
  },
  { timestamps: true, minimize: false }
);
jobSchema.index({ status: 1, runAt: 1 });
jobSchema.index({ status: 1, lockedUntil: 1 });
jobSchema.index({ name: 1, status: 1 });
jobSchema.index({ dedupeKey: 1 }, { unique: true, partialFilterExpression: { dedupeKey: { $type: 'string' } } });
jobSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

const scheduleSchema = new Schema(
  {
    name: { type: String, required: true },
    jobName: String,
    cron: String,
    everyMs: Number,
    data: Schema.Types.Mixed,
    nextRunAt: Date,
    lockedUntil: Date,
    lastRunAt: Date,
  },
  { timestamps: true }
);
scheduleSchema.index({ name: 1 }, { unique: true });

const Job = mongoose.models.Job || mongoose.model('Job', jobSchema);
const Schedule = mongoose.models.JobSchedule || mongoose.model('JobSchedule', scheduleSchema);

const WORKER_ID = `${os.hostname()}:${process.pid}:${crypto.randomBytes(3).toString('hex')}`;
const LEASE_MS = 60000;
const SUCCESS_RETENTION_MS = 7 * 864e5;
const FAILED_RETENTION_MS = 90 * 864e5;

const handlers = new Map();
const schedules = new Map();
let running = false;
let active = 0;
let concurrency = 4;
let pollTimer;
let scheduleTimer;

async function add(name, data = {}, { jobId, delayMs = 0, attempts = 5, backoffMs = 10000, session } = {}) {
  const doc = { name, data, dedupeKey: jobId, runAt: new Date(Date.now() + delayMs), maxAttempts: attempts, backoffMs };
  try {
    const [job] = await Job.create([doc], { session });
    return { id: String(job._id), duplicate: false };
  } catch (err) {
    if (err.code === 11000 && jobId) return { id: jobId, duplicate: true };
    throw err;
  }
}

function registerHandler(name, fn) {
  handlers.set(name, fn);
}

/** Register a recurring schedule: { cron } (Africa/Lagos) or { everyMs }. */
function schedule(name, spec, data = {}) {
  schedules.set(name, { name, jobName: spec.jobName || name, cron: spec.cron, everyMs: spec.everyMs, data });
}

async function claimOne() {
  const now = new Date();
  return Job.findOneAndUpdate(
    {
      name: { $in: [...handlers.keys()] },
      $or: [{ status: 'pending', runAt: { $lte: now } }, { status: 'running', lockedUntil: { $lt: now } }],
    },
    { $set: { status: 'running', lockedBy: WORKER_ID, lockedUntil: new Date(Date.now() + LEASE_MS), startedAt: now }, $inc: { attempts: 1 } },
    { sort: { runAt: 1 }, new: true }
  );
}

async function runJob(job) {
  const fn = handlers.get(job.name);
  const heartbeat = setInterval(() => {
    Job.updateOne({ _id: job._id, lockedBy: WORKER_ID, status: 'running' }, { $set: { lockedUntil: new Date(Date.now() + LEASE_MS) } }).catch(() => {});
  }, LEASE_MS / 3);
  try {
    await fn(job.data || {}, { id: String(job._id), attempt: job.attempts, name: job.name });
    await Job.updateOne(
      { _id: job._id, lockedBy: WORKER_ID },
      { $set: { status: 'succeeded', finishedAt: new Date(), lockedUntil: null, lastError: null, expiresAt: new Date(Date.now() + SUCCESS_RETENTION_MS) } }
    );
  } catch (err) {
    const final = job.attempts >= job.maxAttempts || err.permanent === true;
    const delay = job.backoffMs * 2 ** Math.max(0, job.attempts - 1);
    await Job.updateOne(
      { _id: job._id, lockedBy: WORKER_ID },
      {
        $set: final
          ? { status: 'failed', finishedAt: new Date(), lockedUntil: null, lastError: String(err.message).slice(0, 1000), expiresAt: new Date(Date.now() + FAILED_RETENTION_MS) }
          : { status: 'pending', runAt: new Date(Date.now() + delay), lockedUntil: null, lastError: String(err.message).slice(0, 1000) },
      }
    );
    logger[final ? 'error' : 'warn']({ job: job.name, id: String(job._id), attempt: job.attempts, err: err.message }, final ? 'job failed permanently' : 'job failed, will retry');
    if (final && module.exports.onPermanentFailure) module.exports.onPermanentFailure(job, err);
  } finally {
    clearInterval(heartbeat);
  }
}

async function poll() {
  if (!running) return;
  let claimed = 0;
  try {
    while (running && active < concurrency) {
      const job = await claimOne();
      if (!job) break;
      claimed += 1;
      active += 1;
      runJob(job).finally(() => {
        active -= 1;
      });
    }
  } catch (err) {
    logger.error({ err: err.message }, 'queue poll error');
  }
  pollTimer = setTimeout(poll, claimed ? 50 : 1000);
}

async function tickSchedules() {
  if (!running) return;
  try {
    const now = new Date();
    for (const s of schedules.values()) {
      await Schedule.updateOne(
        { name: s.name },
        { $setOnInsert: { name: s.name, nextRunAt: s.cron ? cron.next(s.cron, now) : new Date(now.getTime() + s.everyMs) }, $set: { jobName: s.jobName, cron: s.cron, everyMs: s.everyMs, data: s.data } },
        { upsert: true }
      );
      // Atomically claim the due schedule (one instance wins), then enqueue a uniquely keyed job.
      const due = await Schedule.findOneAndUpdate(
        { name: s.name, nextRunAt: { $lte: now }, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: now } }] },
        { $set: { lockedUntil: new Date(now.getTime() + 30000) } },
        { new: false }
      );
      if (!due) continue;
      const scheduledFor = due.nextRunAt;
      await add(s.jobName, { ...s.data, scheduledFor }, { jobId: `sched:${s.name}:${scheduledFor.toISOString()}`, attempts: 3 });
      const nextRunAt = s.cron ? cron.next(s.cron, now) : new Date(now.getTime() + s.everyMs);
      await Schedule.updateOne({ _id: due._id }, { $set: { nextRunAt, lastRunAt: now, lockedUntil: null } });
    }
  } catch (err) {
    logger.error({ err: err.message }, 'scheduler tick error');
  }
  scheduleTimer = setTimeout(tickSchedules, 5000);
}

async function start({ concurrency: c = 4, runScheduler = true } = {}) {
  if (running) return;
  concurrency = c;
  running = true;
  poll();
  if (runScheduler) tickSchedules();
  logger.info({ worker: WORKER_ID, handlers: handlers.size, schedules: schedules.size }, 'MongoDB queue workers started');
}

async function stop() {
  running = false;
  clearTimeout(pollTimer);
  clearTimeout(scheduleTimer);
  const deadline = Date.now() + 15000;
  while (active > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
}

async function stats() {
  const rows = await Job.aggregate([{ $group: { _id: { name: '$name', status: '$status' }, n: { $sum: 1 } } }]);
  const out = { pending: 0, running: 0, succeeded: 0, failed: 0, byName: {} };
  for (const r of rows) {
    out[r._id.status] = (out[r._id.status] || 0) + r.n;
    out.byName[r._id.name] = out.byName[r._id.name] || {};
    out.byName[r._id.name][r._id.status] = r.n;
  }
  const stalled = await Job.countDocuments({ status: 'running', lockedUntil: { $lt: new Date() } });
  return { backend: 'mongodb', worker: WORKER_ID, ...out, stalled };
}

async function listJobs({ status = 'failed', limit = 50 } = {}) {
  return Job.find({ status }).sort({ updatedAt: -1 }).limit(limit).lean();
}

async function retryJob(id) {
  const r = await Job.updateOne({ _id: id, status: 'failed' }, { $set: { status: 'pending', runAt: new Date(), lastError: null, expiresAt: null }, $inc: { maxAttempts: 1 } });
  return r.modifiedCount === 1;
}

module.exports = { add, registerHandler, schedule, start, stop, stats, listJobs, retryJob, Job, Schedule, WORKER_ID, onPermanentFailure: null, _claimOne: claimOne };
