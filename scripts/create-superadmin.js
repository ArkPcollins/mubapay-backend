'use strict';
/**
 * Bootstrap the FIRST superadmin (any environment). Further superadmins must
 * be granted through dual approval in the admin dashboard.
 * Usage: SUPERADMIN_EMAIL=... SUPERADMIN_PASSWORD=... node scripts/create-superadmin.js
 * The account must set up two-factor authentication on first sign-in.
 */
const db = require('../src/lib/db');
const { bootstrap } = require('../src/bootstrap');
const { User } = require('../src/modules/users/user.model');
const auth = require('../src/modules/auth/auth.service');
const ledger = require('../src/modules/ledger/ledger.service');
const audit = require('../src/modules/audit/audit.service');

async function main() {
  const email = String(process.env.SUPERADMIN_EMAIL || '').toLowerCase();
  const password = process.env.SUPERADMIN_PASSWORD;
  if (!email || !password) throw new Error('Set SUPERADMIN_EMAIL and SUPERADMIN_PASSWORD');
  auth.validatePasswordStrength(password);
  await bootstrap();
  const existing = await User.countDocuments({ roles: 'superadmin' });
  if (existing > 0 && process.env.ALLOW_ADDITIONAL !== 'true') throw new Error('A superadmin already exists. Grant further superadmins through dual approval.');
  const u = await User.findOneAndUpdate(
    { email },
    { $setOnInsert: { email, passwordHash: await auth.hashPassword(password), emailVerifiedAt: new Date(), firstName: process.env.SUPERADMIN_FIRST_NAME || 'Platform', lastName: process.env.SUPERADMIN_LAST_NAME || 'Owner', security: { passwordChangedAt: new Date() } }, $addToSet: { roles: 'superadmin' } },
    { upsert: true, new: true }
  );
  await ledger.ensureUserAccounts(u._id);
  await audit.record({ actorType: 'system', action: 'superadmin.bootstrapped', category: 'security', targetType: 'user', targetId: u._id });
  console.log(`Superadmin ready: ${email}. Sign in and complete two-factor setup.`);
}

main().then(() => db.disconnect()).then(() => process.exit(0)).catch(async (err) => {
  console.error(err.message);
  await db.disconnect().catch(() => {});
  process.exit(1);
});
