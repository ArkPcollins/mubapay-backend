'use strict';
/** Version A infrastructure: durable MongoDB queue, scheduler and rate-limit store. */
const H = require('../helpers/harness');
const queue = require('../../src/infra/mongoQueue');
const infra = require('../../src/infra');
const { Job, Schedule } = queue;

beforeAll(H.start);
afterAll(async () => {
  await queue.stop();
  await H.stop();
});

test('variant does not use Redis', async () => {
  expect(infra.name).toBe('without-redis');
  expect(process.env.REDIS_URL).toBeUndefined();
  const h = await infra.health();
  expect(h.redis.status).toBe('not_used');
  expect(h.queue.backend).toBe('mongodb');
});

test('jobs are durable and de-duplicated by jobId', async () => {
  const a = await queue.add('t.dedupe', { x: 1 }, { jobId: 'same-key' });
  const b = await queue.add('t.dedupe', { x: 2 }, { jobId: 'same-key' });
  expect(b.duplicate).toBe(true);
  expect(await Job.countDocuments({ dedupeKey: 'same-key' })).toBe(1);
  expect(a.id).toBeTruthy();
});

test('exactly one claimer wins each job under concurrent claiming', async () => {
  queue.registerHandler('t.claim', async () => {});
  await Promise.all(Array.from({ length: 20 }, (_, i) => queue.add('t.claim', { i })));
  const claims = await Promise.all(Array.from({ length: 60 }, () => queue._claimOne()));
  const ids = claims.filter(Boolean).filter((j) => j.name === 't.claim').map((j) => String(j._id));
  expect(ids.length).toBe(20);
  expect(new Set(ids).size).toBe(20); // no job claimed twice
});

test('retries with exponential backoff, then records permanent failure', async () => {
  let runs = 0;
  queue.registerHandler('t.flaky', async () => {
    runs += 1;
    throw new Error('transient boom');
  });
  const permanent = [];
  queue.onPermanentFailure = (job) => permanent.push(job.name);
  const { id } = await queue.add('t.flaky', {}, { attempts: 3, backoffMs: 10 });
  await queue.start({ concurrency: 2, runScheduler: false });
  const deadline = Date.now() + 15000;
  // eslint-disable-next-line no-await-in-loop
  while (Date.now() < deadline && (await Job.findById(id)).status !== 'failed') await new Promise((r) => setTimeout(r, 100));
  const j = await Job.findById(id);
  expect(j.status).toBe('failed');
  expect(j.attempts).toBe(3);
  expect(j.lastError).toMatch(/transient boom/);
  expect(runs).toBe(3);
  expect(permanent).toContain('t.flaky');
  expect(await queue.retryJob(id)).toBe(true);
  const stats = await queue.stats();
  expect(stats.backend).toBe('mongodb');
  await queue.stop();
});

test('a job whose worker crashed (expired lease) is recovered by another worker', async () => {
  queue.registerHandler('t.crash', async () => {});
  const { id } = await queue.add('t.crash', {});
  await Job.updateOne({ _id: id }, { $set: { status: 'running', lockedBy: 'dead-worker', lockedUntil: new Date(Date.now() - 1000), attempts: 1 } });
  await Job.deleteMany({ _id: { $ne: id } }); // isolate from jobs left by earlier tests
  const j = await queue._claimOne();
  expect(String(j._id)).toBe(id);
  expect(j.lockedBy).toBe(queue.WORKER_ID);
  // the dead worker cannot overwrite the outcome (fenced by lockedBy)
  await Job.updateOne({ _id: id, lockedBy: 'dead-worker' }, { $set: { status: 'succeeded' } });
  expect((await Job.findById(id)).status).toBe('running');
});

test('scheduled jobs are enqueued once per slot even with concurrent ticks', async () => {
  await Schedule.create({ name: 't.sched', jobName: 't.sched', everyMs: 60000, nextRunAt: new Date(Date.now() - 1000) });
  queue.schedule('t.sched', { everyMs: 60000 });
  queue.registerHandler('t.sched', async () => {});
  // simulate three instances ticking at the same moment
  const due = await Promise.all([1, 2, 3].map(() => Schedule.findOneAndUpdate({ name: 't.sched', nextRunAt: { $lte: new Date() }, $or: [{ lockedUntil: null }, { lockedUntil: { $lt: new Date() } }] }, { $set: { lockedUntil: new Date(Date.now() + 30000) } })));
  expect(due.filter(Boolean)).toHaveLength(1);
});

test('MongoDB rate-limit store counts across instances', async () => {
  const s1 = infra.rateLimitStore('t');
  const s2 = infra.rateLimitStore('t');
  s1.init({ windowMs: 60000 });
  s2.init({ windowMs: 60000 });
  await s1.increment('ip:1');
  const r = await s2.increment('ip:1');
  expect(r.totalHits).toBe(2);
});
