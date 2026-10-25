'use strict';
const money = require('../../src/lib/money');
const cron = require('../../src/lib/cron');
const { defineMachine } = require('../../src/lib/stateMachine');
const savings = require('../../src/modules/savings/savings.service');
const orders = require('../../src/modules/marketplace/orders.service');
const ledger = require('../../src/modules/ledger/ledger.service');
const { maskContacts } = require('../../src/modules/messaging/messaging.service');
const shipbubble = require('../../src/providers/logistics/shipbubble.adapter');
const paystack = require('../../src/providers/paystack/paystack.adapter');
const storage = require('../../src/providers/storage/privateStorage');
const { hasPermission } = require('../../src/middleware/auth');
const { computeTier } = require('../../src/modules/users/users.service');
const config = require('../../src/config');
const crypto = require('crypto');

describe('money (integer kobo, no floats)', () => {
  test('naira parsing is exact', () => {
    expect(money.nairaToKobo('1,500')).toBe(150000);
    expect(money.nairaToKobo('₦25,000.50')).toBe(2500050);
    expect(money.nairaToKobo('0.1')).toBe(10);
    expect(() => money.nairaToKobo('1.234')).toThrow();
    expect(() => money.nairaToKobo('abc')).toThrow();
  });
  test('formatting', () => {
    expect(money.koboToNairaString(2500000)).toBe('₦25,000');
    expect(money.koboToNairaString(150050)).toBe('₦1,500.50');
    expect(money.koboToNairaString(-100)).toBe('-₦1');
  });
  test('percentages use basis points with half-up rounding and no float drift', () => {
    expect(money.percentBp(10000, 250)).toBe(250); // 2.5% of ₦100
    expect(money.percentBp(333, 1000)).toBe(33); // 33.3 → 33
    expect(money.percentBp(335, 1000)).toBe(34); // 33.5 → 34 (half up)
    expect(money.percentBp(money.MAX_KOBO, 10000)).toBe(money.MAX_KOBO); // BigInt path, no overflow
    expect(() => money.percentBp(money.MAX_KOBO + 1, 1)).toThrow(); // safety ceiling
    // classic float trap 0.1 + 0.2 never appears: everything is integers
    expect(money.sum([10, 20])).toBe(30);
  });
  test('fee rules with min/max clamps', () => {
    expect(money.computeFee(100000, { type: 'none' })).toBe(0);
    expect(money.computeFee(100000, { type: 'fixed', fixedKobo: 5000 })).toBe(5000);
    expect(money.computeFee(100000, { type: 'percent', bp: 150, maxKobo: 1000 })).toBe(1000);
    expect(money.computeFee(1000, { type: 'percent', bp: 150, minKobo: 500 })).toBe(500);
    expect(money.computeFee(100000, { type: 'percent_plus_fixed', bp: 150, fixedKobo: 10000 })).toBe(11500);
  });
  test('rejects non-integer and negative amounts', () => {
    expect(() => money.assertKobo(1.5)).toThrow();
    expect(() => money.assertKobo(-1)).toThrow();
    expect(() => money.assertPositiveKobo(0)).toThrow();
  });
});

describe('ledger entry validation', () => {
  test('balanced entries pass, unbalanced fail', () => {
    expect(ledger.validateEntries([{ account: 'A', direction: 'debit', amount: 100 }, { account: 'B', direction: 'credit', amount: 100 }])).toBe(100);
    expect(() => ledger.validateEntries([{ account: 'A', direction: 'debit', amount: 100 }, { account: 'B', direction: 'credit', amount: 99 }])).toThrow(/Unbalanced/);
    expect(() => ledger.validateEntries([{ account: 'A', direction: 'debit', amount: 1.5 }, { account: 'B', direction: 'credit', amount: 1.5 }])).toThrow();
    expect(() => ledger.validateEntries([{ account: 'A', direction: 'debit', amount: 100 }])).toThrow();
  });
});

describe('cron (Africa/Lagos)', () => {
  test('daily 02:30 Lagos = 01:30 UTC', () => {
    const n = cron.next('30 2 * * *', new Date('2026-10-20T00:00:00Z'));
    expect(n.toISOString()).toBe('2026-10-20T01:30:00.000Z');
  });
  test('weekly Monday 07:00 and monthly first day', () => {
    expect(cron.next('0 7 * * 1', new Date('2026-10-20T12:00:00Z')).toISOString()).toBe('2026-10-26T06:00:00.000Z');
    expect(cron.next('0 8 1 * *', new Date('2026-10-20T12:00:00Z')).toISOString()).toBe('2026-11-01T07:00:00.000Z');
    expect(cron.next('0 */2 * * *', new Date('2026-10-20T10:30:00Z')).getUTCMinutes()).toBe(0);
  });
  test('invalid expressions throw', () => {
    expect(() => cron.parse('61 * * * *')).toThrow();
    expect(() => cron.parse('* * *')).toThrow();
  });
});

describe('state machines', () => {
  test('order transitions', () => {
    const m = orders.orderMachine;
    expect(m.canTransition('pending_payment', 'paid')).toBe(true);
    expect(m.canTransition('paid', 'settled')).toBe(false);
    expect(m.canTransition('settled', 'refunded')).toBe(false);
    expect(m.canTransition('settlement_pending', 'settled')).toBe(true);
    expect(m.canTransition('refunded', 'paid')).toBe(false);
    expect(() => m.assert('delivered', 'pending_payment')).toThrow(/cannot move/);
  });
  test('generic machine', () => {
    const m = defineMachine('X', { a: ['b'], b: [] });
    expect(m.canTransition('a', 'b')).toBe(true);
    expect(m.canTransition('b', 'a')).toBe(false);
  });
});

describe('savings rules', () => {
  test('early exit penalty never exceeds balance', () => {
    expect(savings.earlyExitPenalty(100000, { type: 'percent', bp: 250 })).toBe(2500);
    expect(savings.earlyExitPenalty(50000, { type: 'fixed', fixedKobo: 100000 })).toBe(50000);
    expect(savings.earlyExitPenalty(50000, { type: 'none' })).toBe(0);
    expect(savings.earlyExitPenalty(0, { type: 'percent', bp: 1000 })).toBe(0);
  });
  test('schedule periods (month-end safe)', () => {
    expect(savings.addPeriod(new Date('2026-01-31T09:00:00Z'), 'monthly').toISOString()).toBe('2026-02-28T09:00:00.000Z');
    expect(savings.addPeriod(new Date('2026-10-20T09:00:00Z'), 'weekly').toISOString()).toBe('2026-10-27T09:00:00.000Z');
    expect(savings.addPeriod(new Date('2026-10-20T09:00:00Z'), 'daily').toISOString()).toBe('2026-10-21T09:00:00.000Z');
  });
});

describe('settlement split', () => {
  test('commission and delivery are separated; partial refunds reduce items first', () => {
    const base = { sellerId: 'x', subtotalKobo: 100000, deliveryFeeKobo: 5000, totalKobo: 105000, terms: { commissionBp: 500 } };
    expect(orders.settlementSplit({ ...base, refundedKobo: 0 })).toEqual({ itemsRemaining: 100000, deliveryRemaining: 5000, commission: 5000, sellerNet: 95000, total: 105000 });
    const s = orders.settlementSplit({ ...base, refundedKobo: 20000 });
    expect(s.total).toBe(85000);
    expect(s.sellerNet + s.commission + s.deliveryRemaining).toBe(85000);
    const full = orders.settlementSplit({ ...base, refundedKobo: 102000 });
    expect(full).toMatchObject({ itemsRemaining: 0, deliveryRemaining: 3000, sellerNet: 0, total: 3000 });
    expect(orders.settlementSplit({ ...base, sellerId: null, refundedKobo: 0 }).commission).toBe(0);
  });
});

describe('verification tiers & permissions', () => {
  test('tier computation', () => {
    expect(computeTier({})).toBe(0);
    expect(computeTier({ emailVerifiedAt: new Date() })).toBe(0);
    expect(computeTier({ emailVerifiedAt: new Date(), phoneVerifiedAt: new Date() })).toBe(1);
    expect(computeTier({ emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), kycStatus: 'approved' })).toBe(2);
    expect(computeTier({ emailVerifiedAt: new Date(), phoneVerifiedAt: new Date(), kycStatus: 'approved', verificationTier: 3 })).toBe(3);
    expect(computeTier({ emailVerifiedAt: new Date(), kycStatus: 'approved' })).toBe(0);
  });
  test('permissions are explicit; view does not imply change', () => {
    const admin = { roles: ['admin'], staffPermissions: ['withdrawals.view'] };
    expect(hasPermission(admin, 'withdrawals.view')).toBe(true);
    expect(hasPermission(admin, 'withdrawals.approve')).toBe(false);
    expect(hasPermission({ roles: ['customer'], staffPermissions: ['withdrawals.approve'] }, 'withdrawals.approve')).toBe(false);
    expect(hasPermission({ roles: ['superadmin'], staffPermissions: [] }, 'staff.manage')).toBe(true);
    expect(hasPermission({ roles: ['superadmin'], staffPermissions: [] }, 'not.a.permission')).toBe(false);
  });
});

describe('contact masking in messages', () => {
  test('phones and emails are hidden', () => {
    const r = maskContacts('call me on 08031234567 or +234 803 123 4567 or ada@example.com');
    expect(r.masked).toBe(true);
    expect(r.text).not.toMatch(/0803|ada@/);
    expect(maskContacts('see you at 3pm').masked).toBe(false);
  });
});

describe('provider adapters', () => {
  test('shipbubble amount conversion and status mapping', () => {
    expect(shipbubble.nairaToKoboLoose(2500)).toBe(250000);
    expect(shipbubble.nairaToKoboLoose('2500.55')).toBe(250055);
    expect(shipbubble.nairaToKoboLoose('10.005')).toBe(1001);
    expect(() => shipbubble.nairaToKoboLoose('NaN')).toThrow();
    expect(shipbubble.mapStatus('picked_up')).toBe('in_transit');
    expect(shipbubble.mapStatus('completed')).toBe('delivered');
    expect(shipbubble.mapStatus('cancelled')).toBe('cancelled');
  });
  test('paystack webhook signature verification', () => {
    const body = Buffer.from(JSON.stringify({ event: 'charge.success', data: { reference: 'x' } }));
    const sig = crypto.createHmac('sha512', process.env.PAYSTACK_SECRET_KEY).update(body).digest('hex');
    expect(paystack.verifyWebhookSignature(body, sig)).toBe(true);
    expect(paystack.verifyWebhookSignature(body, `${sig.slice(0, -1)}0`)).toBe(false);
    expect(paystack.verifyWebhookSignature(Buffer.from('tampered'), sig)).toBe(false);
    expect(paystack.verifyWebhookSignature(body, undefined)).toBe(false);
  });
  test('private download tokens are short-lived and tamper-proof', () => {
    const t = storage.issueDownloadToken('doc1', 'user1');
    expect(storage.verifyDownloadToken(t)).toEqual({ documentId: 'doc1', userId: 'user1' });
    expect(storage.verifyDownloadToken(`${t}x`)).toBeNull();
    expect(storage.verifyDownloadToken('garbage')).toBeNull();
  });
  test('file type sniffing rejects disguised files', () => {
    expect(storage.sniff(Buffer.from('%PDF-1.4 ...'))).toBe('application/pdf');
    expect(storage.sniff(Buffer.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg');
    expect(storage.sniff(Buffer.from('<script>alert(1)</script>'))).toBeNull();
  });
});

describe('environment separation', () => {
  const load = config.__load;
  const baseEnv = { MONGODB_URI: 'mongodb://x/y?replicaSet=rs0' };
  test('live Paystack key rejected outside production', () => {
    expect(() => load({ ...baseEnv, APP_ENV: 'development', PAYSTACK_SECRET_KEY: 'sk_live_abc' })).toThrow(/Live Paystack key/);
    expect(() => load({ ...baseEnv, APP_ENV: 'staging', PAYSTACK_SECRET_KEY: 'sk_live_abc' })).toThrow();
  });
  test('test key rejected in production and weak secrets refused', () => {
    expect(() => load({ ...baseEnv, APP_ENV: 'production', PAYSTACK_MODE: 'live', PAYSTACK_SECRET_KEY: 'sk_test_abc' })).toThrow();
    expect(() => load({ ...baseEnv, APP_ENV: 'production' })).toThrow(/JWT_ACCESS_SECRET|DATA_ENCRYPTION_KEY|COOKIE_SECURE/);
    expect(() => load({ ...baseEnv, APP_ENV: 'production', EMAIL_TRANSPORT: 'console' })).toThrow();
  });
  test('valid production config loads', () => {
    const c = load({ ...baseEnv, APP_ENV: 'production', PAYSTACK_MODE: 'live', PAYSTACK_SECRET_KEY: 'sk_live_abc', JWT_ACCESS_SECRET: 'x'.repeat(48), DATA_ENCRYPTION_KEY: crypto.randomBytes(32).toString('base64'), COOKIE_SECURE: 'true' });
    expect(c.isProduction).toBe(true);
    expect(c.integrations.paystack).toBe(true);
  });
});
