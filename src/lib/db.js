'use strict';
const mongoose = require('mongoose');
const logger = require('./logger');
const config = require('../config');

mongoose.set('strictQuery', true);

async function connect(uri = config.MONGODB_URI) {
  if (mongoose.connection.readyState === 1) return mongoose.connection;
  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10000,
    retryWrites: true,
    w: 'majority',
    maxPoolSize: 20,
  });
  logger.info({ db: mongoose.connection.name }, 'MongoDB connected');
  return mongoose.connection;
}

async function disconnect() {
  await mongoose.disconnect();
}

/** Ensure the deployment supports transactions (replica set or sharded). */
async function assertTransactionCapable() {
  const admin = mongoose.connection.db.admin();
  const hello = await admin.command({ hello: 1 });
  const capable = Boolean(hello.setName) || hello.msg === 'isdbgrid';
  if (!capable) {
    throw new Error('MongoDB must run as a replica set (or sharded cluster) for multi-document transactions. See documentation/mongodb-replica-set.md');
  }
  return { setName: hello.setName || 'sharded' };
}

/**
 * Run `fn(session)` inside a MongoDB transaction, retrying on transient
 * transaction errors and unknown commit results (driver withTransaction).
 * All financial multi-document writes go through this helper.
 */
async function withTransaction(fn, { maxRetries = 5 } = {}) {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const session = await mongoose.startSession();
    try {
      let result;
      await session.withTransaction(
        async () => {
          // Callbacks registered via afterCommit(session, fn) run only once the
          // transaction has durably committed (e.g. enqueue jobs, emit sockets).
          session.__afterCommit = [];
          result = await fn(session);
        },
        { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority' }, readPreference: 'primary' }
      );
      for (const cb of session.__afterCommit || []) {
        try {
          await cb();
        } catch (err) {
          logger.error({ err }, 'afterCommit callback failed (durable sweepers will retry)');
        }
      }
      return result;
    } catch (err) {
      const transient =
        err?.hasErrorLabel?.('TransientTransactionError') ||
        err?.code === 112 /* WriteConflict */ ||
        err?.codeName === 'WriteConflict';
      if (transient && attempt < maxRetries) {
        attempt += 1;
        await new Promise((r) => setTimeout(r, 15 * attempt + Math.floor(Math.random() * 20)));
        continue;
      }
      throw err;
    } finally {
      await session.endSession();
    }
  }
}

/** Register work to run after commit; runs immediately when there is no session. */
async function afterCommit(session, cb) {
  if (session && Array.isArray(session.__afterCommit)) session.__afterCommit.push(cb);
  else {
    try {
      await cb();
    } catch (err) {
      logger.error({ err }, 'afterCommit callback failed');
    }
  }
}

function isDuplicateKey(err) {
  return err && (err.code === 11000 || err.code === 11001);
}

module.exports = { connect, disconnect, withTransaction, afterCommit, isDuplicateKey, assertTransactionCapable, mongoose };
