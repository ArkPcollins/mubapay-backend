'use strict';
/** Dedicated background worker process (scale independently of the API). */
const logger = require('./lib/logger');
const { bootstrap } = require('./bootstrap');
const infra = require('./infra');
const jobs = require('./jobs');
const realtime = require('./realtime/realtime');
const config = require('./config');
const db = require('./lib/db');

async function main() {
  await bootstrap({ syncIndexes: false });
  const emitter = infra.createWorkerEmitter();
  if (emitter) realtime.setEmitter(emitter);
  jobs.register();
  await infra.queue.start({ concurrency: Number(process.env.WORKER_CONCURRENCY || 8), runScheduler: config.RUN_SCHEDULER });
  logger.info({ variant: infra.name }, 'MubaPay worker running');
  const shutdown = async () => {
    await infra.shutdown().catch(() => {});
    await db.disconnect().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  logger.fatal({ err: err.message }, 'worker failed to start');
  process.exit(1);
});
