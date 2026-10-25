'use strict';
const express = require('express');
const { z } = require('zod');
const c = require('./wallet.controller');
const { asyncHandler: h, validate } = require('../../lib/http');
const { requireAuth, requireActive } = require('../../middleware/auth');
const { idempotent, limiter } = require('../../middleware/common');

const r = express.Router();
const kobo = z.number().int().positive().max(1e14);
const finLimit = limiter({ name: 'fin', windowMs: 60e3, max: 20, keyBy: 'user', message: 'Too many financial requests. Please wait a moment.' });
const policies = z.array(z.object({ slug: z.string(), version: z.number().int() })).optional();

r.use(requireAuth);
r.get('/', h(c.overview));
r.post('/fund', requireActive, finLimit, idempotent('wallet.fund'), validate(z.object({ amountKobo: kobo, acceptedPolicies: policies })), h(c.fund));
r.get('/payments/:reference', h(c.paymentStatus));
r.get('/recipient', h(c.lookup));
r.post('/transfers', requireActive, finLimit, idempotent('wallet.transfer'), validate(z.object({ recipient: z.string().min(3).max(254), amountKobo: kobo, narration: z.string().max(140).optional() })), h(c.transfer));
r.get('/banks', h(c.banks));
r.get('/bank-accounts', h(c.bankAccounts));
r.post('/bank-accounts', requireActive, finLimit, validate(z.object({ bankCode: z.string().min(2).max(10), bankName: z.string().max(100).optional(), accountNumber: z.string().regex(/^\d{10}$/) })), h(c.addBankAccount));
r.delete('/bank-accounts/:id', h(c.removeBankAccount));
r.post('/withdrawals', requireActive, finLimit, idempotent('wallet.withdraw'), validate(z.object({ amountKobo: kobo, bankAccountId: z.string().regex(/^[a-f0-9]{24}$/) })), h(c.withdraw));
r.get('/withdrawals', h(c.withdrawals));
r.get('/transactions', h(c.transactions));
r.get('/transactions/:reference', h(c.transaction));
r.get('/cards', h(c.cards));
r.delete('/cards/:id', h(c.removeCard));

module.exports = r;
