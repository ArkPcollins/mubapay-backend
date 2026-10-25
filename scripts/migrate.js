'use strict';
/**
 * Versioned migration runner.  Usage: node scripts/migrate.js up|status
 * - Applies migrations in filename order, each exactly once (MigrationRecord).
 * - A lock document prevents two deploys migrating concurrently.
 * - Migrations must be idempotent and forward-only; rollback = a new migration
 *   (or restore from backup — see documentation/operations/backup-and-recovery.md).
 */
const fs = require('fs');
const path = require('path');
const { bootstrap, loadModels } = require('../src/bootstrap');
const db = require('../src/lib/db');
const logger = require('../src/lib/logger');

const recSchema = new db.mongoose.Schema({ id: { type: String, unique: true }, appliedAt: Date, description: String, durationMs: Number }, { versionKey: false });
const MigrationRecord = db.mongoose.models.MigrationRecord || db.mongoose.model('MigrationRecord', recSchema);
const lockSchema = new db.mongoose.Schema({ _id: String, lockedAt: Date, by: String }, { versionKey: false });
const MigrationLock = db.mongoose.models.MigrationLock || db.mongoose.model('MigrationLock', lockSchema);

function list() {
  const dir = path.join(__dirname, '..', 'migrations');
  return fs.readdirSync(dir).filter((f) => /^\d{3}-.*\.js$/.test(f)).sort().map((f) => require(path.join(dir, f)));
}

async function run(cmd = 'up') {
  loadModels();
  await bootstrap({ syncIndexes: false });
  const applied = new Set((await MigrationRecord.find({}).lean()).map((r) => r.id));
  const all = list();
  if (cmd === 'status') {
    for (const m of all) console.log(`${applied.has(m.id) ? '✔ applied ' : '… pending '} ${m.id} — ${m.description}`);
    return;
  }
  const holder = `${require('os').hostname()}:${process.pid}`;
  try {
    await MigrationLock.create({ _id: 'migrations', lockedAt: new Date(), by: holder });
  } catch {
    const l = await MigrationLock.findById('migrations').lean();
    if (l && Date.now() - l.lockedAt.getTime() < 15 * 60e3) throw new Error(`Migrations locked by ${l.by} since ${l.lockedAt.toISOString()}`);
    await MigrationLock.updateOne({ _id: 'migrations' }, { $set: { lockedAt: new Date(), by: holder } });
  }
  try {
    for (const m of all) {
      if (applied.has(m.id)) continue;
      const t0 = Date.now();
      logger.info({ id: m.id }, 'applying migration');
      await m.up({ mongoose: db.mongoose });
      await MigrationRecord.create({ id: m.id, appliedAt: new Date(), description: m.description, durationMs: Date.now() - t0 });
      console.log(`✔ ${m.id} (${Date.now() - t0}ms)`);
    }
    console.log('Migrations complete.');
  } finally {
    await MigrationLock.deleteOne({ _id: 'migrations', by: holder });
  }
}

if (require.main === module) {
  run(process.argv[2])
    .then(() => db.disconnect())
    .then(() => process.exit(0))
    .catch(async (err) => {
      console.error('Migration failed:', err.message);
      await db.disconnect().catch(() => {});
      process.exit(1);
    });
}

module.exports = { run, list, MigrationRecord };
