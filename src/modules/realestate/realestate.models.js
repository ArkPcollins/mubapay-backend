'use strict';
const { mongoose } = require('../../lib/db');
const { Schema } = mongoose;

const media = new Schema({ url: String, publicId: String, caption: String, kind: { type: String, enum: ['photo', 'site_photo', 'floor_plan', 'tour_360', 'walkthrough_3d'] } }, { _id: true });

const propertySchema = new Schema(
  {
    title: { type: String, required: true, maxlength: 140 },
    slug: { type: String, required: true },
    description: { type: String, required: true, maxlength: 6000 },
    listingType: { type: String, enum: ['rent', 'sale', 'land'], required: true },
    propertyType: { type: String, enum: ['apartment', 'self_contain', 'mini_flat', 'bungalow', 'duplex', 'terrace', 'detached', 'commercial', 'shop', 'land'], required: true },
    priceKobo: { type: Number, required: true, min: 0 },
    rentPeriod: { type: String, enum: ['yearly', 'monthly', null], default: null },
    location: {
      addressPrivate: { type: String, maxlength: 300 }, // revealed only to confirmed viewers
      area: { type: String, maxlength: 120 },
      city: { type: String, required: true },
      lga: String,
      state: { type: String, required: true },
      geo: { type: { type: String, enum: ['Point'], default: 'Point' }, coordinates: { type: [Number], default: undefined } }, // [lng, lat], approximate
    },
    bedrooms: { type: Number, min: 0, max: 50 },
    bathrooms: { type: Number, min: 0, max: 50 },
    landSizeSqm: { type: Number, min: 0 },
    amenities: [{ type: String, maxlength: 40 }],
    furnishing: { type: String, enum: ['unfurnished', 'semi_furnished', 'furnished', null], default: null },
    availability: { status: { type: String, enum: ['available', 'under_offer', 'let', 'sold'], default: 'available' }, availableFrom: Date },
    media: { type: [media], default: [] },
    plan2d: { type: Schema.Types.Mixed }, // interactive 2D plan (rooms/polygons JSON) — rendered only when provided
    mediaTypes: [String], // derived: which viewers to show
    viewingFee: { required: { type: Boolean, default: false }, amountKobo: { type: Number, default: 0 } },
    managers: [{ userId: { type: Schema.Types.ObjectId, ref: 'User' }, role: { type: String, enum: ['owner', 'agent'] }, authorizedBy: { type: Schema.Types.ObjectId, ref: 'User' }, authorizedAt: Date, status: { type: String, enum: ['active', 'revoked'], default: 'active' } }],
    submittedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    listingAuthority: { basis: { type: String, enum: ['owner', 'agent_mandate'], required: true }, notes: String, verifiedAt: Date, verifiedBy: { type: Schema.Types.ObjectId, ref: 'User' } },
    status: { type: String, enum: ['draft', 'pending_review', 'published', 'rejected', 'archived', 'hidden'], default: 'draft' },
    rejectionReason: String,
    moderationHistory: [{ at: Date, by: { type: Schema.Types.ObjectId, ref: 'User' }, action: String, note: String }],
    publishedAt: Date,
    promotedUntil: Date,
    stats: { views: { type: Number, default: 0 }, enquiries: { type: Number, default: 0 }, viewingRequests: { type: Number, default: 0 } },
    isSeedData: Boolean,
  },
  { timestamps: true }
);
propertySchema.index({ slug: 1 }, { unique: true });
propertySchema.index({ status: 1, listingType: 1, 'location.state': 1, priceKobo: 1 });
propertySchema.index({ status: 1, publishedAt: -1 });
propertySchema.index({ 'managers.userId': 1, status: 1 });
propertySchema.index({ 'location.geo': '2dsphere' }, { sparse: true });
propertySchema.index({ title: 'text', description: 'text', 'location.area': 'text', 'location.city': 'text' }, { name: 'property_text' });

const savedPropertySchema = new Schema({ userId: { type: Schema.Types.ObjectId, required: true }, propertyId: { type: Schema.Types.ObjectId, ref: 'Property', required: true } }, { timestamps: true });
savedPropertySchema.index({ userId: 1, propertyId: 1 }, { unique: true });

const APPT_STATES = ['requested', 'proposed', 'awaiting_payment', 'confirmed', 'completed', 'cancelled_by_customer', 'cancelled_by_provider', 'no_show_customer', 'no_show_provider', 'disputed', 'expired', 'declined'];
const appointmentSchema = new Schema(
  {
    reference: { type: String, required: true },
    propertyId: { type: Schema.Types.ObjectId, ref: 'Property', required: true },
    customerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    providerId: { type: Schema.Types.ObjectId, ref: 'User', required: true }, // manager who handles the viewing
    requestedSlots: [Date],
    proposedSlots: [Date],
    scheduledAt: Date,
    note: { type: String, maxlength: 500 },
    status: { type: String, enum: APPT_STATES, default: 'requested' },
    statusBeforeHold: String,
    fee: {
      amountKobo: { type: Number, default: 0 },
      status: { type: String, enum: ['none', 'pending_payment', 'paid', 'released', 'refunded', 'partially_refunded'], default: 'none' },
      paymentMethod: { type: String, enum: ['wallet', 'paystack'] },
      paymentReference: String,
      commissionBp: Number,
      cancellationHours: Number,
      releaseHoursAfter: Number,
      refundedKobo: { type: Number, default: 0 },
      releasedAt: Date,
    },
    attendance: { customerConfirmedAt: Date, providerConfirmedAt: Date },
    noShowReport: { by: { type: Schema.Types.ObjectId, ref: 'User' }, party: String, at: Date, note: String },
    cancellation: { by: { type: Schema.Types.ObjectId, ref: 'User' }, party: String, at: Date, reason: String, refundKobo: Number, policyApplied: String },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation' },
    history: [{ at: Date, status: String, by: { type: Schema.Types.ObjectId, ref: 'User' }, note: String }],
    remindersSent: [String],
  },
  { timestamps: true }
);
appointmentSchema.index({ reference: 1 }, { unique: true });
appointmentSchema.index({ customerId: 1, createdAt: -1 });
appointmentSchema.index({ providerId: 1, status: 1, scheduledAt: 1 });
appointmentSchema.index({ propertyId: 1, scheduledAt: 1 });
appointmentSchema.index({ status: 1, scheduledAt: 1 });

const m = (n, s) => mongoose.models[n] || mongoose.model(n, s);
module.exports = { Property: m('Property', propertySchema), SavedProperty: m('SavedProperty', savedPropertySchema), ViewingAppointment: m('ViewingAppointment', appointmentSchema), APPT_STATES };
