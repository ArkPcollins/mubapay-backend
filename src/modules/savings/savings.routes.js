'use strict';
const express = require('express');
const { z } = require('zod');
const svc = require('./savings.service');
const { asyncHandler: h, validate, ok, created } = require('../../lib/http');
const { requireAuth, requireActive } = require('../../middleware/auth');
const { idempotent } = require('../../middleware/common');

/* Thin controllers: each handler validates input (above) and delegates to the savings service. */
const ctl = {
  plans: async (_req, res) => ok(res, await svc.listPlans()),
  list: async (req, res) => ok(res, await svc.listAccounts(req.user)),
  get: async (req, res) => ok(res, await svc.getAccount(req.user, req.params.id)),
  enroll: async (req, res) => created(res, await svc.enroll(req.user, req.body, req)),
  deposit: async (req, res) => created(res, await svc.manualDeposit(req.user, req.params.id, req.body, { idempotencyKey: req.idempotencyKey, req })),
  pause: async (req, res) => ok(res, await svc.pause(req.user, req.params.id)),
  resume: async (req, res) => ok(res, await svc.resume(req.user, req.params.id)),
  exitQuote: async (req, res) => ok(res, await svc.earlyExitQuote(req.user, req.params.id)),
  exit: async (req, res) => ok(res, await svc.earlyExit(req.user, req.params.id, req.body, req)),
};

const r = express.Router();
r.get('/plans', h(ctl.plans));
r.use(requireAuth);
r.get('/accounts', h(ctl.list));
r.get('/accounts/:id', h(ctl.get));
r.post('/accounts', requireActive, validate(z.object({
  planId: z.string().regex(/^[a-f0-9]{24}$/), name: z.string().max(80).optional(), targetKobo: z.number().int().positive().optional(), durationDays: z.number().int().positive(),
  frequency: z.enum(['daily', 'weekly', 'monthly']).optional(), amountKobo: z.number().int().positive().optional(), fundingSource: z.enum(['wallet', 'card']).optional(),
  savedCardId: z.string().regex(/^[a-f0-9]{24}$/).optional(), startDate: z.string().optional(), payoutPreference: z.enum(['wallet', 'bank']).optional(),
  payoutBankAccountId: z.string().regex(/^[a-f0-9]{24}$/).optional(), confirmTerms: z.boolean(), acceptedPolicies: z.array(z.object({ slug: z.string(), version: z.number().int() })).optional(),
})), h(ctl.enroll));
r.post('/accounts/:id/deposits', requireActive, idempotent('savings.deposit'), validate(z.object({ amountKobo: z.number().int().positive(), source: z.enum(['wallet', 'card']).default('wallet'), saveCard: z.boolean().optional() })), h(ctl.deposit));
r.post('/accounts/:id/pause', h(ctl.pause));
r.post('/accounts/:id/resume', h(ctl.resume));
r.get('/accounts/:id/early-exit', h(ctl.exitQuote));
r.post('/accounts/:id/early-exit', requireActive, validate(z.object({ confirmPenaltyKobo: z.number().int().min(0) })), h(ctl.exit));

module.exports = r;
