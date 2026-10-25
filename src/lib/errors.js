'use strict';

/** Application error with a stable machine-readable code and safe message. */
class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
    this.expose = true;
  }
}

const E = {
  badRequest: (msg = 'Bad request', details) => new AppError(400, 'BAD_REQUEST', msg, details),
  validation: (details) => new AppError(422, 'VALIDATION_ERROR', 'Some fields are invalid', details),
  unauthorized: (msg = 'Authentication required') => new AppError(401, 'UNAUTHORIZED', msg),
  forbidden: (msg = 'You do not have permission to perform this action') => new AppError(403, 'FORBIDDEN', msg),
  notFound: (what = 'Resource') => new AppError(404, 'NOT_FOUND', `${what} not found`),
  conflict: (msg = 'Conflict', code = 'CONFLICT', details) => new AppError(409, code, msg, details),
  insufficientFunds: () => new AppError(409, 'INSUFFICIENT_FUNDS', 'Insufficient available balance'),
  limitExceeded: (msg, details) => new AppError(409, 'LIMIT_EXCEEDED', msg, details),
  invalidState: (msg, details) => new AppError(409, 'INVALID_STATE_TRANSITION', msg, details),
  featureDisabled: (feature) => new AppError(503, 'FEATURE_DISABLED', `This feature (${feature}) is currently unavailable`),
  notConfigured: (integration, hint) =>
    new AppError(503, 'INTEGRATION_NOT_CONFIGURED', `${integration} is not configured on this server`, hint ? { hint } : undefined),
  provider: (msg = 'A payment or service provider did not respond as expected', details) =>
    new AppError(502, 'PROVIDER_ERROR', msg, details),
  providerUncertain: (msg = 'The provider outcome is not yet confirmed. We will keep checking.') =>
    new AppError(202, 'PROVIDER_OUTCOME_PENDING', msg),
  tooMany: (msg = 'Too many requests, please slow down') => new AppError(429, 'RATE_LIMITED', msg),
  verificationRequired: (msg = 'Account verification required for this action', details) =>
    new AppError(403, 'VERIFICATION_REQUIRED', msg, details),
  twoFactorRequired: () => new AppError(403, 'TWO_FACTOR_REQUIRED', 'Two-factor authentication is required'),
  maintenance: () => new AppError(503, 'MAINTENANCE', 'MubaPay is undergoing maintenance. Please try again shortly.'),
};

module.exports = { AppError, E };
