'use strict';
const { mongoose } = require('../../lib/db');
const { Schema } = mongoose;

const platformSettingSchema = new Schema(
  {
    key: { type: String, required: true },
    value: { type: Schema.Types.Mixed, required: true },
    version: { type: Number, default: 1 },
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
  },
  { timestamps: true, minimize: false }
);
platformSettingSchema.index({ key: 1 }, { unique: true });

/** Immutable history of every settings version. */
const settingVersionSchema = new Schema(
  {
    key: { type: String, required: true },
    version: { type: Number, required: true },
    value: { type: Schema.Types.Mixed, required: true },
    previous: Schema.Types.Mixed,
    changedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    reason: String,
    effectiveFrom: { type: Date, default: Date.now },
  },
  { timestamps: true, minimize: false }
);
settingVersionSchema.index({ key: 1, version: -1 }, { unique: true });

const featureFlagSchema = new Schema(
  {
    key: { type: String, required: true },
    enabled: { type: Boolean, default: false },
    description: String,
    updatedBy: { type: Schema.Types.ObjectId, ref: 'User' },
    laterPhase: { type: Boolean, default: false },
  },
  { timestamps: true }
);
featureFlagSchema.index({ key: 1 }, { unique: true });

const PlatformSetting = mongoose.models.PlatformSetting || mongoose.model('PlatformSetting', platformSettingSchema);
const SettingVersion = mongoose.models.SettingVersion || mongoose.model('SettingVersion', settingVersionSchema);
const FeatureFlag = mongoose.models.FeatureFlag || mongoose.model('FeatureFlag', featureFlagSchema);
module.exports = { PlatformSetting, SettingVersion, FeatureFlag };
