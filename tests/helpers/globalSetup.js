'use strict';
/**
 * Starts a REAL single-node MongoDB replica set (transactions enabled) for the
 * test run using mongodb-memory-server-core. Set MONGOMS_SYSTEM_BINARY to a
 * local mongod (>= 6.0) to run offline, or MONGODB_TEST_URI to use an existing
 * replica set.
 */
module.exports = async () => {
  if (process.env.MONGODB_TEST_URI) return;
  const { MongoMemoryReplSet } = require('mongodb-memory-server-core');
  const rs = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: 'wiredTiger' },
    binary: process.env.MONGOMS_SYSTEM_BINARY ? { systemBinary: process.env.MONGOMS_SYSTEM_BINARY } : { version: '7.0.14' },
  });
  await rs.waitUntilRunning();
  globalThis.__MONGO_RS__ = rs;
  process.env.MONGODB_TEST_URI = rs.getUri();
};
