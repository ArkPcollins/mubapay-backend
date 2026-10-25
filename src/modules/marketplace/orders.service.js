'use strict';
const { Cart, Product, Order, Checkout, RefundRequest, Dispute, SellerSettlement, DeliveryRequest } = require('./marketplace.models');
const { User } = require('../users/user.model');
const ledger = require('../ledger/ledger.service');
const payments = require('../payments/payments.service');
const { PaymentAttempt } = require('../payments/payment.models');
const deliveries = require('../deliveries/deliveries.service');
const settings = require('../settings/settings.service');
const notifications = require('../notifications/notifications.service');
const audit = require('../audit/audit.service');
const consent = require('../legal/consent.service');
const { withTransaction, afterCommit } = require('../../lib/db');
const { defineMachine } = require('../../lib/stateMachine');
const { E } = require('../../lib/errors');
const { percentBp, koboToNairaString } = require('../../lib/money');
const { sha256, randomDigits, randomToken, safeEqual } = require('../../lib/crypto');
const { hasPermission } = require('../../middleware/auth');
const logger = require('../../lib/logger');
const infra = require('../../infra');

const orderMachine = defineMachine('Order', {
  pending_payment: ['payment_processing', 'paid', 'cancelled'],
  payment_processing: ['paid', 'cancelled', 'pending_payment'],
  paid: ['processing', 'ready_for_dispatch', 'ready_for_collection', 'cancelled', 'refund_requested', 'disputed', 'refunded', 'partially_refunded', 'dispatched'],
  processing: ['ready_for_dispatch', 'ready_for_collection', 'cancelled', 'refund_requested', 'disputed', 'refunded', 'partially_refunded', 'dispatched'],
  ready_for_dispatch: ['dispatched', 'delivered', 'cancelled', 'refund_requested', 'disputed', 'refunded', 'partially_refunded', 'delivery_failed'],
  ready_for_collection: ['collected', 'cancelled', 'refund_requested', 'disputed', 'refunded', 'partially_refunded'],
  dispatched: ['delivered', 'delivery_failed', 'refund_requested', 'disputed', 'refunded', 'partially_refunded'],
  delivery_failed: ['ready_for_dispatch', 'dispatched', 'refund_requested', 'disputed', 'refunded', 'partially_refunded', 'cancelled'],
  delivered: ['settlement_pending', 'refund_requested', 'disputed'],
  collected: ['settlement_pending', 'refund_requested', 'disputed'],
  settlement_pending: ['settled', 'refund_requested', 'disputed', 'refunded', 'partially_refunded'],
  refund_requested: ['paid', 'processing', 'ready_for_dispatch', 'ready_for_collection', 'dispatched', 'delivered', 'collected', 'settlement_pending', 'refunded', 'partially_refunded', 'disputed', 'delivery_failed'],
  partially_refunded: ['settled', 'settlement_pending', 'refund_requested', 'disputed', 'refunded', 'processing', 'ready_for_dispatch', 'ready_for_collection', 'dispatched', 'delivered', 'collected'],
  disputed: ['paid', 'processing', 'ready_for_dispatch', 'ready_for_collection', 'dispatched', 'delivered', 'collected', 'settlement_pending', 'refunded', 'partially_refunded', 'delivery_failed'],
  refunded: [],
  cancelled: [],
  settled: [],
});

const orderNumber = () => `MP${new Date().toISOString().slice(2, 10).replace(/-/g, '')}${randomDigits(6)}`;

// ---------------------------------------------------------------- cart
async function getCart(user) {
  const cart = (await Cart.findOne({ userId: user._id }).lean()) || { items: [] };
  const products = await Product.find({ _id: { $in: cart.items.map((i) => i.productId) } }).lean();
  const pm = new Map(products.map((p) => [String(p._id), p]));
  const items = cart.items.map((i) => {
    const p = pm.get(String(i.productId));
    const issues = [];
    if (!p || p.status !== 'published') issues.push('unavailable');
    else if (p.stock < i.quantity) issues.push(p.stock === 0 ? 'out_of_stock' : 'insufficient_stock');
    if (p && p.sellerId && String(p.sellerId) === String(user._id)) issues.push('own_listing');
    return { productId: String(i.productId), quantity: i.quantity, product: p ? { title: p.title, slug: p.slug, priceKobo: p.priceKobo, image: p.images?.[0]?.url, stock: p.stock, sellerId: p.sellerId ? String(p.sellerId) : null, kind: p.kind, originState: p.fulfilment?.originState, delivery: p.fulfilment?.delivery, collection: p.fulfilment?.collection } : null, lineTotalKobo: p ? p.priceKobo * i.quantity : 0, issues };
  });
  return { items, subtotalKobo: items.filter((i) => !i.issues.length).reduce((a, i) => a + i.lineTotalKobo, 0), hasIssues: items.some((i) => i.issues.length) };
}

async function setCartItem(user, productId, quantity) {
  const p = await Product.findOne({ _id: productId, status: 'published' });
  if (!p) throw E.notFound('Product');
  if (p.sellerId && String(p.sellerId) === String(user._id)) throw E.badRequest('You cannot buy your own listing');
  if (quantity > p.stock) throw E.conflict(`Only ${p.stock} available`, 'INSUFFICIENT_STOCK');
  await Cart.updateOne({ userId: user._id }, { $setOnInsert: { userId: user._id, items: [] } }, { upsert: true });
  if (quantity <= 0) await Cart.updateOne({ userId: user._id }, { $pull: { items: { productId } } });
  else {
    const r = await Cart.updateOne({ userId: user._id, 'items.productId': productId }, { $set: { 'items.$.quantity': quantity } });
    if (!r.matchedCount) await Cart.updateOne({ userId: user._id }, { $push: { items: { productId, quantity, addedAt: new Date() } } });
  }
  return getCart(user);
}

function groupCart(cart) {
  const groups = new Map();
  for (const i of cart.items) {
    if (i.issues.length) throw E.conflict('Some items in your cart are no longer available. Review your cart.', 'CART_INVALID', { items: cart.items.filter((x) => x.issues.length).map((x) => ({ productId: x.productId, issues: x.issues })) });
    const key = i.product.sellerId || 'mubapay';
    if (!groups.has(key)) groups.set(key, { key, sellerId: i.product.sellerId, originState: i.product.originState, items: [] });
    groups.get(key).items.push(i);
  }
  return [...groups.values()];
}

// ---------------------------------------------------------------- delivery quote at checkout
async function deliveryQuote(user, { addressId }) {
  const address = user.addresses.id(addressId);
  if (!address) throw E.notFound('Address');
  const cart = await getCart(user);
  if (!cart.items.length) throw E.badRequest('Your cart is empty');
  const groups = groupCart(cart);
  const out = [];
  for (const g of groups) {
    if (g.items.some((i) => !i.product.delivery)) {
      out.push({ groupKey: g.key, deliveryAvailable: false, reason: 'One or more items in this group are collection-only' });
      continue;
    }
    const products = await Product.find({ _id: { $in: g.items.map((i) => i.productId) } }).lean();
    const origin = { state: g.originState, addressCode: products[0]?.fulfilment?.originAddressCode };
    // eslint-disable-next-line no-await-in-loop
    const q = await deliveries.quoteForGroup(user, { items: g.items.map((i) => ({ name: i.product.title, unitAmountKobo: i.product.priceKobo, quantity: i.quantity, unitWeightKg: products.find((p) => String(p._id) === i.productId)?.weightKg })), origin, destination: address.toObject() });
    out.push({ groupKey: g.key, deliveryAvailable: true, ...q });
  }
  return { groups: out };
}

// ---------------------------------------------------------------- checkout
async function createCheckout(user, body, { idempotencyKey, req }) {
  await settings.assertFeature('marketplace_checkout');
  if (!user.emailVerifiedAt) throw E.verificationRequired('Verify your email before checking out');
  const existing = await Checkout.findOne({ buyerId: user._id, idempotencyKey });
  if (existing) return presentCheckout(existing);
  if (body.acceptedPolicies?.length) {
    await consent.assertRequiredAccepted(body.acceptedPolicies, 'checkout');
    await consent.recordAcceptances(user._id, body.acceptedPolicies, { context: 'checkout', ip: req.ip, userAgent: req.get('user-agent') });
  }
  await consent.assertUserAccepted(user._id, 'checkout');
  if (body.paymentMethod === 'wallet') {
    await settings.assertFeature('marketplace_checkout', { complianceKey: 'walletOperationsAuthorized' });
    const v = await settings.get('verification');
    if (user.verificationTier < v.financialMinTier) throw E.verificationRequired('Paying from your wallet requires a verified phone number');
  }
  const cart = await getCart(user);
  if (!cart.items.length) throw E.badRequest('Your cart is empty');
  const groups = groupCart(cart);
  const [mk, fees, delivery] = await Promise.all([settings.get('marketplace'), settings.get('fees'), settings.get('delivery')]);
  const address = body.fulfilmentMethod === 'delivery' ? user.addresses.id(body.addressId) : null;
  if (body.fulfilmentMethod === 'delivery' && !address) throw E.validation([{ path: 'addressId', message: 'Choose a delivery address' }]);
  const collectionPoint = body.fulfilmentMethod === 'collection' ? delivery.collectionPoints.find((c) => c.id === body.collectionPointId) : null;
  if (body.fulfilmentMethod === 'collection' && !collectionPoint) throw E.validation([{ path: 'collectionPointId', message: 'Choose a collection point' }]);

  // Resolve server-side delivery quotes (never trust client fees)
  const groupQuotes = {};
  for (const g of groups) {
    if (body.fulfilmentMethod === 'delivery') {
      const sel = body.deliveryQuotes?.[g.key];
      if (!sel?.quoteId) throw E.validation([{ path: `deliveryQuotes.${g.key}`, message: 'Get a delivery quote before paying' }]);
      // eslint-disable-next-line no-await-in-loop
      groupQuotes[g.key] = await deliveries.loadQuote(user._id, sel.quoteId, sel.optionIndex || 0);
    } else if (g.items.some((i) => !i.product.collection)) {
      throw E.validation([{ path: 'fulfilmentMethod', message: 'Some items cannot be collected; choose delivery' }]);
    }
  }
  const policyVersions = Object.fromEntries(await consent.latestPublished(consent.REQUIRED.checkout).then((m) => [...m].map(([k, v]) => [k, v.version])));

  const result = await withTransaction(async (session) => {
    const [checkout] = await Checkout.create([{ buyerId: user._id, idempotencyKey, totalKobo: 0, paymentMethod: body.paymentMethod, expiresAt: new Date(Date.now() + mk.paymentTimeoutMinutes * 60e3) }], { session });
    const orders = [];
    for (const g of groups) {
      const items = [];
      for (const i of g.items) {
        // Atomic reservation prevents overselling under concurrency.
        // eslint-disable-next-line no-await-in-loop
        const p = await Product.findOneAndUpdate({ _id: i.productId, status: 'published', stock: { $gte: i.quantity } }, { $inc: { stock: -i.quantity } }, { new: true, session });
        if (!p) throw E.conflict(`"${i.product.title}" just sold out or has less stock than requested`, 'INSUFFICIENT_STOCK', { productId: i.productId });
        items.push({ productId: p._id, title: p.title, slug: p.slug, image: p.images?.[0]?.url, condition: p.condition, unitPriceKobo: p.priceKobo, quantity: i.quantity, lineTotalKobo: p.priceKobo * i.quantity });
      }
      const subtotal = items.reduce((a, x) => a + x.lineTotalKobo, 0);
      const q = groupQuotes[g.key];
      const deliveryFee = q ? q.feeKobo : 0;
      const [order] = await Order.create([{
        orderNumber: orderNumber(), checkoutId: checkout._id, buyerId: user._id, sellerId: g.sellerId || null, sellerKind: g.sellerId ? 'used_seller' : 'platform', items, subtotalKobo: subtotal, deliveryFeeKobo: deliveryFee, totalKobo: subtotal + deliveryFee,
        fulfilmentMethod: body.fulfilmentMethod, address: address ? address.toObject() : undefined, collectionPoint: collectionPoint || undefined,
        deliveryQuote: q ? { provider: q.provider, quoteRef: q.quoteRef, serviceCode: q.serviceCode, courierId: q.courierId, courierName: q.courierName, feeKobo: q.feeKobo, etaText: q.etaText, expiresAt: q.expiresAt } : undefined,
        terms: { commissionBp: g.sellerId ? (fees.marketplaceCommission.type === 'percent' ? fees.marketplaceCommission.bp : 0) : 0, refundWindowDays: mk.refundRequestWindowDays, settlementHoldHours: mk.settlementHoldHoursAfterDelivery, policyVersions },
        statusHistory: [{ at: new Date(), status: 'pending_payment', by: user._id }],
      }], { session });
      orders.push(order);
    }
    checkout.orderIds = orders.map((o) => o._id);
    checkout.totalKobo = orders.reduce((a, o) => a + o.totalKobo, 0);
    await checkout.save({ session });

    if (body.paymentMethod === 'wallet') {
      await ledger.post({ reference: `ORD-PAY-${checkout._id}`, type: 'order_payment', description: `Marketplace purchase (${orders.map((o) => o.orderNumber).join(', ')})`, entries: [{ account: ledger.userCodes(user._id).wallet, direction: 'debit', amount: checkout.totalKobo }, { account: ledger.SYS.ORDER_CLEARING, direction: 'credit', amount: checkout.totalKobo }], initiatedBy: user._id, relatedType: 'checkout', relatedId: checkout._id }, session);
      await markCheckoutPaid(checkout, session);
    }
    await Cart.updateOne({ userId: user._id }, { $set: { items: [] } }, { session });
    await audit.record({ ...audit.ctxFrom(req), actor: user, action: 'checkout.created', category: 'finance', targetType: 'checkout', targetId: checkout._id, metadata: { totalKobo: checkout.totalKobo, paymentMethod: body.paymentMethod } }, { session });
    return checkout;
  }).catch(async (err) => {
    if (err.code === 11000) {
      const c = await Checkout.findOne({ buyerId: user._id, idempotencyKey });
      if (c) return c;
    }
    throw err;
  });

  if (result.paymentMethod === 'paystack' && result.status === 'pending_payment') {
    try {
      const attempt = await payments.initPayment({ user, purpose: 'order', amountKobo: result.totalKobo, relatedType: 'checkout', relatedId: result._id, idempotencyKey: `checkout-${result._id}`, callbackPath: '/app/checkout/return' });
      await Checkout.updateOne({ _id: result._id, status: 'pending_payment' }, { $set: { status: 'payment_processing', paymentReference: attempt.reference } });
      await Order.updateMany({ checkoutId: result._id, status: 'pending_payment' }, { $set: { status: 'payment_processing' }, $push: { statusHistory: { at: new Date(), status: 'payment_processing' } } });
    } catch (err) {
      await expireCheckout(result._id, 'payment_initialisation_failed');
      throw err;
    }
  }
  return presentCheckout(await Checkout.findById(result._id));
}

async function presentCheckout(c) {
  const orders = await Order.find({ _id: { $in: c.orderIds } }, { orderNumber: 1, status: 1, totalKobo: 1 }).lean();
  const attempt = c.paymentReference ? await PaymentAttempt.findOne({ reference: c.paymentReference }).lean() : null;
  return { id: String(c._id), status: c.status, totalKobo: c.totalKobo, paymentMethod: c.paymentMethod, paymentReference: c.paymentReference, authorizationUrl: attempt && !attempt.fulfilledAt ? attempt.authorizationUrl : undefined, orders: orders.map((o) => ({ id: String(o._id), orderNumber: o.orderNumber, status: o.status, totalKobo: o.totalKobo })), expiresAt: c.expiresAt };
}

async function markCheckoutPaid(checkout, session) {
  const updated = await Checkout.findOneAndUpdate({ _id: checkout._id, status: { $in: ['pending_payment', 'payment_processing'] } }, { $set: { status: 'paid' } }, { new: true, session });
  if (!updated) throw E.invalidState('Checkout is no longer payable');
  const orders = await Order.find({ checkoutId: checkout._id }).session(session);
  for (const o of orders) {
    // eslint-disable-next-line no-await-in-loop
    await orderMachine.transition(Order, o._id, ['pending_payment', 'payment_processing'], 'paid', { paidAt: new Date() }, { session, push: { statusHistory: { at: new Date(), status: 'paid' } } });
    if (o.fulfilmentMethod === 'delivery') {
      // eslint-disable-next-line no-await-in-loop
      const dr = await deliveries.createForOrder(o, session);
      // eslint-disable-next-line no-await-in-loop
      await Order.updateOne({ _id: o._id }, { $set: { deliveryRequestId: dr._id } }, { session });
    }
    for (const it of o.items) {
      // eslint-disable-next-line no-await-in-loop
      await Product.updateOne({ _id: it.productId }, { $inc: { soldCount: it.quantity } }, { session });
    }
    // eslint-disable-next-line no-await-in-loop
    await notifications.notify(o.buyerId, { category: 'orders', type: 'order_paid', title: `Order ${o.orderNumber} confirmed`, body: `Payment of ${koboToNairaString(o.totalKobo)} confirmed.`, link: `/app/orders/${o._id}`, dedupeKey: `order_paid:${o._id}` }, { session });
    if (o.sellerId) {
      // eslint-disable-next-line no-await-in-loop
      await notifications.notify(o.sellerId, { category: 'orders', type: 'new_sale', title: 'You made a sale', body: `Order ${o.orderNumber}: prepare the item for ${o.fulfilmentMethod}.`, link: `/app/seller/orders/${o._id}` }, { session });
    } else {
      // eslint-disable-next-line no-await-in-loop
      await afterCommit(session, () => notifications.notifyStaff('orders.manage', { category: 'system', type: 'new_order', title: 'New order to fulfil', body: o.orderNumber, link: '/admin/orders' }));
    }
  }
  return updated;
}

payments.registerPurpose('order', {
  async creditTarget(attempt, session) {
    const c = await Checkout.findById(attempt.relatedId).session(session);
    if (!c || !['pending_payment', 'payment_processing'].includes(c.status) || c.inventoryReleased) {
      throw E.invalidState('Checkout expired before payment confirmed');
    }
    if (c.totalKobo !== attempt.amountKobo) throw E.invalidState('Checkout amount changed');
    return { account: ledger.SYS.ORDER_CLEARING, ledgerType: 'order_payment', description: `Marketplace purchase via Paystack (${attempt.reference})` };
  },
  async onSuccess(attempt, session) {
    const c = await Checkout.findById(attempt.relatedId).session(session);
    await markCheckoutPaid(c, session);
  },
  async onFailure(attempt) {
    await expireCheckout(attempt.relatedId, `payment_${attempt.status}`);
  },
});

/** Release reserved stock and cancel unpaid orders (never when payment might have succeeded). */
async function expireCheckout(checkoutId, reason) {
  return withTransaction(async (session) => {
    const c = await Checkout.findOneAndUpdate({ _id: checkoutId, status: { $in: ['pending_payment', 'payment_processing'] }, inventoryReleased: false }, { $set: { status: 'expired', inventoryReleased: true } }, { new: true, session });
    if (!c) return null;
    const orders = await Order.find({ checkoutId }).session(session);
    for (const o of orders) {
      for (const it of o.items) {
        // eslint-disable-next-line no-await-in-loop
        await Product.updateOne({ _id: it.productId }, { $inc: { stock: it.quantity } }, { session });
      }
      // eslint-disable-next-line no-await-in-loop
      await Order.updateOne({ _id: o._id, status: { $in: ['pending_payment', 'payment_processing'] } }, { $set: { status: 'cancelled', cancelledReason: reason }, $push: { statusHistory: { at: new Date(), status: 'cancelled', note: reason } } }, { session });
    }
    await afterCommit(session, () => require('./products.service').invalidateSearchCache());
    return c;
  });
}

/** Scheduled: expire unpaid checkouts only after confirming the payment did not succeed. */
async function expireUnpaid() {
  const due = await Checkout.find({ status: { $in: ['pending_payment', 'payment_processing'] }, expiresAt: { $lt: new Date() } }).limit(100);
  let expired = 0;
  for (const c of due) {
    if (c.paymentReference) {
      // eslint-disable-next-line no-await-in-loop
      const a = await payments.verifyAndFulfil(c.paymentReference, { source: 'checkout_expiry' }).catch(() => null);
      if (!a || a.fulfilledAt) continue;
      // A timeout / unknown outcome is NOT proof of failure: keep the reservation.
      if (!['failed', 'abandoned'].includes(a.status)) {
        if (Date.now() - c.expiresAt.getTime() < 24 * 3600e3) continue;
        if (a.status === 'uncertain') continue;
      }
    }
    // eslint-disable-next-line no-await-in-loop
    if (await expireCheckout(c._id, 'payment_timeout')) expired += 1;
  }
  return { checked: due.length, expired };
}

// ---------------------------------------------------------------- order access & transitions
function canManage(user, order) {
  if (order.sellerId) return String(order.sellerId) === String(user._id) || hasPermission(user, 'orders.manage');
  return hasPermission(user, 'orders.manage');
}

async function getOrderFor(user, id) {
  const o = await Order.findById(id).lean();
  if (!o) throw E.notFound('Order');
  const isBuyer = String(o.buyerId) === String(user._id);
  const isSeller = o.sellerId && String(o.sellerId) === String(user._id);
  if (!isBuyer && !isSeller && !hasPermission(user, 'orders.view')) throw E.notFound('Order');
  const dr = o.deliveryRequestId ? await DeliveryRequest.findById(o.deliveryRequestId).lean() : null;
  const timeline = dr ? await deliveries.timeline(dr._id) : [];
  const [refunds, disputes, settlement] = await Promise.all([RefundRequest.find({ subjectType: 'order', subjectId: o._id }).lean(), Dispute.find({ subjectType: 'order', subjectId: o._id }).lean(), isBuyer && !hasPermission(user, 'orders.view') ? null : SellerSettlement.findOne({ orderId: o._id }).lean()]);
  const out = { ...o, id: String(o._id), viewerRole: isBuyer ? 'buyer' : isSeller ? 'seller' : 'staff', delivery: dr ? { id: String(dr._id), provider: dr.provider, status: dr.status, trackingUrl: dr.trackingUrl, shipmentRef: dr.shipmentRef, courierName: o.deliveryQuote?.courierName, timeline: timeline.map((t) => ({ at: t.at, status: t.status, note: t.note, source: t.source })) } : null, refunds, disputes, settlement };
  if (isSeller && !isBuyer) {
    // sellers see only what fulfilment needs
    out.address = o.address ? { city: o.address.city, state: o.address.state, lga: o.address.lga } : undefined;
  }
  delete out.pickup;
  return out;
}

async function listOrders(user, { role = 'buyer', status, page = 1, limit = 20 }) {
  const filter = role === 'seller' ? { sellerId: user._id } : { buyerId: user._id };
  if (status) filter.status = status;
  const [items, total] = await Promise.all([Order.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(), Order.countDocuments(filter)]);
  return { items: items.map((o) => ({ id: String(o._id), orderNumber: o.orderNumber, status: o.status, totalKobo: o.totalKobo, items: o.items.map((i) => ({ title: i.title, quantity: i.quantity, image: i.image })), fulfilmentMethod: o.fulfilmentMethod, createdAt: o.createdAt })), meta: { page, limit, total, pages: Math.ceil(total / limit) } };
}

async function transitionSystem(orderId, from, to, { note, by, session, extra } = {}) {
  const o = await Order.findById(orderId).session(session || null);
  if (!o) throw E.notFound('Order');
  const fromList = (Array.isArray(from) ? from : [from]).filter((f) => f === o.status);
  if (!fromList.length) return o; // already moved (out-of-order / duplicate) — idempotent no-op
  return orderMachine.transition(Order, orderId, fromList, to, extra || {}, { session, push: { statusHistory: { at: new Date(), status: to, by, note } } });
}

/** Seller / staff fulfilment actions. */
async function fulfilmentAction(user, orderId, { action, note }, req) {
  const o = await Order.findById(orderId);
  if (!o) throw E.notFound('Order');
  if (!canManage(user, o)) throw E.forbidden();
  let updated;
  if (action === 'start_processing') updated = await orderMachine.transition(Order, o._id, 'paid', 'processing', {}, { push: { statusHistory: { at: new Date(), status: 'processing', by: user._id, note } } });
  else if (action === 'ready') {
    if (o.fulfilmentMethod === 'delivery') {
      updated = await orderMachine.transition(Order, o._id, ['paid', 'processing', 'delivery_failed'], 'ready_for_dispatch', {}, { push: { statusHistory: { at: new Date(), status: 'ready_for_dispatch', by: user._id, note } } });
      await infra.queue.add('delivery.book', { deliveryRequestId: String(o.deliveryRequestId) }, { jobId: `book:${o.deliveryRequestId}:${Date.now()}`, attempts: 5, backoffMs: 30000 }).catch(() => deliveries.book(o.deliveryRequestId));
    } else {
      const code = randomDigits(6);
      const qrToken = randomToken(24);
      const mk = await settings.get('marketplace');
      updated = await orderMachine.transition(Order, o._id, ['paid', 'processing'], 'ready_for_collection', { 'pickup.codeHash': sha256(`${o._id}:${code}`), 'pickup.qrTokenHash': sha256(qrToken), 'pickup.issuedAt': new Date(), 'pickup.expiresAt': new Date(Date.now() + mk.collectionCodeTtlDays * 864e5), 'pickup.usedAt': null, 'pickup.failedAttempts': 0 }, { push: { statusHistory: { at: new Date(), status: 'ready_for_collection', by: user._id } } });
      await notifications.notify(o.buyerId, { category: 'orders', type: 'ready_for_collection', title: `Order ${o.orderNumber} is ready for collection`, body: `Show code ${code} at ${o.collectionPoint?.name || 'the collection point'}. Do not share it until you have your item.`, link: `/app/orders/${o._id}`, data: { collectionCode: code, qrToken } });
    }
  } else if (action === 'cancel') {
    return cancelPaidOrder(user, o, note || 'Cancelled by seller', req);
  } else throw E.badRequest('Unknown action');
  await audit.fromReq(req, { action: `order.${action}`, category: 'operations', targetType: 'order', targetId: o._id, reason: note });
  if (action !== 'cancel') await notifications.notify(o.buyerId, { category: 'orders', type: `order_${updated.status}`, title: `Order ${o.orderNumber} update`, body: `Status: ${updated.status.replace(/_/g, ' ')}`, link: `/app/orders/${o._id}` });
  return updated;
}

/** Cancel a paid (not yet dispatched) order with a full refund to the buyer wallet. */
async function cancelPaidOrder(user, o, reason, req) {
  if (!['paid', 'processing', 'ready_for_dispatch', 'ready_for_collection', 'delivery_failed'].includes(o.status)) throw E.invalidState('This order can no longer be cancelled');
  const remaining = o.totalKobo - o.refundedKobo;
  await withTransaction(async (session) => {
    await orderMachine.transition(Order, o._id, o.status, 'cancelled', { cancelledReason: reason, refundedKobo: o.totalKobo }, { session, push: { statusHistory: { at: new Date(), status: 'cancelled', by: user._id, note: reason } } });
    if (remaining > 0) {
      await ledger.post({ reference: `ORD-CXL-${o._id}`, type: 'order_refund', description: `Refund for cancelled order ${o.orderNumber}`, entries: [{ account: ledger.SYS.ORDER_CLEARING, direction: 'debit', amount: remaining }, { account: ledger.userCodes(o.buyerId).wallet, direction: 'credit', amount: remaining }], initiatedBy: user._id, relatedType: 'order', relatedId: o._id }, session);
    }
    for (const it of o.items) await Product.updateOne({ _id: it.productId }, { $inc: { stock: it.quantity, soldCount: -it.quantity } }, { session });
    await notifications.notify(o.buyerId, { category: 'orders', type: 'order_cancelled', title: `Order ${o.orderNumber} cancelled`, body: `${koboToNairaString(remaining)} has been refunded to your MubaPay wallet.`, link: `/app/orders/${o._id}` }, { session });
    await audit.record({ ...audit.ctxFrom(req), actor: user, action: 'order.cancelled_with_refund', category: 'finance', targetType: 'order', targetId: o._id, reason, metadata: { refundKobo: remaining } }, { session });
  });
  if (o.deliveryRequestId) {
    const dr = await DeliveryRequest.findById(o.deliveryRequestId);
    if (dr) await deliveries.cancelShipment(dr);
  }
  return Order.findById(o._id);
}

async function markDelivered(orderId, { by, evidence, session }) {
  const mk = await settings.get('marketplace');
  const o = await Order.findById(orderId).session(session || null);
  const from = ['dispatched', 'ready_for_dispatch', 'delivery_failed'].filter((s) => s === o.status);
  if (!from.length) return o;
  await orderMachine.transition(Order, orderId, from, 'delivered', { deliveredAt: new Date() }, { session, push: { statusHistory: { at: new Date(), status: 'delivered', by }, fulfilmentEvidence: { at: new Date(), ...(evidence || {}), by } } });
  return orderMachine.transition(Order, orderId, 'delivered', 'settlement_pending', { settlementEligibleAt: new Date(Date.now() + (o.terms?.settlementHoldHours ?? mk.settlementHoldHoursAfterDelivery) * 3600e3) }, { session, push: { statusHistory: { at: new Date(), status: 'settlement_pending' } } });
}

/** Buyer confirms receipt early (optional) — moves delivered orders on. */
async function confirmCollection(staffOrSeller, orderId, { code, qrToken, staffAssisted, identityNote }, req) {
  const o = await Order.findById(orderId).select('+pickup.codeHash +pickup.qrTokenHash');
  if (!o) throw E.notFound('Order');
  const isSeller = o.sellerId && String(o.sellerId) === String(staffOrSeller._id);
  if (!isSeller && !hasPermission(staffOrSeller, 'collections.confirm')) throw E.forbidden();
  if (o.status !== 'ready_for_collection') throw E.invalidState('Order is not awaiting collection');
  if (o.pickup.expiresAt < new Date()) throw E.conflict('Collection code expired. Issue a new code.', 'CODE_EXPIRED');
  if (o.pickup.failedAttempts >= 5) throw E.tooMany('Too many incorrect codes. Use the staff-assisted process.');
  let method;
  if (staffAssisted) {
    if (!hasPermission(staffOrSeller, 'collections.confirm')) throw E.forbidden('Only staff can confirm a collection without a code');
    if (!identityNote || identityNote.length < 10) throw E.validation([{ path: 'identityNote', message: 'Record how the buyer\'s identity was verified' }]);
    method = 'staff_assisted';
  } else if (code) {
    if (!safeEqual(sha256(`${o._id}:${code}`), o.pickup.codeHash)) {
      await Order.updateOne({ _id: o._id }, { $inc: { 'pickup.failedAttempts': 1 } });
      throw E.badRequest('Incorrect collection code');
    }
    method = 'code';
  } else if (qrToken) {
    if (!safeEqual(sha256(qrToken), o.pickup.qrTokenHash)) throw E.badRequest('Invalid QR code');
    method = 'qr';
  } else throw E.badRequest('Provide the collection code or QR');
  const mk = await settings.get('marketplace');
  await withTransaction(async (session) => {
    // usedAt:null condition makes the code single-use even under concurrent submissions.
    const r = await Order.findOneAndUpdate({ _id: o._id, status: 'ready_for_collection', 'pickup.usedAt': null }, { $set: { status: 'collected', 'pickup.usedAt': new Date(), 'pickup.confirmedBy': staffOrSeller._id, 'pickup.method': method, deliveredAt: new Date() }, $push: { statusHistory: { at: new Date(), status: 'collected', by: staffOrSeller._id, note: method }, fulfilmentEvidence: { at: new Date(), type: `collection_${method}`, note: identityNote, by: staffOrSeller._id } } }, { new: true, session });
    if (!r) throw E.conflict('This collection code has already been used', 'CODE_USED');
    await orderMachine.transition(Order, o._id, 'collected', 'settlement_pending', { settlementEligibleAt: new Date(Date.now() + (o.terms?.settlementHoldHours ?? mk.settlementHoldHoursAfterDelivery) * 3600e3) }, { session, push: { statusHistory: { at: new Date(), status: 'settlement_pending' } } });
    await audit.record({ ...audit.ctxFrom(req), actor: staffOrSeller, action: 'order.collected', category: 'operations', targetType: 'order', targetId: o._id, metadata: { method } }, { session });
    await notifications.notify(o.buyerId, { category: 'orders', type: 'order_collected', title: `Order ${o.orderNumber} collected`, body: 'Thanks for shopping with MubaPay.', link: `/app/orders/${o._id}` }, { session });
  });
  return Order.findById(o._id);
}

// ---------------------------------------------------------------- settlement
/** Amounts at settlement after any partial refunds (refunds reduce items first, then delivery). */
function settlementSplit(order) {
  const refundedItems = Math.min(order.refundedKobo, order.subtotalKobo);
  const refundedDelivery = Math.max(0, order.refundedKobo - order.subtotalKobo);
  const itemsRemaining = order.subtotalKobo - refundedItems;
  const deliveryRemaining = order.deliveryFeeKobo - refundedDelivery;
  const commission = order.sellerId ? percentBp(itemsRemaining, order.terms?.commissionBp || 0) : 0;
  return { itemsRemaining, deliveryRemaining, commission, sellerNet: itemsRemaining - commission, total: itemsRemaining + deliveryRemaining };
}

async function settleOrder(orderId) {
  const o = await Order.findById(orderId);
  if (!o || !['settlement_pending', 'partially_refunded'].includes(o.status) || !o.settlementEligibleAt || o.settlementEligibleAt > new Date()) return null;
  const openRefund = await RefundRequest.exists({ subjectType: 'order', subjectId: o._id, status: { $in: ['pending_review', 'approved', 'processing'] } });
  const openDispute = await Dispute.exists({ subjectType: 'order', subjectId: o._id, status: { $in: ['open', 'under_review'] } });
  if (openRefund || openDispute) return null;
  const s = settlementSplit(o);
  if (s.total !== o.totalKobo - o.refundedKobo) throw new Error(`Settlement split mismatch for order ${o.orderNumber}`);
  await withTransaction(async (session) => {
    const moved = await Order.findOneAndUpdate({ _id: o._id, status: { $in: ['settlement_pending', 'partially_refunded'] } }, { $set: { status: 'settled', settledAt: new Date() }, $push: { statusHistory: { at: new Date(), status: 'settled' } } }, { new: true, session });
    if (!moved) return;
    if (s.total === 0) return;
    const entries = [{ account: ledger.SYS.ORDER_CLEARING, direction: 'debit', amount: s.total }];
    if (o.sellerId) {
      await ledger.ensureUserAccounts(o.sellerId);
      if (s.sellerNet) entries.push({ account: ledger.userCodes(o.sellerId).sellerPayable, direction: 'credit', amount: s.sellerNet });
      if (s.commission) entries.push({ account: ledger.SYS.REVENUE_COMMISSION, direction: 'credit', amount: s.commission });
    } else if (s.itemsRemaining) entries.push({ account: ledger.SYS.REVENUE_SALES, direction: 'credit', amount: s.itemsRemaining });
    if (s.deliveryRemaining) entries.push({ account: ledger.SYS.DELIVERY_PAYABLE, direction: 'credit', amount: s.deliveryRemaining });
    const tx = await ledger.post({ reference: `ORD-SETTLE-${o._id}`, type: 'order_settlement', description: `Settlement for order ${o.orderNumber}`, entries, relatedType: 'order', relatedId: o._id, metadata: s }, session);
    if (o.sellerId && s.sellerNet) {
      await SellerSettlement.create([{ reference: `STL-${o.orderNumber}`, orderId: o._id, sellerId: o.sellerId, grossKobo: s.itemsRemaining, commissionKobo: s.commission, netKobo: s.sellerNet, ledgerReference: tx.reference }], { session });
      await notifications.notify(o.sellerId, { category: 'financial', type: 'settlement_pending_release', title: 'Sale proceeds ready for release', body: `${koboToNairaString(s.sellerNet)} from order ${o.orderNumber} will be released to your wallet.`, link: '/app/seller/settlements' }, { session });
    }
  });
  return Order.findById(o._id);
}

async function releaseSettlement(settlementId, { by, req } = {}) {
  await settings.assertFeature('seller_settlements', { complianceKey: 'settlementHoldingAuthorized' });
  const st = await SellerSettlement.findById(settlementId);
  if (!st) throw E.notFound('Settlement');
  if (by && String(st.sellerId) === String(by._id)) throw E.forbidden('You cannot release your own settlement');
  const seller = await User.findById(st.sellerId);
  if (!seller || seller.status !== 'active') {
    await SellerSettlement.updateOne({ _id: st._id, status: 'pending_release' }, { $set: { status: 'on_hold', holdReason: 'Seller account not active' } });
    return SellerSettlement.findById(st._id);
  }
  await withTransaction(async (session) => {
    const r = await SellerSettlement.findOneAndUpdate({ _id: st._id, status: { $in: ['pending_release', 'on_hold'] } }, { $set: { status: 'released', releasedAt: new Date(), releasedBy: by?._id } }, { new: true, session });
    if (!r) throw E.invalidState('Settlement already released');
    const c = ledger.userCodes(st.sellerId);
    await ledger.post({ reference: `${st.reference}-REL`, type: 'seller_settlement_release', description: `Settlement released for ${st.reference}`, entries: [{ account: c.sellerPayable, direction: 'debit', amount: st.netKobo }, { account: c.wallet, direction: 'credit', amount: st.netKobo }], initiatedBy: by?._id, relatedType: 'seller_settlement', relatedId: st.reference }, session);
    await notifications.notify(st.sellerId, { category: 'financial', type: 'settlement_released', title: 'Proceeds released', body: `${koboToNairaString(st.netKobo)} has been added to your wallet.`, link: '/app/wallet' }, { session });
    if (by) await audit.record({ ...audit.ctxFrom(req), actor: by, action: 'settlement.released', category: 'finance', targetType: 'seller_settlement', targetId: st.reference }, { session });
  });
  return SellerSettlement.findById(st._id);
}

async function runSettlements() {
  const due = await Order.find({ status: { $in: ['settlement_pending', 'partially_refunded'] }, settlementEligibleAt: { $lte: new Date() } }, { _id: 1 }).limit(200).lean();
  let settled = 0;
  for (const d of due) {
    // eslint-disable-next-line no-await-in-loop
    const r = await settleOrder(d._id).catch((err) => logger.error({ err, order: d._id }, 'settlement failed'));
    if (r?.status === 'settled') settled += 1;
  }
  let released = 0;
  if (await settings.isEnabled('seller_settlements')) {
    const pending = await SellerSettlement.find({ status: 'pending_release' }, { _id: 1 }).limit(200).lean();
    for (const p of pending) {
      // eslint-disable-next-line no-await-in-loop
      const r = await releaseSettlement(p._id).catch((err) => logger.warn({ err: err.message }, 'auto release skipped'));
      if (r?.status === 'released') released += 1;
    }
  }
  return { due: due.length, settled, released };
}

async function sellerSettlements(user) {
  return SellerSettlement.find({ sellerId: user._id }).sort({ createdAt: -1 }).limit(200).lean();
}

module.exports = {
  orderMachine, getCart, setCartItem, deliveryQuote, createCheckout, presentCheckout, expireCheckout, expireUnpaid, getOrderFor, listOrders,
  transitionSystem, fulfilmentAction, cancelPaidOrder, markDelivered, confirmCollection, settleOrder, releaseSettlement, runSettlements, sellerSettlements, settlementSplit, canManage, Checkout,
};
