'use strict';
const { mongoose } = require('../../lib/db');
const { Schema } = mongoose;

const categorySchema = new Schema(
  {
    name: { type: String, required: true, maxlength: 80 },
    slug: { type: String, required: true },
    parentId: { type: Schema.Types.ObjectId, ref: 'Category' },
    allowsUsed: { type: Boolean, default: true },
    allowsNew: { type: Boolean, default: true },
    prohibited: { type: Boolean, default: false },
    prohibitedReason: String,
    shipbubbleCategoryId: Number,
    active: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);
categorySchema.index({ slug: 1 }, { unique: true });

const mediaSchema = new Schema({ url: String, publicId: String, width: Number, height: Number, alt: String }, { _id: false });

/**
 * Products: kind "new" = MubaPay-managed catalogue (admins only);
 * kind "used" = fairly-used items submitted by verified users (moderated).
 */
const productSchema = new Schema(
  {
    kind: { type: String, enum: ['new', 'used'], required: true },
    sellerId: { type: Schema.Types.ObjectId, ref: 'User' }, // null for MubaPay-owned new products
    title: { type: String, required: true, maxlength: 140 },
    slug: { type: String, required: true },
    description: { type: String, required: true, maxlength: 5000 },
    brand: { type: String, maxlength: 60 },
    categoryId: { type: Schema.Types.ObjectId, ref: 'Category', required: true },
    condition: { type: String, enum: ['new', 'like_new', 'good', 'fair'], required: true },
    conditionNotes: { type: String, maxlength: 1000 },
    priceKobo: { type: Number, required: true, min: 0 },
    stock: { type: Number, default: 1, min: 0 },
    images: { type: [mediaSchema], default: [] },
    weightKg: { type: Number, default: 0.5 },
    fulfilment: {
      delivery: { type: Boolean, default: true },
      collection: { type: Boolean, default: false },
      collectionPointId: String,
      originState: { type: String, default: 'Anambra' },
      originCity: String,
      originAddress: String,
      originAddressCode: String, // Shipbubble address code when validated
    },
    status: { type: String, enum: ['draft', 'pending_review', 'published', 'rejected', 'hidden', 'archived'], default: 'draft' },
    rejectionReason: String,
    hiddenReason: String,
    moderationHistory: [{ at: Date, by: { type: Schema.Types.ObjectId, ref: 'User' }, action: String, note: String }],
    promotedUntil: Date, // sponsored placement — always labelled
    publishedAt: Date,
    soldCount: { type: Number, default: 0 },
    viewCount: { type: Number, default: 0 },
    reportCount: { type: Number, default: 0 },
    isSeedData: { type: Boolean, default: false },
  },
  { timestamps: true }
);
productSchema.index({ slug: 1 }, { unique: true });
productSchema.index({ status: 1, categoryId: 1, priceKobo: 1 });
productSchema.index({ status: 1, publishedAt: -1 });
productSchema.index({ status: 1, kind: 1, condition: 1 });
productSchema.index({ sellerId: 1, status: 1 });
productSchema.index({ title: 'text', description: 'text', brand: 'text' }, { weights: { title: 10, brand: 5, description: 1 }, name: 'product_text' });
productSchema.path('priceKobo').validate(Number.isSafeInteger, 'price must be integer kobo');

const productReportSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true },
    reporterId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    category: { type: String, enum: ['prohibited_item', 'fraud', 'stolen_goods', 'misleading', 'wrong_category', 'offensive', 'other'], required: true },
    details: { type: String, maxlength: 1000 },
    status: { type: String, enum: ['open', 'actioned', 'dismissed'], default: 'open' },
    reviewedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true }
);
productReportSchema.index({ productId: 1, reporterId: 1 }, { unique: true });
productReportSchema.index({ status: 1, createdAt: -1 });

const savedProductSchema = new Schema({ userId: { type: Schema.Types.ObjectId, required: true }, productId: { type: Schema.Types.ObjectId, ref: 'Product', required: true } }, { timestamps: true });
savedProductSchema.index({ userId: 1, productId: 1 }, { unique: true });

const savedSearchSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    scope: { type: String, enum: ['products', 'properties'], required: true },
    name: { type: String, maxlength: 80 },
    query: Schema.Types.Mixed,
    alertsEnabled: { type: Boolean, default: false },
    alertFrequency: { type: String, enum: ['instant', 'daily', 'weekly'], default: 'daily' },
    lastNotifiedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);
savedSearchSchema.index({ userId: 1, scope: 1 });
savedSearchSchema.index({ alertsEnabled: 1, scope: 1 });

const cartSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, required: true },
    items: [{ productId: { type: Schema.Types.ObjectId, ref: 'Product' }, quantity: { type: Number, min: 1, max: 50 }, addedAt: Date }],
  },
  { timestamps: true }
);
cartSchema.index({ userId: 1 }, { unique: true });

/**
 * Order (single seller per order; a checkout may create several orders paid together).
 */
const ORDER_STATES = [
  'pending_payment', 'payment_processing', 'paid', 'processing', 'ready_for_collection', 'ready_for_dispatch', 'dispatched',
  'delivered', 'collected', 'cancelled', 'refund_requested', 'partially_refunded', 'refunded', 'disputed', 'settlement_pending', 'settled', 'delivery_failed',
];
const orderSchema = new Schema(
  {
    orderNumber: { type: String, required: true },
    checkoutId: { type: Schema.Types.ObjectId, ref: 'Checkout', required: true },
    buyerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    sellerId: { type: Schema.Types.ObjectId, ref: 'User' }, // null = MubaPay
    sellerKind: { type: String, enum: ['platform', 'used_seller'], required: true },
    items: [{
      productId: { type: Schema.Types.ObjectId, ref: 'Product' }, title: String, slug: String, image: String, condition: String,
      unitPriceKobo: Number, quantity: Number, lineTotalKobo: Number,
    }],
    subtotalKobo: { type: Number, required: true },
    deliveryFeeKobo: { type: Number, default: 0 },
    totalKobo: { type: Number, required: true },
    refundedKobo: { type: Number, default: 0 },
    fulfilmentMethod: { type: String, enum: ['delivery', 'collection'], required: true },
    address: { recipientName: String, phone: String, line1: String, line2: String, city: String, lga: String, state: String, landmark: String, lat: Number, lng: Number },
    collectionPoint: { id: String, name: String, address: String, state: String },
    deliveryQuote: { provider: String, quoteRef: String, serviceCode: String, courierId: String, courierName: String, feeKobo: Number, etaText: String, expiresAt: Date },
    deliveryRequestId: { type: Schema.Types.ObjectId, ref: 'DeliveryRequest' },
    terms: {
      commissionBp: Number, refundWindowDays: Number, settlementHoldHours: Number,
      policyVersions: Schema.Types.Mixed,
    },
    status: { type: String, enum: ORDER_STATES, default: 'pending_payment' },
    statusBeforeHold: String, // where to resume after a dispute/refund request is closed
    statusHistory: [{ at: Date, status: String, by: { type: Schema.Types.ObjectId, ref: 'User' }, note: String }],
    paidAt: Date,
    deliveredAt: Date,
    settlementEligibleAt: Date,
    settledAt: Date,
    fulfilmentEvidence: [{ at: Date, type: { type: String }, note: String, by: { type: Schema.Types.ObjectId, ref: 'User' }, ref: String }],
    pickup: {
      codeHash: { type: String, select: false },
      qrTokenHash: { type: String, select: false },
      issuedAt: Date,
      expiresAt: Date,
      usedAt: Date,
      confirmedBy: { type: Schema.Types.ObjectId, ref: 'User' },
      method: { type: String, enum: ['code', 'qr', 'staff_assisted'] },
      failedAttempts: { type: Number, default: 0 },
    },
    cancelledReason: String,
    isSeedData: Boolean,
  },
  { timestamps: true }
);
orderSchema.index({ orderNumber: 1 }, { unique: true });
orderSchema.index({ buyerId: 1, createdAt: -1 });
orderSchema.index({ sellerId: 1, status: 1, createdAt: -1 });
orderSchema.index({ checkoutId: 1 });
orderSchema.index({ status: 1, settlementEligibleAt: 1 });
orderSchema.index({ status: 1, createdAt: 1 });

/** A checkout groups orders paid together with one payment. */
const checkoutSchema = new Schema(
  {
    buyerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    idempotencyKey: { type: String, required: true },
    orderIds: [{ type: Schema.Types.ObjectId, ref: 'Order' }],
    totalKobo: { type: Number, required: true },
    paymentMethod: { type: String, enum: ['wallet', 'paystack'], required: true },
    paymentReference: String,
    status: { type: String, enum: ['pending_payment', 'payment_processing', 'paid', 'expired', 'cancelled'], default: 'pending_payment' },
    expiresAt: Date,
    inventoryReleased: { type: Boolean, default: false },
  },
  { timestamps: true }
);
checkoutSchema.index({ buyerId: 1, idempotencyKey: 1 }, { unique: true });
checkoutSchema.index({ status: 1, expiresAt: 1 });

const deliveryRequestSchema = new Schema(
  {
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    provider: { type: String, required: true },
    quote: Schema.Types.Mixed,
    quotedFeeKobo: Number,
    shipmentRef: String,
    trackingUrl: String,
    providerStatus: String,
    status: { type: String, enum: ['pending_booking', 'booking_failed', 'booked', 'in_transit', 'delivered', 'failed', 'redelivery_scheduled', 'cancelled'], default: 'pending_booking' },
    attempts: { type: Number, default: 0 },
    redeliveryCount: { type: Number, default: 0 },
    failure: { reason: String, at: Date },
    evidence: [{ at: Date, type: { type: String }, note: String, ref: String, by: { type: Schema.Types.ObjectId, ref: 'User' } }],
    lastTrackedAt: Date,
    lastProviderEventAt: Date, // provider-side timestamp of the newest applied event (stale events are ignored)
    manual: { type: Boolean, default: false },
  },
  { timestamps: true }
);
deliveryRequestSchema.index({ orderId: 1 });
deliveryRequestSchema.index({ provider: 1, shipmentRef: 1 }, { unique: true, partialFilterExpression: { shipmentRef: { $type: 'string' } } });
deliveryRequestSchema.index({ status: 1, updatedAt: 1 });

const deliveryEventSchema = new Schema(
  {
    deliveryRequestId: { type: Schema.Types.ObjectId, ref: 'DeliveryRequest', required: true },
    source: { type: String, enum: ['webhook', 'poll', 'manual', 'system'], required: true },
    eventKey: { type: String, required: true },
    status: String,
    providerStatus: String,
    note: String,
    by: { type: Schema.Types.ObjectId, ref: 'User' },
    at: { type: Date, default: Date.now },
  },
  { versionKey: false }
);
deliveryEventSchema.index({ deliveryRequestId: 1, at: -1 });
deliveryEventSchema.index({ eventKey: 1 }, { unique: true });

const refundRequestSchema = new Schema(
  {
    reference: { type: String, required: true },
    subjectType: { type: String, enum: ['order', 'appointment'], required: true },
    subjectId: { type: Schema.Types.ObjectId, required: true },
    requesterId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    amountKobo: { type: Number, required: true },
    reason: { type: String, enum: ['not_received', 'damaged', 'not_as_described', 'wrong_item', 'cancelled_before_dispatch', 'provider_cancelled', 'other'], required: true },
    description: { type: String, maxlength: 2000 },
    evidence: [{ type: { type: String }, ref: String, note: String }],
    destination: { type: String, enum: ['wallet', 'original_method'], default: 'wallet' },
    status: { type: String, enum: ['pending_review', 'approved', 'rejected', 'processing', 'completed', 'failed'], default: 'pending_review' },
    decision: { by: { type: Schema.Types.ObjectId, ref: 'User' }, at: Date, note: String },
    providerRefundId: String,
    ledgerReference: String,
    history: [{ at: Date, status: String, by: { type: Schema.Types.ObjectId, ref: 'User' }, note: String }],
  },
  { timestamps: true }
);
refundRequestSchema.index({ reference: 1 }, { unique: true });
refundRequestSchema.index({ subjectType: 1, subjectId: 1 });
refundRequestSchema.index({ status: 1, createdAt: -1 });

const disputeSchema = new Schema(
  {
    reference: { type: String, required: true },
    subjectType: { type: String, enum: ['order', 'appointment'], required: true },
    subjectId: { type: Schema.Types.ObjectId, required: true },
    raisedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    counterpartyId: { type: Schema.Types.ObjectId, ref: 'User' },
    reason: { type: String, required: true, maxlength: 120 },
    description: { type: String, maxlength: 4000 },
    status: { type: String, enum: ['open', 'under_review', 'resolved_for_customer', 'resolved_for_provider', 'withdrawn'], default: 'open' },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },
    statements: [{ by: { type: Schema.Types.ObjectId, ref: 'User' }, role: String, text: { type: String, maxlength: 4000 }, at: Date }],
    resolution: { by: { type: Schema.Types.ObjectId, ref: 'User' }, at: Date, note: String, refundKobo: Number },
  },
  { timestamps: true }
);
disputeSchema.index({ reference: 1 }, { unique: true });
disputeSchema.index({ subjectType: 1, subjectId: 1 });
disputeSchema.index({ status: 1, createdAt: -1 });

const sellerSettlementSchema = new Schema(
  {
    reference: { type: String, required: true },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true },
    sellerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    grossKobo: Number,
    commissionKobo: Number,
    netKobo: { type: Number, required: true },
    status: { type: String, enum: ['pending_release', 'released', 'on_hold'], default: 'pending_release' },
    holdReason: String,
    releasedAt: Date,
    releasedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    ledgerReference: String,
  },
  { timestamps: true }
);
sellerSettlementSchema.index({ reference: 1 }, { unique: true });
sellerSettlementSchema.index({ orderId: 1 }, { unique: true });
sellerSettlementSchema.index({ sellerId: 1, status: 1 });

const m = (name, schema) => mongoose.models[name] || mongoose.model(name, schema);
module.exports = {
  Category: m('Category', categorySchema),
  Product: m('Product', productSchema),
  ProductReport: m('ProductReport', productReportSchema),
  SavedProduct: m('SavedProduct', savedProductSchema),
  SavedSearch: m('SavedSearch', savedSearchSchema),
  Cart: m('Cart', cartSchema),
  Order: m('Order', orderSchema),
  Checkout: m('Checkout', checkoutSchema),
  DeliveryRequest: m('DeliveryRequest', deliveryRequestSchema),
  DeliveryEvent: m('DeliveryEvent', deliveryEventSchema),
  RefundRequest: m('RefundRequest', refundRequestSchema),
  Dispute: m('Dispute', disputeSchema),
  SellerSettlement: m('SellerSettlement', sellerSettlementSchema),
  ORDER_STATES,
};
