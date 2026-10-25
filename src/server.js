'use strict';
const http = require('http');
const config = require('./config');
const logger = require('./lib/logger');
const { bootstrap } = require('./bootstrap');
const { createApp } = require('./app');
const socket = require('./realtime/socket');
const infra = require('./infra');
const jobs = require('./jobs');
const db = require('./lib/db');

async function main() {
  await bootstrap();
  const app = createApp();
  const server = http.createServer(app);
  socket.attach(server);
  jobs.register();
  if (config.RUN_WORKER_IN_PROCESS) await infra.queue.start({ concurrency: 4, runScheduler: config.RUN_SCHEDULER });
  server.listen(config.PORT, () => logger.info({ port: config.PORT, variant: infra.name, env: config.APP_ENV }, 'MubaPay API listening'));

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ sig }, 'shutting down gracefully');
    server.close();
    await infra.shutdown().catch(() => {});
    await db.disconnect().catch(() => {});
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
}

main().catch((err) => {
  logger.fatal({ err: err.message }, 'failed to start');
  process.exit(1);
});
