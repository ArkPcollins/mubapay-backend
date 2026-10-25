'use strict';
const { mongoose } = require('../../lib/db');
const { Schema } = mongoose;

const SLUGS = [
  'terms_of_service', 'privacy_policy', 'cookie_policy', 'wallet_terms', 'savings_terms', 'marketplace_refund_policy',
  'delivery_policy', 'property_viewing_policy', 'prohibited_items_policy', 'dispute_resolution',
];

/** Versioned legal documents. Published versions are never edited — publish a new version instead. */
const legalDocumentSchema = new Schema(
  {
    slug: { type: String, enum: SLUGS, required: true },
    version: { type: Number, required: true },
    title: { type: String, required: true },
    content: { type: String, required: true },
    summaryOfChanges: String,
    material: { type: Boolean, default: false }, // material change → renewed acceptance required
    status: { type: String, enum: ['draft', 'published', 'superseded'], default: 'draft' },
    effectiveAt: Date,
    publishedAt: Date,
    publishedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewedByProfessional: { type: Boolean, default: false },
  },
  { timestamps: true }
);
legalDocumentSchema.index({ slug: 1, version: -1 }, { unique: true });
legalDocumentSchema.index({ slug: 1, status: 1 });
legalDocumentSchema.pre(['updateOne', 'findOneAndUpdate'], function guard(next) {
  // allow only status transitions on published docs (published → superseded)
  const u = this.getUpdate() || {};
  const keys = Object.keys(u.$set || {});
  if (this.getFilter()?.status === 'published' && keys.some((k) => !['status'].includes(k))) return next(new Error('Published legal documents are immutable'));
  next();
});

/** Evidence of acceptance. Append-only. */
const consentRecordSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    kind: { type: String, enum: ['policy_acceptance', 'marketing_email', 'cookies', 'financial_commitment'], required: true },
    documentSlug: String,
    documentVersion: Number,
    granted: { type: Boolean, default: true },
    context: String, // registration | checkout | savings_enrolment | ...
    statement: String, // exact text the user confirmed (financial commitments)
    relatedType: String,
    relatedId: String,
    ip: String,
    userAgent: String,
    at: { type: Date, default: Date.now },
  },
  { versionKey: false }
);
consentRecordSchema.index({ userId: 1, kind: 1, documentSlug: 1, at: -1 });
['updateOne', 'updateMany', 'findOneAndUpdate', 'deleteOne', 'deleteMany', 'findOneAndDelete'].forEach((op) =>
  consentRecordSchema.pre(op, (next) => next(new Error('Consent records are append-only')))
);

const LegalDocument = mongoose.models.LegalDocument || mongoose.model('LegalDocument', legalDocumentSchema);
const ConsentRecord = mongoose.models.ConsentRecord || mongoose.model('ConsentRecord', consentRecordSchema);
module.exports = { LegalDocument, ConsentRecord, SLUGS };
