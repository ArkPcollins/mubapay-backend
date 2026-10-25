'use strict';
/**
 * Idempotent DEVELOPMENT seeder. Refuses to run in production.
 * Creates demo users (all roles), savings plans, catalogue products, a
 * pending used listing and published properties.
 * It deliberately creates NO wallet balances and NO financial transactions —
 * fund test wallets through Paystack test mode.
 */
const { authenticator } = require('otplib');
const config = require('../src/config');
const db = require('../src/lib/db');
const { bootstrap } = require('../src/bootstrap');
const { User } = require('../src/modules/users/user.model');
const auth = require('../src/modules/auth/auth.service');
const ledger = require('../src/modules/ledger/ledger.service');
const { encryptString } = require('../src/lib/crypto');
const { ADMIN_PRESETS } = require('../src/modules/rbac/permissions');
const { Category, Product } = require('../src/modules/marketplace/marketplace.models');
const { SavingsPlan } = require('../src/modules/savings/savings.models');
const { Property } = require('../src/modules/realestate/realestate.models');
const { ConsentRecord, LegalDocument } = require('../src/modules/legal/legal.models');

const PASSWORD = process.env.SEED_PASSWORD || 'MubaPay-Dev-2026!';

async function upsertUser(email, data, { staffSecret } = {}) {
  let u = await User.findOne({ email });
  if (!u) {
    u = await User.create({ email, passwordHash: await auth.hashPassword(PASSWORD), emailVerifiedAt: new Date(), security: { passwordChangedAt: new Date() }, isSeedData: true, ...data });
    await ledger.ensureUserAccounts(u._id);
    const docs = await LegalDocument.find({ status: 'published' }).lean();
    await ConsentRecord.insertMany(docs.map((d) => ({ userId: u._id, kind: 'policy_acceptance', documentSlug: d.slug, documentVersion: d.version, context: 'seed' })));
  }
  if (staffSecret) await User.updateOne({ _id: u._id }, { $set: { 'twoFactor.enabled': true, 'twoFactor.secretEnc': encryptString(staffSecret), 'twoFactor.enabledAt': new Date() } });
  return u;
}

async function main() {
  if (config.isProduction || config.APP_ENV === 'production') throw new Error('Refusing to seed: APP_ENV=production');
  await bootstrap();
  const secrets = {};
  const staff = async (key, email, roles, perms) => {
    secrets[email] = process.env[`SEED_TOTP_${key}`] || authenticator.generateSecret(20);
    return upsertUser(email, { firstName: key[0] + key.slice(1).toLowerCase(), lastName: 'Staff', roles, staffPermissions: perms, phone: undefined }, { staffSecret: secrets[email] });
  };
  await staff('SUPER', 'superadmin@mubapay.test', ['superadmin'], []);
  await staff('SUPER2', 'superadmin2@mubapay.test', ['superadmin'], []);
  await staff('FINANCE', 'finance@mubapay.test', ['admin'], ADMIN_PRESETS.finance_officer);
  await staff('CONTROLLER', 'controller@mubapay.test', ['admin'], ADMIN_PRESETS.finance_controller);
  await staff('SUPPORT', 'support@mubapay.test', ['admin'], ADMIN_PRESETS.support_agent);
  await staff('KYC', 'kyc@mubapay.test', ['admin'], ADMIN_PRESETS.verification_officer);
  await staff('MODERATOR', 'moderator@mubapay.test', ['admin'], [...ADMIN_PRESETS.moderator, ...ADMIN_PRESETS.catalogue_manager]);
  await staff('OPS', 'ops@mubapay.test', ['admin'], ADMIN_PRESETS.operations_lead);

  const base = { phoneVerifiedAt: new Date(), kycStatus: 'approved', verificationTier: 2 };
  const ada = await upsertUser('ada@mubapay.test', { firstName: 'Ada', lastName: 'Okafor', phone: '+2348030000001', ...base, roles: ['customer'], capabilities: { usedSeller: true }, addresses: [{ label: 'Home', recipientName: 'Ada Okafor', phone: '08030000001', line1: '12 Zik Avenue', city: 'Awka', state: 'Anambra', isDefault: true }] });
  await upsertUser('chidi@mubapay.test', { firstName: 'Chidi', lastName: 'Eze', phone: '+2348030000002', phoneVerifiedAt: new Date(), verificationTier: 1, roles: ['customer'], addresses: [{ label: 'Home', line1: '5 Ogui Road', city: 'Enugu', state: 'Enugu', isDefault: true }] });
  const landlord = await upsertUser('landlord@mubapay.test', { firstName: 'Ngozi', lastName: 'Nwosu', phone: '+2348030000003', ...base, roles: ['customer', 'landlord'], capabilities: { landlord: true } });
  const agent = await upsertUser('agent@mubapay.test', { firstName: 'Emeka', lastName: 'Obi', phone: '+2348030000004', ...base, roles: ['customer', 'agent'], capabilities: { agent: true } });
  await upsertUser('newuser@mubapay.test', { firstName: 'Tobi', lastName: 'New', roles: ['customer'] });

  // savings plans (dev only)
  for (const p of [
    { name: 'Flexible Saver', description: 'Save any amount, any time. Locked until your chosen date.', contributionMode: 'flexible', minDurationDays: 30, maxDurationDays: 365, minContributionKobo: 10000, earlyExit: { type: 'percent', bp: 250 } },
    { name: 'Scheduled Saver', description: 'Automatic weekly or monthly saving from your wallet or card.', contributionMode: 'scheduled', minDurationDays: 90, maxDurationDays: 730, allowedFrequencies: ['weekly', 'monthly'], minContributionKobo: 50000, earlyExit: { type: 'fixed', fixedKobo: 100000 } },
  ]) await SavingsPlan.updateOne({ name: p.name }, { $setOnInsert: p }, { upsert: true });

  const cat = async (slug) => (await Category.findOne({ slug }))._id;
  const products = [
    { title: 'Tecno Spark 20 (128GB)', brand: 'Tecno', slug: 'tecno-spark-20-128gb-seed', priceKobo: 14500000, stock: 25, categoryId: await cat('phones-tablets'), weightKg: 0.4 },
    { title: 'Binatone Blender 1.5L', brand: 'Binatone', slug: 'binatone-blender-seed', priceKobo: 3200000, stock: 40, categoryId: await cat('home-kitchen'), weightKg: 2.5 },
    { title: 'Oraimo FreePods 4', brand: 'Oraimo', slug: 'oraimo-freepods-4-seed', priceKobo: 2650000, stock: 60, categoryId: await cat('electronics'), weightKg: 0.2 },
    { title: 'Office Chair — Mesh Back', brand: 'Generic', slug: 'office-chair-mesh-seed', priceKobo: 6800000, stock: 10, categoryId: await cat('furniture'), weightKg: 12 },
  ];
  for (const p of products) {
    await Product.updateOne({ slug: p.slug }, { $setOnInsert: { ...p, kind: 'new', condition: 'new', description: `${p.title}. Brand new, sealed, with manufacturer warranty where applicable. (Development seed data.)`, status: 'published', publishedAt: new Date(), fulfilment: { delivery: true, collection: true, collectionPointId: 'awka-hub', originState: 'Anambra', originCity: 'Awka' }, isSeedData: true } }, { upsert: true });
  }
  await Product.updateOne({ slug: 'used-hp-elitebook-seed' }, { $setOnInsert: { kind: 'used', sellerId: ada._id, title: 'HP EliteBook 840 G5 (used)', slug: 'used-hp-elitebook-seed', brand: 'HP', description: 'Core i5 8th gen, 8GB RAM, 256GB SSD. Lightly used for two years. Charger included. (Development seed data.)', categoryId: await cat('computers'), condition: 'good', conditionNotes: 'Minor scratches on lid; battery holds about 3 hours.', priceKobo: 18500000, stock: 1, status: 'pending_review', fulfilment: { delivery: true, collection: false, originState: 'Anambra', originCity: 'Awka' }, moderationHistory: [{ at: new Date(), by: ada._id, action: 'submitted' }], isSeedData: true } }, { upsert: true });

  const properties = [
    { title: '2-bedroom flat in Independence Layout', slug: 'two-bed-independence-layout-seed', listingType: 'rent', propertyType: 'apartment', priceKobo: 120000000, rentPeriod: 'yearly', location: { area: 'Independence Layout', city: 'Enugu', state: 'Enugu', addressPrivate: '[seed] 14 Example Street', geo: { type: 'Point', coordinates: [7.5139, 6.4584] } }, bedrooms: 2, bathrooms: 2, amenities: ['water', 'prepaid meter', 'parking', 'security'], furnishing: 'unfurnished', viewingFee: { required: true, amountKobo: 500000 }, managers: [{ userId: agent._id, role: 'agent', authorizedBy: agent._id, authorizedAt: new Date() }], submittedBy: agent._id, listingAuthority: { basis: 'agent_mandate', verifiedAt: new Date() } },
    { title: 'Self-contain near UNIZIK', slug: 'self-contain-unizik-seed', listingType: 'rent', propertyType: 'self_contain', priceKobo: 25000000, rentPeriod: 'yearly', location: { area: 'Ifite', city: 'Awka', state: 'Anambra', addressPrivate: '[seed] 3 Example Close', geo: { type: 'Point', coordinates: [7.0498, 6.2449] } }, bedrooms: 1, bathrooms: 1, amenities: ['water', 'fenced'], furnishing: 'unfurnished', viewingFee: { required: false, amountKobo: 0 }, managers: [{ userId: landlord._id, role: 'owner', authorizedBy: landlord._id, authorizedAt: new Date() }], submittedBy: landlord._id, listingAuthority: { basis: 'owner', verifiedAt: new Date() } },
    { title: '600sqm plot in New Owerri', slug: 'plot-new-owerri-seed', listingType: 'land', propertyType: 'land', priceKobo: 1500000000, location: { area: 'New Owerri', city: 'Owerri', state: 'Imo', geo: { type: 'Point', coordinates: [7.0352, 5.4836] } }, landSizeSqm: 600, amenities: ['C of O (to be verified independently)'], viewingFee: { required: false, amountKobo: 0 }, managers: [{ userId: landlord._id, role: 'owner', authorizedBy: landlord._id, authorizedAt: new Date() }], submittedBy: landlord._id, listingAuthority: { basis: 'owner', verifiedAt: new Date() } },
  ];
  for (const p of properties) {
    await Property.updateOne({ slug: p.slug }, { $setOnInsert: { ...p, description: `${p.title}. Development seed listing — details are illustrative only.`, status: 'published', publishedAt: new Date(), mediaTypes: [], isSeedData: true } }, { upsert: true });
  }

  console.log('\nSeed complete (development only). Password for all seed users:', PASSWORD);
  console.log('Staff TOTP secrets (add to an authenticator app; development only):');
  for (const [e, s] of Object.entries(secrets)) console.log(`  ${e.padEnd(28)} ${s}`);
  console.log('Customers: ada@ (tier 2, seller), chidi@ (tier 1), landlord@, agent@, newuser@ (tier 0)');
}

if (require.main === module) {
  main().then(() => db.disconnect()).then(() => process.exit(0)).catch(async (err) => {
    console.error('Seed failed:', err.message);
    await db.disconnect().catch(() => {});
    process.exit(1);
  });
}
module.exports = { main };
