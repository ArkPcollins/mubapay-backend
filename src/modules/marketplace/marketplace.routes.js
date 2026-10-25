'use strict';
const express = require('express');
const { z } = require('zod');
const products = require('./products.service');
const orders = require('./orders.service');
const deliveries = require('../deliveries/deliveries.service');
const refunds = require('../refunds/refunds.service');
const cloudinary = require('../../providers/media/cloudinary.adapter');
const { asyncHandler: h, validate, ok, created } = require('../../lib/http');
const { requireAuth, optionalAuth, requireActive } = require('../../middleware/auth');
const { idempotent, limiter } = require('../../middleware/common');

const oid = z.string().regex(/^[a-f0-9]{24}$/);
const image = z.object({ url: z.string().url(), publicId: z.string().optional(), width: z.number().optional(), height: z.number().optional(), alt: z.string().max(140).optional() });
const fulfilment = z.object({ delivery: z.boolean().optional(), collection: z.boolean().optional(), collectionPointId: z.string().optional(), originState: z.string().optional(), originCity: z.string().optional(), originAddress: z.string().max(300).optional() });
const usedListing = z.object({
  title: z.string().min(4).max(140), description: z.string().min(20).max(5000), brand: z.string().max(60).optional(), categoryId: oid,
  condition: z.enum(['like_new', 'good', 'fair']), conditionNotes: z.string().min(10).max(1000), priceKobo: z.number().int().min(100),
  stock: z.number().int().min(1).max(20).optional(), images: z.array(image).max(10).optional(), weightKg: z.number().min(0.01).max(100).optional(),
  fulfilment: fulfilment.optional(), submit: z.boolean().optional(), acceptedPolicies: z.array(z.object({ slug: z.string(), version: z.number().int() })).optional(),
});

/* Thin controllers delegating to services. */
const ctl = {
  categories: async (_req, res) => ok(res, await products.listCategories()),
  search: async (req, res) => {
    const r = await products.search(req.query);
    ok(res, { items: r.items, sponsored: r.sponsored, notice: r.notice }, r.meta);
  },
  product: async (req, res) => ok(res, await products.getBySlug(req.params.slug, req.user)),
  report: async (req, res) => created(res, await products.report(req.user, req.params.id, req.body)),
  save: async (req, res) => ok(res, await products.toggleSaved(req.user, req.params.id, true)),
  unsave: async (req, res) => ok(res, await products.toggleSaved(req.user, req.params.id, false)),
  saved: async (req, res) => ok(res, await products.listSaved(req.user)),
  savedSearches: async (req, res) => ok(res, await products.listSavedSearches(req.user)),
  saveSearch: async (req, res) => created(res, await products.saveSearch(req.user, req.body)),
  updateSavedSearch: async (req, res) => ok(res, await products.updateSavedSearch(req.user, req.params.id, req.body)),
  deleteSavedSearch: async (req, res) => {
    await products.deleteSavedSearch(req.user, req.params.id);
    ok(res, { deleted: true });
  },
  // seller
  myListings: async (req, res) => ok(res, await products.sellerListings(req.user, req.query)),
  createListing: async (req, res) => created(res, await products.createUsedListing(req.user, req.body, req)),
  updateListing: async (req, res) => ok(res, await products.updateUsedListing(req.user, req.params.id, req.body)),
  archiveListing: async (req, res) => ok(res, await products.archiveUsedListing(req.user, req.params.id)),
  signUpload: async (req, res) => ok(res, cloudinary.signUpload({ purpose: req.body.purpose, ownerId: String(req.user._id) })),
  // cart & checkout
  cart: async (req, res) => ok(res, await orders.getCart(req.user)),
  setCart: async (req, res) => ok(res, await orders.setCartItem(req.user, req.body.productId, req.body.quantity)),
  coverage: async (_req, res) => ok(res, await deliveries.coverage()),
  quote: async (req, res) => ok(res, await orders.deliveryQuote(req.user, req.body)),
  checkout: async (req, res) => created(res, await orders.createCheckout(req.user, req.body, { idempotencyKey: req.idempotencyKey, req })),
  checkoutStatus: async (req, res) => {
    const c = await orders.Checkout.findOne({ _id: req.params.id, buyerId: req.user._id });
    if (!c) throw require('../../lib/errors').E.notFound('Checkout');
    if (c.paymentReference && c.status === 'payment_processing') await require('../payments/payments.service').statusFor(req.user, c.paymentReference).catch(() => {});
    ok(res, await orders.presentCheckout(await orders.Checkout.findById(c._id)));
  },
  // orders
  orders: async (req, res) => {
    const r = await orders.listOrders(req.user, { role: req.query.role, status: req.query.status, page: Number(req.query.page) || 1 });
    ok(res, r.items, r.meta);
  },
  order: async (req, res) => ok(res, await orders.getOrderFor(req.user, req.params.id)),
  fulfil: async (req, res) => ok(res, await orders.fulfilmentAction(req.user, req.params.id, req.body, req)),
  cancelOrder: async (req, res) => {
    const o = await require('./marketplace.models').Order.findOne({ _id: req.params.id, buyerId: req.user._id });
    if (!o) throw require('../../lib/errors').E.notFound('Order');
    if (!['paid', 'processing'].includes(o.status)) throw require('../../lib/errors').E.invalidState('Orders can only be cancelled by the buyer before they are prepared for dispatch or collection');
    ok(res, await orders.cancelPaidOrder(req.user, o, req.body.reason || 'Cancelled by buyer', req));
  },
  confirmCollection: async (req, res) => ok(res, await orders.confirmCollection(req.user, req.params.id, req.body, req)),
  sellerSettlements: async (req, res) => ok(res, await orders.sellerSettlements(req.user)),
  // refunds & disputes
  requestRefund: async (req, res) => created(res, await refunds.requestRefund(req.user, req.body, req)),
  myRefunds: async (req, res) => ok(res, await refunds.myRefunds(req.user)),
  openDispute: async (req, res) => created(res, await refunds.openDispute(req.user, req.body, req)),
  myDisputes: async (req, res) => ok(res, await refunds.myDisputes(req.user)),
  dispute: async (req, res) => ok(res, await refunds.getDisputeFor(req.user, req.params.id)),
  disputeStatement: async (req, res) => ok(res, await refunds.addStatement(req.user, req.params.id, req.body.text)),
};

const r = express.Router();
r.get('/categories', h(ctl.categories));
r.get('/products', h(ctl.search));
r.get('/products/:slug', optionalAuth, h(ctl.product));
r.get('/delivery/coverage', h(ctl.coverage));

r.use(requireAuth);
r.post('/products/:id/report', limiter({ name: 'report', windowMs: 3600e3, max: 20, keyBy: 'user' }), validate(z.object({ category: z.enum(['prohibited_item', 'fraud', 'stolen_goods', 'misleading', 'wrong_category', 'offensive', 'other']), details: z.string().max(1000).optional() })), h(ctl.report));
r.put('/products/:id/save', h(ctl.save));
r.delete('/products/:id/save', h(ctl.unsave));
r.get('/saved', h(ctl.saved));
r.get('/saved-searches', h(ctl.savedSearches));
r.post('/saved-searches', validate(z.object({ scope: z.enum(['products', 'properties']), name: z.string().max(80).optional(), query: z.record(z.any()), alertsEnabled: z.boolean().optional(), alertFrequency: z.enum(['instant', 'daily', 'weekly']).optional() })), h(ctl.saveSearch));
r.patch('/saved-searches/:id', validate(z.object({ name: z.string().max(80).optional(), alertsEnabled: z.boolean().optional(), alertFrequency: z.enum(['instant', 'daily', 'weekly']).optional() })), h(ctl.updateSavedSearch));
r.delete('/saved-searches/:id', h(ctl.deleteSavedSearch));

r.get('/seller/listings', h(ctl.myListings));
r.post('/seller/listings', requireActive, validate(usedListing), h(ctl.createListing));
r.patch('/seller/listings/:id', requireActive, validate(usedListing.partial()), h(ctl.updateListing));
r.post('/seller/listings/:id/archive', h(ctl.archiveListing));
r.get('/seller/settlements', h(ctl.sellerSettlements));
r.post('/media/sign', validate(z.object({ purpose: z.enum(['products', 'properties', 'floorplans', 'tours']) })), h(ctl.signUpload));

r.get('/cart', h(ctl.cart));
r.put('/cart', validate(z.object({ productId: oid, quantity: z.number().int().min(0).max(50) })), h(ctl.setCart));
r.post('/checkout/delivery-quote', validate(z.object({ addressId: oid })), h(ctl.quote));
r.post('/checkout', requireActive, idempotent('checkout'), validate(z.object({
  fulfilmentMethod: z.enum(['delivery', 'collection']), addressId: oid.optional(), collectionPointId: z.string().optional(),
  deliveryQuotes: z.record(z.object({ quoteId: oid, optionIndex: z.number().int().min(0).max(10).optional() })).optional(),
  paymentMethod: z.enum(['wallet', 'paystack']), acceptedPolicies: z.array(z.object({ slug: z.string(), version: z.number().int() })).optional(),
})), h(ctl.checkout));
r.get('/checkout/:id', h(ctl.checkoutStatus));

r.get('/orders', h(ctl.orders));
r.get('/orders/:id', h(ctl.order));
r.post('/orders/:id/fulfilment', validate(z.object({ action: z.enum(['start_processing', 'ready', 'cancel']), note: z.string().max(500).optional() })), h(ctl.fulfil));
r.post('/orders/:id/cancel', validate(z.object({ reason: z.string().max(300).optional() })), h(ctl.cancelOrder));
r.post('/orders/:id/collection/confirm', validate(z.object({ code: z.string().regex(/^\d{6}$/).optional(), qrToken: z.string().max(100).optional(), staffAssisted: z.boolean().optional(), identityNote: z.string().max(500).optional() })), h(ctl.confirmCollection));

r.post('/refunds', validate(z.object({ subjectType: z.enum(['order', 'appointment']), subjectId: oid, amountKobo: z.number().int().positive(), reason: z.enum(['not_received', 'damaged', 'not_as_described', 'wrong_item', 'cancelled_before_dispatch', 'provider_cancelled', 'other']), description: z.string().max(2000).optional(), evidence: z.array(z.object({ type: z.string().max(40), ref: z.string().max(500), note: z.string().max(300).optional() })).max(10).optional(), destination: z.enum(['wallet', 'original_method']).optional() })), h(ctl.requestRefund));
r.get('/refunds', h(ctl.myRefunds));
r.post('/disputes', validate(z.object({ subjectType: z.enum(['order', 'appointment']), subjectId: oid, reason: z.string().min(3).max(120), description: z.string().min(10).max(4000) })), h(ctl.openDispute));
r.get('/disputes', h(ctl.myDisputes));
r.get('/disputes/:id', h(ctl.dispute));
r.post('/disputes/:id/statements', validate(z.object({ text: z.string().min(2).max(4000) })), h(ctl.disputeStatement));

module.exports = r;
