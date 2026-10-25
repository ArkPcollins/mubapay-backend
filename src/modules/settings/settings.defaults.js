'use strict';
/**
 * Default platform settings. All money in kobo, percentages in basis points.
 * Stored overrides (PlatformSetting collection) are deep-merged over these.
 * Every value here is configurable by an authorised superadmin and changes
 * are versioned + audited. Fees/terms are snapshotted onto records at the
 * time a customer accepts them, so changes apply prospectively only.
 */
const NGN = (n) => n * 100;

module.exports = {
  branding: {
    appName: 'MubaPay',
    supportEmail: 'support@example.com',
    supportWhatsApp: null,
    primaryColor: '#0E7C66',
  },
  fees: {
    funding: { type: 'none' },
    transfer: { type: 'none' }, // transfers are free at launch
    withdrawal: { type: 'none' },
    marketplaceCommission: { type: 'percent', bp: 500 }, // 5% on used-item sales
    viewingFeeCommission: { type: 'percent', bp: 1000 }, // 10% of viewing fees
    propertyPromotion: { type: 'fixed', fixedKobo: NGN(5000) },
  },
  /** Ceilings the superadmin sets for what any fee/penalty may be configured to. */
  feeCaps: {
    maxPercentBp: 2000,
    maxFixedKobo: NGN(50000),
    earlyExitMaxBp: 1000,
    earlyExitMaxFixedKobo: NGN(10000),
    maxViewingFeeKobo: NGN(20000),
  },
  limits: {
    tiers: {
      0: { fundingPerTx: 0, fundingDaily: 0, fundingMonthly: 0, transferPerTx: 0, transferDaily: 0, withdrawalPerTx: 0, withdrawalDaily: 0, withdrawalMonthly: 0, savingsContributionPerTx: 0 },
      1: { fundingPerTx: NGN(50000), fundingDaily: NGN(50000), fundingMonthly: NGN(200000), transferPerTx: NGN(20000), transferDaily: NGN(50000), withdrawalPerTx: 0, withdrawalDaily: 0, withdrawalMonthly: 0, savingsContributionPerTx: NGN(50000) },
      2: { fundingPerTx: NGN(1000000), fundingDaily: NGN(2000000), fundingMonthly: NGN(10000000), transferPerTx: NGN(500000), transferDaily: NGN(1000000), withdrawalPerTx: NGN(500000), withdrawalDaily: NGN(1000000), withdrawalMonthly: NGN(5000000), savingsContributionPerTx: NGN(1000000) },
      3: { fundingPerTx: NGN(5000000), fundingDaily: NGN(10000000), fundingMonthly: NGN(50000000), transferPerTx: NGN(2000000), transferDaily: NGN(5000000), withdrawalPerTx: NGN(2000000), withdrawalDaily: NGN(5000000), withdrawalMonthly: NGN(20000000), savingsContributionPerTx: NGN(5000000) },
    },
    minFundingKobo: NGN(100),
    minWithdrawalKobo: NGN(1000),
  },
  verification: {
    // tier 1 = email + phone verified; tier 2 = identity approved; tier 3 = enhanced review
    financialMinTier: 1,
    withdrawalMinTier: 2,
    usedSellerMinTier: 2,
    acceptedIdTypes: ['nin_slip', 'national_id_card', 'drivers_licence', 'international_passport', 'voters_card'],
  },
  risk: {
    holdTransferAboveKobo: NGN(300000),
    dualApprovalWithdrawalAboveKobo: NGN(1000000),
    dualApprovalAdjustmentAlways: true,
    maxTransfersPerHour: 10,
    newAccountHoldDays: 0,
  },
  savings: {
    allowedFrequencies: ['daily', 'weekly', 'monthly'],
    minDurationDays: 30,
    maxDurationDays: 730,
    minContributionKobo: NGN(100),
    graceDays: 3,
    reminderHoursBefore: 24,
    maxConsecutiveMissedBeforePause: 3,
  },
  marketplace: {
    reportAutoHideDistinctReporters: 5,
    reportAutoHideSeriousCategories: ['prohibited_item', 'fraud', 'stolen_goods'],
    reportAutoHideSeriousThreshold: 2,
    settlementHoldHoursAfterDelivery: 72,
    refundRequestWindowDays: 7,
    paymentTimeoutMinutes: 30,
    collectionCodeTtlDays: 14,
  },
  delivery: {
    coverageStates: ['Anambra', 'Enugu', 'Imo'],
    providerPriority: ['shipbubble', 'configured_rate'],
    selectionStrategy: 'cheapest', // cheapest | fastest | priority
    configuredRates: [
      // Explicit, operator-configured pricing rules used when no live quote provider is configured.
      { fromState: 'Anambra', toState: 'Anambra', feeKobo: NGN(2000), etaDays: 1 },
      { fromState: 'Enugu', toState: 'Enugu', feeKobo: NGN(2000), etaDays: 1 },
      { fromState: 'Imo', toState: 'Imo', feeKobo: NGN(2000), etaDays: 1 },
      { fromState: 'Anambra', toState: 'Enugu', feeKobo: NGN(3500), etaDays: 2 },
      { fromState: 'Anambra', toState: 'Imo', feeKobo: NGN(3500), etaDays: 2 },
      { fromState: 'Enugu', toState: 'Anambra', feeKobo: NGN(3500), etaDays: 2 },
      { fromState: 'Enugu', toState: 'Imo', feeKobo: NGN(4000), etaDays: 2 },
      { fromState: 'Imo', toState: 'Anambra', feeKobo: NGN(3500), etaDays: 2 },
      { fromState: 'Imo', toState: 'Enugu', feeKobo: NGN(4000), etaDays: 2 },
    ],
    configuredRateEnabled: true,
    maxRedeliveryAttempts: 2,
    collectionPoints: [
      { id: 'awka-hub', name: 'MubaPay Awka Hub', address: 'To be configured', state: 'Anambra' },
    ],
    defaultOrigin: { state: 'Anambra', city: 'Awka', addressCode: null },
  },
  property: {
    viewingCancellationHours: 24,
    viewingFeeReleaseHoursAfter: 24,
    noShowReportWindowHours: 48,
    maxMediaPerListing: 30,
  },
  notifications: {
    mandatoryCategories: ['security', 'financial'],
  },
  security: {
    staffTwoFactorRequired: true,
    maxFailedLogins: 5,
    lockMinutes: 15,
    ipLoginAttemptsPerHour: 50,
  },
  compliance: {
    // Must be explicitly confirmed (with a reference to the licence/partner arrangement)
    // before wallet custody, savings and settlement features can run in production.
    walletOperationsAuthorized: false,
    authorizationReference: null,
    savingsAuthorized: false,
    settlementHoldingAuthorized: false,
  },
  maintenance: {
    enabled: false,
    message: 'Scheduled maintenance in progress.',
  },
};
