'use strict';
/**
 * Workflow 4 (marketplace) and Workflow 6 (delivery):
 * listing → moderation → discovery → quote → checkout → fulfilment → delivery
 * (Shipbubble + configured-rate + manual fallback) → refund/dispute → settlement.
 */
const H = require('../helpers/harness');
const config = require('../../src/config');
const ledger = require('../../src/modules/ledger/ledger.service');
const { Product, Order, DeliveryRequest, DeliveryEvent, SellerSettlement, Category, Checkout } = require('../../src/modules/marketplace/marketplace.models');
const { ProviderEvent } = require('../../src/modules/payments/payment.models');
const { Notification } = require('../../src/modules/notifications/notification.model');
const orders = require('../../src/modules/marketplace/orders.service');
const payments = require('../../src/modules/payments/payments.service');
const webhooks = require('../../src/modules/webhooks/webhooks.service');
const deliveries = require('../../src/modules/deliveries/deliveries.service');

let P;
let moderator;
let catalogue;
let finance;
let category;
beforeAll(async () => {
  process.env.SHIPBUBBLE_API_KEY = 'sb_sandbox_test_key';
  process.env.SHIPBUBBLE_SENDER_ADDRESS_CODE = '1234567';
  process.env.SHIPBUBBLE_DEFAULT_CATEGORY_ID = '90097994';
  config.__reload();
  await H.start();
  P = H.fakeProviders();
  moderator = await H.staffUser('moderator');
  catalogue = await H.staffUser('catalogue_manager');
  finance = await H.staffUser([...require('../../src/modules/rbac/permissions').ADMIN_PRESETS.finance_officer, 'disputes.manage']);
  category = await Category.findOne({ slug: 'electronics' });
});
afterAll(async () => {
  P.uninstall();
  delete process.env.SHIPBUBBLE_API_KEY;
  config.__reload();
  await H.stop();
});

async function newProduct(stock = 5, extra = {}) {
  const r = await H.as(catalogue).post('/api/v1/admin/products').send({ title: `Speaker ${Date.now()}`, description: 'Bluetooth speaker, brand new in box.', brand: 'Oraimo', categoryId: String(category._id), priceKobo: 1000000, stock, publish: true, fulfilment: { delivery: true, collection: true, collectionPointId: 'awka-hub', originState: 'Anambra' }, ...extra });
  expect(r.status).toBe(201);
  return r.body.data;
}

const quote = async (buyer) => (await H.as(buyer).post('/api/v1/marketplace/checkout/delivery-quote').send({ addressId: String(buyer.user.addresses[0]._id) })).body.data;

describe('used-item listings and moderation', () => {
  test('verified seller submits; moderation is required; only moderators decide; reports auto-hide only at threshold', async () => {
    const seller = await H.createUser();
    const unverified = await H.createUser({ tier: 1 });
    const body = { title: 'Used iPhone 11 64GB', description: 'Works perfectly, minor scratches on the frame, battery 84%.', categoryId: String(category._id), condition: 'good', conditionNotes: 'Minor frame scratches; screen perfect.', priceKobo: 18000000, fulfilment: { delivery: true, originState: 'Anambra' } };
    expect((await H.as(unverified).post('/api/v1/marketplace/seller/listings').send(body)).status).toBe(403);
    const badCat = await H.as(seller).post('/api/v1/marketplace/seller/listings').send({ ...body, categoryId: String((await Category.findOne({ slug: 'weapons' }))._id) });
    expect(badCat.status).toBe(422);
    const created = await H.as(seller).post('/api/v1/marketplace/seller/listings').send(body);
    expect(created.status).toBe(201);
    expect(created.body.data.status).toBe('pending_review');
    const id = created.body.data._id;
    expect((await H.api().get(`/api/v1/marketplace/products/${created.body.data.slug}`)).status).toBe(404); // not public yet
    expect((await H.as(seller).post(`/api/v1/admin/moderation/products/${id}`).send({ decision: 'approve' })).status).toBe(403);
    const rej = await H.as(moderator).post(`/api/v1/admin/moderation/products/${id}`).send({ decision: 'reject', reason: 'Add photos of the scratches' });
    expect(rej.body.data.status).toBe('rejected');
    const re = await H.as(seller).patch(`/api/v1/marketplace/seller/listings/${id}`).send({ conditionNotes: 'Two small scratches on left frame, photos added.' });
    expect(re.body.data.status).toBe('pending_review');
    const ap = await H.as(moderator).post(`/api/v1/admin/moderation/products/${id}`).send({ decision: 'approve' });
    expect(ap.body.data.status).toBe('published');
    // one report does not hide; threshold of serious reports does
    const r1 = await H.createUser();
    await H.as(r1).post(`/api/v1/marketplace/products/${id}/report`).send({ category: 'misleading' });
    expect((await Product.findById(id)).status).toBe('published');
    await H.as(await H.createUser()).post(`/api/v1/marketplace/products/${id}/report`).send({ category: 'stolen_goods' });
    await H.as(await H.createUser()).post(`/api/v1/marketplace/products/${id}/report`).send({ category: 'stolen_goods' });
    expect((await Product.findById(id)).status).toBe('hidden');
    expect((await H.as(r1).post(`/api/v1/marketplace/products/${id}/report`).send({ category: 'other' })).status).toBe(404);
  });

  test('discovery: search, filters, sponsored labelled separately', async () => {
    const p = await newProduct(3, { title: 'Discoverable Radio', promotedUntil: new Date(Date.now() + 864e5).toISOString() });
    const s = await H.api().get('/api/v1/marketplace/products?q=Discoverable&maxPrice=2000000&condition=new');
    expect(s.body.data.items.some((i) => i.slug === p.slug)).toBe(true);
    expect(s.body.data.sponsored.every((i) => i.sponsored === true)).toBe(true);
    const lagos = await H.api().get('/api/v1/marketplace/products?state=Lagos');
    expect(lagos.body.data.notice).toMatch(/not yet available/);
  });
});

describe('checkout', () => {
  test('stock of 1 bought concurrently by two buyers → exactly one order', async () => {
    const p = await newProduct(1);
    const [b1, b2] = await Promise.all([H.createUser(), H.createUser()]);
    for (const b of [b1, b2]) {
      await H.fundWallet(b, P.paystack, 2000000);
      await H.as(b).put('/api/v1/marketplace/cart').send({ productId: p._id, quantity: 1 });
    }
    const res = await Promise.all([b1, b2].map((b) => H.as(b).post('/api/v1/marketplace/checkout').set('Idempotency-Key', H.idem()).send({ fulfilmentMethod: 'collection', collectionPointId: 'awka-hub', paymentMethod: 'wallet' })));
    expect(res.filter((r) => r.status === 201).length).toBe(1);
    expect(res.filter((r) => r.body?.error?.code === 'INSUFFICIENT_STOCK').length).toBe(1);
    expect((await Product.findById(p._id)).stock).toBe(0);
    const total = (await H.walletBalance(b1.user._id)) + (await H.walletBalance(b2.user._id));
    expect(total).toBe(4000000 - 1000000); // only one was charged
  });

  test('wallet checkout with collection: one-time code, staff-assisted fallback, settlement to platform revenue', async () => {
    const p = await newProduct(2);
    const buyer = await H.createUser();
    await H.fundWallet(buyer, P.paystack, 1500000);
    await H.as(buyer).put('/api/v1/marketplace/cart').send({ productId: p._id, quantity: 1 });
    const key = H.idem();
    const c = await H.as(buyer).post('/api/v1/marketplace/checkout').set('Idempotency-Key', key).send({ fulfilmentMethod: 'collection', collectionPointId: 'awka-hub', paymentMethod: 'wallet' });
    expect(c.status).toBe(201);
    expect(c.body.data.status).toBe('paid');
    const dup = await H.as(buyer).post('/api/v1/marketplace/checkout').set('Idempotency-Key', key).send({ fulfilmentMethod: 'collection', collectionPointId: 'awka-hub', paymentMethod: 'wallet' });
    expect(dup.body.data.id).toBe(c.body.data.id); // no duplicate order
    expect(await H.walletBalance(buyer.user._id)).toBe(500000);
    const orderId = c.body.data.orders[0].id;
    expect((await H.as(buyer).post(`/api/v1/marketplace/orders/${orderId}/fulfilment`).send({ action: 'ready' })).status).toBe(403);
    await H.as(catalogue).post(`/api/v1/marketplace/orders/${orderId}/fulfilment`).send({ action: 'ready' });
    const n = await Notification.findOne({ userId: buyer.user._id, type: 'ready_for_collection' }).lean();
    const code = n.data.collectionCode;
    const wrong = await H.as(catalogue).post(`/api/v1/marketplace/orders/${orderId}/collection/confirm`).send({ code: code === '000000' ? '111111' : '000000' });
    expect(wrong.status).toBe(400);
    const ok = await H.as(catalogue).post(`/api/v1/marketplace/orders/${orderId}/collection/confirm`).send({ code });
    expect(ok.body.data.status).toBe('settlement_pending');
    const reuse = await H.as(catalogue).post(`/api/v1/marketplace/orders/${orderId}/collection/confirm`).send({ code });
    expect(reuse.status).toBe(409);
    const o = await Order.findById(orderId);
    expect(String(o.pickup.confirmedBy)).toBe(String(catalogue.user._id));
    await Order.updateOne({ _id: orderId }, { $set: { settlementEligibleAt: new Date(Date.now() - 1000) } });
    await orders.runSettlements();
    expect((await Order.findById(orderId)).status).toBe('settled');
    // platform-owned sale → direct-sales revenue (not seller payable)
    expect(await ledger.getBalance(ledger.SYS.REVENUE_SALES)).toBeGreaterThanOrEqual(1000000);
  });

  test('Paystack checkout: unpaid checkout times out only after verification shows no payment', async () => {
    const p = await newProduct(1);
    const buyer = await H.createUser();
    await H.as(buyer).put('/api/v1/marketplace/cart').send({ productId: p._id, quantity: 1 });
    const c = await H.as(buyer).post('/api/v1/marketplace/checkout').set('Idempotency-Key', H.idem()).send({ fulfilmentMethod: 'collection', collectionPointId: 'awka-hub', paymentMethod: 'paystack' });
    expect(c.body.data.status).toBe('payment_processing');
    expect(c.body.data.authorizationUrl).toMatch(/checkout.paystack.test/);
    await Checkout.updateOne({ _id: c.body.data.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
    P.paystack.failNext['/transaction/verify/'] = 'timeout';
    await orders.expireUnpaid();
    expect((await Checkout.findById(c.body.data.id)).status).toBe('payment_processing'); // timeout ≠ failure: stock still reserved
    P.paystack.pay(c.body.data.paymentReference, { status: 'abandoned', amount: 1000000 });
    await orders.expireUnpaid();
    expect((await Checkout.findById(c.body.data.id)).status).toBe('expired');
    expect((await Product.findById(p._id)).stock).toBe(1);
  });

  test('payment confirmed after checkout expired → money is credited to the wallet, never lost', async () => {
    const p = await newProduct(1);
    const buyer = await H.createUser();
    await H.as(buyer).put('/api/v1/marketplace/cart').send({ productId: p._id, quantity: 1 });
    const c = await H.as(buyer).post('/api/v1/marketplace/checkout').set('Idempotency-Key', H.idem()).send({ fulfilmentMethod: 'collection', collectionPointId: 'awka-hub', paymentMethod: 'paystack' });
    await orders.expireCheckout(c.body.data.id, 'test_expired');
    P.paystack.pay(c.body.data.paymentReference, { amount: 1000000 });
    const a = await payments.verifyAndFulfil(c.body.data.paymentReference);
    expect(a.fulfilledAt).toBeTruthy();
    expect(a.fulfillmentError).toMatch(/credited to wallet/);
    expect(await H.walletBalance(buyer.user._id)).toBe(1000000);
  });
});

describe('delivery (Workflow 6) and used-item settlement', () => {
  test('quote → book with Shipbubble → signed webhooks (duplicate, out-of-order) → delivered → refund → settlement', async () => {
    const seller = await H.createUser({ firstName: 'Seller', lastName: 'One' });
    const listing = await H.as(seller).post('/api/v1/marketplace/seller/listings').send({ title: 'Used Blender', description: 'Works well, 2 years old, all parts included.', categoryId: String((await Category.findOne({ slug: 'home-kitchen' }))._id), condition: 'good', conditionNotes: 'Small crack on lid handle, works fine.', priceKobo: 2000000, fulfilment: { delivery: true, originState: 'Anambra' } });
    await H.as(moderator).post(`/api/v1/admin/moderation/products/${listing.body.data._id}`).send({ decision: 'approve' });
    const buyer = await H.createUser({ state: 'Enugu' });
    await H.fundWallet(buyer, P.paystack, 3000000);
    await H.as(buyer).put('/api/v1/marketplace/cart').send({ productId: listing.body.data._id, quantity: 1 });
    // coverage check before payment
    const q = await quote(buyer);
    const group = q.groups[0];
    expect(group.deliveryAvailable).toBe(true);
    expect(group.selected.provider).toBe('shipbubble'); // cheapest: Shipbubble GIG ₦2,850.50 vs configured ₦3,500
    expect(group.selected.feeKobo).toBe(285050);
    expect(group.alternatives.some((a) => a.provider === 'configured_rate')).toBe(true);
    const c = await H.as(buyer).post('/api/v1/marketplace/checkout').set('Idempotency-Key', H.idem()).send({ fulfilmentMethod: 'delivery', addressId: String(buyer.user.addresses[0]._id), deliveryQuotes: { [group.groupKey]: { quoteId: group.quoteId } }, paymentMethod: 'wallet' });
    expect(c.status).toBe(201);
    expect(c.body.data.totalKobo).toBe(2285050); // buyer pays the confirmed delivery fee
    const orderId = c.body.data.orders[0].id;
    // seller marks ready → booking
    await H.as(seller).post(`/api/v1/marketplace/orders/${orderId}/fulfilment`).send({ action: 'ready' });
    const order = await Order.findById(orderId);
    await deliveries.book(order.deliveryRequestId);
    let dr = await DeliveryRequest.findById(order.deliveryRequestId);
    expect(dr.status).toBe('booked');
    expect(dr.shipmentRef).toMatch(/^SB-/);
    // signed webhook: in transit (sent twice) then delivered, then a late "picked_up" after delivery
    const send = async (payload) => {
      const body = JSON.stringify(payload);
      return H.api().post('/api/v1/webhooks/shipbubble').set('content-type', 'application/json').set('x-ship-signature', P.shipbubble.signature(body)).send(body);
    };
    const bad = await H.api().post('/api/v1/webhooks/shipbubble').set('content-type', 'application/json').set('x-ship-signature', 'nope').send(JSON.stringify({ event: 'shipment.status.changed', order_id: dr.shipmentRef, status: 'completed' }));
    expect(bad.status).toBe(401);
    const transit = { event: 'shipment.status.changed', order_id: dr.shipmentRef, status: 'picked_up', date: '2026-10-20T10:00:00Z' };
    expect((await send(transit)).body.duplicate).toBe(false);
    expect((await send(transit)).body.duplicate).toBe(true);
    await send({ event: 'shipment.status.changed', order_id: dr.shipmentRef, status: 'completed', date: '2026-10-20T15:00:00Z' });
    await send({ event: 'shipment.status.changed', order_id: dr.shipmentRef, status: 'picked_up', date: '2026-10-20T09:00:00Z' }); // late, out of order
    await webhooks.sweep(0);
    for (const ev of await ProviderEvent.find({ provider: 'shipbubble', status: { $ne: 'processed' } })) await webhooks.processEvent(ev._id);
    dr = await DeliveryRequest.findById(order.deliveryRequestId);
    expect(dr.status).toBe('delivered');
    expect((await Order.findById(orderId)).status).toBe('settlement_pending');
    expect(await DeliveryEvent.countDocuments({ deliveryRequestId: dr._id, status: /^ignored/ })).toBeGreaterThanOrEqual(1);
    // partial refund within the window
    const rf = await H.as(buyer).post('/api/v1/marketplace/refunds').send({ subjectType: 'order', subjectId: orderId, amountKobo: 500000, reason: 'not_as_described', description: 'Crack is bigger than described' });
    expect(rf.status).toBe(201);
    const over = await H.as(buyer).post('/api/v1/marketplace/refunds').send({ subjectType: 'order', subjectId: orderId, amountKobo: 2000000, reason: 'other' });
    expect(over.body.error.code).toBe('REFUND_EXCEEDS_REMAINING');
    expect((await H.as(seller).post(`/api/v1/admin/refunds/${rf.body.data._id}/decision`).send({ decision: 'approve', note: 'mine' })).status).toBe(403);
    const dec = await H.as(finance).post(`/api/v1/admin/refunds/${rf.body.data._id}/decision`).send({ decision: 'approve', note: 'Photos confirm the crack' });
    expect(dec.status).toBe(200);
    expect(await H.walletBalance(buyer.user._id)).toBe(3000000 - 2285050 + 500000);
    expect((await Order.findById(orderId)).status).toBe('partially_refunded');
    // settlement after hold: seller net = (20,000 - 5,000) * 95% ; commission 5% ; delivery payable
    await Order.updateOne({ _id: orderId }, { $set: { settlementEligibleAt: new Date(Date.now() - 1000) } });
    await orders.runSettlements();
    const st = await SellerSettlement.findOne({ orderId });
    expect(st.netKobo).toBe(1425000);
    expect(st.commissionKobo).toBe(75000);
    expect(st.status).toBe('released');
    expect(await H.walletBalance(seller.user._id)).toBe(1425000);
    expect((await ledger.checkInvariants()).ok).toBe(true);
  });

  test('configured-rate delivery: manual fallback, failed delivery escalation and redelivery', async () => {
    const p = await newProduct(2);
    const buyer = await H.createUser({ state: 'Imo' });
    await H.fundWallet(buyer, P.paystack, 2000000);
    await H.as(buyer).put('/api/v1/marketplace/cart').send({ productId: p._id, quantity: 1 });
    P.shipbubble.failNext['/fetch_rates'] = 503; // provider outage → configured rule still available
    const q = await quote(buyer);
    expect(q.groups[0].selected.provider).toBe('configured_rate');
    expect(q.groups[0].selected.feeKobo).toBe(350000);
    const c = await H.as(buyer).post('/api/v1/marketplace/checkout').set('Idempotency-Key', H.idem()).send({ fulfilmentMethod: 'delivery', addressId: String(buyer.user.addresses[0]._id), deliveryQuotes: { [q.groups[0].groupKey]: { quoteId: q.groups[0].quoteId } }, paymentMethod: 'wallet' });
    const orderId = c.body.data.orders[0].id;
    await H.as(catalogue).post(`/api/v1/marketplace/orders/${orderId}/fulfilment`).send({ action: 'ready' });
    const o = await Order.findById(orderId);
    await deliveries.book(o.deliveryRequestId);
    const id = String(o.deliveryRequestId);
    expect((await H.as(catalogue).post(`/api/v1/admin/deliveries/${id}/status`).send({ status: 'in_transit', note: 'Rider Musa departed' })).status).toBe(200);
    await H.as(catalogue).post(`/api/v1/admin/deliveries/${id}/status`).send({ status: 'failed', note: 'Customer unreachable' });
    const redo = await H.as(catalogue).post(`/api/v1/admin/deliveries/${id}/status`).send({ status: 'redelivery_scheduled', note: 'Customer called back' });
    expect(redo.body.data.redeliveryCount).toBe(1);
    const noEvidence = await H.as(catalogue).post(`/api/v1/admin/deliveries/${id}/status`).send({ status: 'delivered' });
    expect(noEvidence.status).toBe(422);
    await H.as(catalogue).post(`/api/v1/admin/deliveries/${id}/status`).send({ status: 'in_transit', note: 'Second attempt' });
    const done = await H.as(catalogue).post(`/api/v1/admin/deliveries/${id}/status`).send({ status: 'delivered', note: 'Signed by customer', evidenceRef: 'POD-2026-001' });
    expect(done.status).toBe(200);
    expect((await Order.findById(orderId)).status).toBe('settlement_pending');
    const timeline = await H.as(catalogue).get(`/api/v1/admin/deliveries/${id}/timeline`);
    expect(timeline.body.data.length).toBeGreaterThanOrEqual(5);
  });

  test('disputes pause settlement; resolution with refund for customer', async () => {
    const seller = await H.createUser();
    const listing = await H.as(seller).post('/api/v1/marketplace/seller/listings').send({ title: 'Used Keyboard', description: 'Mechanical keyboard, all keys work, lightly used.', categoryId: String(category._id), condition: 'like_new', conditionNotes: 'Like new, comes with box.', priceKobo: 1500000, fulfilment: { delivery: false, collection: true, collectionPointId: 'awka-hub', originState: 'Anambra' } });
    await H.as(moderator).post(`/api/v1/admin/moderation/products/${listing.body.data._id}`).send({ decision: 'approve' });
    const buyer = await H.createUser();
    await H.fundWallet(buyer, P.paystack, 1500000);
    await H.as(buyer).put('/api/v1/marketplace/cart').send({ productId: listing.body.data._id, quantity: 1 });
    const c = await H.as(buyer).post('/api/v1/marketplace/checkout').set('Idempotency-Key', H.idem()).send({ fulfilmentMethod: 'collection', collectionPointId: 'awka-hub', paymentMethod: 'wallet' });
    const orderId = c.body.data.orders[0].id;
    const d = await H.as(buyer).post('/api/v1/marketplace/disputes').send({ subjectType: 'order', subjectId: orderId, reason: 'Seller unresponsive', description: 'Seller has not prepared the item after a week.' });
    expect(d.status).toBe(201);
    expect((await Order.findById(orderId)).status).toBe('disputed');
    await H.as(seller).post(`/api/v1/marketplace/disputes/${d.body.data._id}/statements`).send({ text: 'I was travelling, sorry.' });
    const outsider = await H.createUser();
    expect((await H.as(outsider).get(`/api/v1/marketplace/disputes/${d.body.data._id}`)).status).toBe(404);
    const res = await H.as(finance).post(`/api/v1/admin/disputes/${d.body.data._id}/resolve`).send({ outcome: 'resolved_for_customer', note: 'Seller failed to fulfil within policy window', refundKobo: 1500000 });
    expect(res.body.data.status).toBe('resolved_for_customer');
    expect((await Order.findById(orderId)).status).toBe('refunded');
    expect(await H.walletBalance(buyer.user._id)).toBe(1500000);
    expect(await SellerSettlement.exists({ orderId })).toBeNull();
    expect((await ledger.checkInvariants()).ok).toBe(true);
  });

  test('invalid state transitions are rejected', async () => {
    const p = await newProduct(1);
    const buyer = await H.createUser();
    await H.fundWallet(buyer, P.paystack, 1000000);
    await H.as(buyer).put('/api/v1/marketplace/cart').send({ productId: p._id, quantity: 1 });
    const c = await H.as(buyer).post('/api/v1/marketplace/checkout').set('Idempotency-Key', H.idem()).send({ fulfilmentMethod: 'collection', collectionPointId: 'awka-hub', paymentMethod: 'wallet' });
    const orderId = c.body.data.orders[0].id;
    const r = await H.as(catalogue).post(`/api/v1/marketplace/orders/${orderId}/collection/confirm`).send({ code: '123456' });
    expect(r.status).toBe(409); // not ready for collection yet
    await H.as(buyer).post(`/api/v1/marketplace/orders/${orderId}/cancel`).send({ reason: 'changed my mind' });
    expect((await H.as(catalogue).post(`/api/v1/marketplace/orders/${orderId}/fulfilment`).send({ action: 'ready' })).body.error.code).toBe('INVALID_STATE_TRANSITION');
    expect(await H.walletBalance(buyer.user._id)).toBe(1000000);
  });
});
