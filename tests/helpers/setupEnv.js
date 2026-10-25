'use strict';
/* Runs before each test file: isolated database + safe test configuration. */
const crypto = require('crypto');

const base = process.env.MONGODB_TEST_URI;
const dbName = `mubapay_test_${crypto.randomBytes(5).toString('hex')}`;
const url = new URL(base);
url.pathname = `/${dbName}`;
process.env.MONGODB_URI = url.toString();
process.env.APP_ENV = 'test';
process.env.NODE_ENV = 'test';
process.env.EMAIL_TRANSPORT = 'console';
process.env.PHONE_OTP_TRANSPORT = 'console';
process.env.PAYSTACK_MODE = 'test';
process.env.PAYSTACK_SECRET_KEY = process.env.PAYSTACK_SECRET_KEY || 'sk_test_mubapay_fake_secret_for_tests';
process.env.PAYSTACK_TRANSFERS_ENABLED = 'true';
process.env.PRIVATE_STORAGE_DIR = require('path').join(require('os').tmpdir(), `mubapay-private-${dbName}`);
process.env.RUN_WORKER_IN_PROCESS = 'false';
process.env.FRONTEND_URL = 'http://localhost:5173';
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.SHIPBUBBLE_API_KEY;
delete process.env.CLOUDINARY_CLOUD_NAME;
require('./variantEnv');
