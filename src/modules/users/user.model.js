'use strict';
const { mongoose } = require('../../lib/db');
const { Schema } = mongoose;

const ROLES = ['customer', 'landlord', 'agent', 'admin', 'superadmin'];

const addressSchema = new Schema(
  {
    label: { type: String, maxlength: 60 },
    recipientName: { type: String, maxlength: 120 },
    phone: { type: String, maxlength: 20 },
    line1: { type: String, required: true, maxlength: 200 },
    line2: { type: String, maxlength: 200 },
    city: { type: String, required: true, maxlength: 80 },
    lga: { type: String, maxlength: 80 },
    state: { type: String, required: true, maxlength: 60 },
    landmark: { type: String, maxlength: 200 },
    lat: Number,
    lng: Number,
    isDefault: { type: Boolean, default: false },
  },
  { _id: true, timestamps: true }
);

const notifPref = new Schema({ email: { type: Boolean, default: true }, inApp: { type: Boolean, default: true } }, { _id: false });

const userSchema = new Schema(
  {
    email: { type: String, required: true, lowercase: true, trim: true, maxlength: 254 },
    emailVerifiedAt: Date,
    phone: { type: String, trim: true, maxlength: 20 },
    phoneVerifiedAt: Date,
    passwordHash: { type: String, select: false },
    googleId: { type: String, select: false },
    firstName: { type: String, trim: true, maxlength: 80 },
    lastName: { type: String, trim: true, maxlength: 80 },
    roles: { type: [{ type: String, enum: ROLES }], default: ['customer'] },
    /** Approved non-staff capabilities. A single account may hold many. */
    capabilities: {
      usedSeller: { type: Boolean, default: false },
      landlord: { type: Boolean, default: false },
      agent: { type: Boolean, default: false },
    },
    staffPermissions: { type: [String], default: [] },
    verificationTier: { type: Number, default: 0, min: 0, max: 3 },
    kycStatus: { type: String, enum: ['none', 'pending', 'approved', 'rejected', 'resubmission_required'], default: 'none' },
    status: { type: String, enum: ['active', 'restricted', 'suspended', 'closed'], default: 'active' },
    restriction: { reason: String, by: { type: Schema.Types.ObjectId, ref: 'User' }, at: Date, scopes: [String] },
    twoFactor: {
      enabled: { type: Boolean, default: false },
      secretEnc: { type: String, select: false },
      pendingSecretEnc: { type: String, select: false },
      lastUsedStep: { type: Number, default: 0, select: false },
      recoveryCodeHashes: { type: [String], select: false, default: [] },
      enabledAt: Date,
    },
    security: {
      failedLoginCount: { type: Number, default: 0 },
      lockedUntil: Date,
      passwordChangedAt: Date,
      lastLoginAt: Date,
      lastLoginIp: String,
      knownDeviceHashes: { type: [String], default: [], select: false },
    },
    preferences: {
      theme: { type: String, enum: ['light', 'dark', 'system'], default: 'system' },
      language: { type: String, default: 'en' },
      notifications: { type: Map, of: notifPref, default: {} },
      marketingEmail: { type: Boolean, default: false },
      marketingUpdatedAt: Date,
    },
    privacy: {
      shareContactWithProviders: { type: Boolean, default: false },
    },
    addresses: { type: [addressSchema], default: [] },
    blockedUserIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    onboarding: { completedSteps: { type: [String], default: [] }, completedAt: Date },
    closedAt: Date,
    anonymizedAt: Date,
    isSeedData: { type: Boolean, default: false },
  },
  { timestamps: true }
);

userSchema.index({ email: 1 }, { unique: true });
userSchema.index({ googleId: 1 }, { unique: true, partialFilterExpression: { googleId: { $type: 'string' } } });
userSchema.index({ phone: 1 }, { unique: true, partialFilterExpression: { phoneVerifiedAt: { $type: 'date' } } });
userSchema.index({ roles: 1, status: 1 });
userSchema.index({ kycStatus: 1, updatedAt: -1 });
userSchema.index({ createdAt: -1 });

userSchema.virtual('fullName').get(function fullName() {
  return [this.firstName, this.lastName].filter(Boolean).join(' ');
});

userSchema.methods.isStaff = function isStaff() {
  return this.roles.includes('admin') || this.roles.includes('superadmin');
};

/** Public-safe projection of a user (self view). */
userSchema.methods.toSelf = function toSelf() {
  return {
    id: this._id.toString(),
    email: this.email,
    emailVerified: Boolean(this.emailVerifiedAt),
    phone: this.phone,
    phoneVerified: Boolean(this.phoneVerifiedAt),
    firstName: this.firstName,
    lastName: this.lastName,
    roles: this.roles,
    capabilities: this.capabilities,
    staffPermissions: this.isStaff() ? this.staffPermissions : undefined,
    verificationTier: this.verificationTier,
    kycStatus: this.kycStatus,
    status: this.status,
    twoFactorEnabled: Boolean(this.twoFactor?.enabled),
    preferences: {
      theme: this.preferences?.theme,
      language: this.preferences?.language,
      marketingEmail: this.preferences?.marketingEmail,
      notifications: Object.fromEntries(this.preferences?.notifications || []),
    },
    privacy: this.privacy,
    addresses: this.addresses,
    onboarding: this.onboarding,
    createdAt: this.createdAt,
  };
};

/** Minimal projection shown to counterparties (no contact details). */
userSchema.methods.toPublic = function toPublic() {
  return { id: this._id.toString(), displayName: [this.firstName, (this.lastName || '').slice(0, 1)].filter(Boolean).join(' ') + (this.lastName ? '.' : '') };
};

const User = mongoose.models.User || mongoose.model('User', userSchema);
module.exports = { User, ROLES };
