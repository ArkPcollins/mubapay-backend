'use strict';
const pino = require('pino');
const config = require('../config');

/**
 * Structured logger. Redaction paths make sure secrets, passwords, OTPs,
 * tokens and card/bank data never reach log sinks even if accidentally logged.
 */
const logger = pino({
  level: config.isTest ? process.env.TEST_LOG_LEVEL || 'silent' : config.LOG_LEVEL,
  base: { service: 'mubapay-api', env: config.APP_ENV },
  redact: {
    paths: [
      'password', '*.password', '*.newPassword', '*.currentPassword',
      'token', '*.token', '*.refreshToken', '*.accessToken', '*.idToken', '*.credential',
      '*.otp', '*.code', '*.totp', '*.recoveryCode',
      'req.headers.authorization', 'req.headers.cookie', 'req.headers["x-paystack-signature"]',
      'res.headers["set-cookie"]',
      '*.secret', '*.apiKey', '*.api_key', '*.authorization_code', '*.account_number', '*.accountNumber',
      '*.bvn', '*.nin', '*.idNumber',
    ],
    censor: '[REDACTED]',
  },
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;
