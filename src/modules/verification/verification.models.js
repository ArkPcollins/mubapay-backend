'use strict';
const { mongoose } = require('../../lib/db');
const { Schema } = mongoose;

/** Private document reference (file lives in encrypted private storage). */
const privateDocumentSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    category: { type: String, enum: ['identity', 'selfie', 'proof_of_address', 'ownership', 'agent_authority', 'agreement', 'other'], required: true },
    subjectType: { type: String, enum: ['identity_verification', 'role_application', 'property'], required: true },
    subjectId: { type: Schema.Types.ObjectId, required: true },
    storageKey: { type: String, required: true, select: false },
    contentType: String,
    sizeBytes: Number,
    sha256: String,
    originalName: String,
    deletedAt: Date,
  },
  { timestamps: true }
);
privateDocumentSchema.index({ subjectType: 1, subjectId: 1 });
privateDocumentSchema.index({ ownerId: 1 });

/** Identity verification (manual review). */
const identityVerificationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    legalFirstName: { type: String, required: true },
    legalLastName: { type: String, required: true },
    dateOfBirthEnc: { type: String, select: false },
    idType: { type: String, required: true },
    idNumberEnc: { type: String, select: false },
    idNumberLast4: String,
    address: { line1: String, city: String, state: String },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'resubmission_required', 'withdrawn'], default: 'pending' },
    attempt: { type: Number, default: 1 },
    reviewerId: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewerNotes: String, // internal
    customerMessage: String, // shown to customer
    reviewedAt: Date,
    appeal: { text: String, at: Date },
    history: [{ at: Date, status: String, by: { type: Schema.Types.ObjectId, ref: 'User' }, note: String }],
  },
  { timestamps: true }
);
identityVerificationSchema.index({ userId: 1, createdAt: -1 });
identityVerificationSchema.index({ status: 1, createdAt: 1 });

/** Applications to activate landlord / agent capabilities. */
const roleApplicationSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    role: { type: String, enum: ['landlord', 'agent'], required: true },
    businessName: String,
    registrationNumber: String, // e.g. CAC number for agencies
    professionalBody: String, // e.g. estate agent association membership
    yearsExperience: Number,
    operatingStates: [String],
    statement: { type: String, maxlength: 2000 },
    status: { type: String, enum: ['pending', 'approved', 'rejected', 'resubmission_required'], default: 'pending' },
    reviewerId: { type: Schema.Types.ObjectId, ref: 'User' },
    reviewerNotes: String,
    customerMessage: String,
    reviewedAt: Date,
    history: [{ at: Date, status: String, by: { type: Schema.Types.ObjectId, ref: 'User' }, note: String }],
  },
  { timestamps: true }
);
roleApplicationSchema.index({ userId: 1, role: 1, createdAt: -1 });
roleApplicationSchema.index({ status: 1, createdAt: 1 });

const m = (n, s) => mongoose.models[n] || mongoose.model(n, s);
module.exports = { PrivateDocument: m('PrivateDocument', privateDocumentSchema), IdentityVerification: m('IdentityVerification', identityVerificationSchema), RoleApplication: m('RoleApplication', roleApplicationSchema) };
