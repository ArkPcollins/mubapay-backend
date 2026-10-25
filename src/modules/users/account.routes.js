'use strict';
const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const c = require('./account.controller');
const { asyncHandler: h, validate } = require('../../lib/http');
const { requireAuth } = require('../../middleware/auth');
const { limiter } = require('../../middleware/common');

const r = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 6 } });
const docLimit = limiter({ name: 'docs', windowMs: 60 * 60e3, max: 20, keyBy: 'user' });

const address = z.object({
  label: z.string().max(60).optional(), recipientName: z.string().max(120).optional(), phone: z.string().max(20).optional(),
  line1: z.string().min(3).max(200), line2: z.string().max(200).optional(), city: z.string().min(2).max(80), lga: z.string().max(80).optional(),
  state: z.string().min(2).max(60), landmark: z.string().max(200).optional(), lat: z.number().optional(), lng: z.number().optional(), isDefault: z.boolean().optional(),
});

r.get('/unsubscribe', h(c.unsubscribe));
r.use(requireAuth);
r.patch('/profile', validate(z.object({ firstName: z.string().min(1).max(80).optional(), lastName: z.string().min(1).max(80).optional(), phone: z.string().max(20).optional() })), h(c.updateProfile));
r.post('/addresses', validate(address), h(c.addAddress));
r.patch('/addresses/:id', validate(address.partial()), h(c.updateAddress));
r.delete('/addresses/:id', h(c.deleteAddress));
r.patch('/preferences', validate(z.object({ theme: z.enum(['light', 'dark', 'system']).optional(), language: z.string().max(5).optional(), notifications: z.record(z.object({ email: z.boolean().optional(), inApp: z.boolean().optional() })).optional(), marketingEmail: z.boolean().optional(), shareContactWithProviders: z.boolean().optional() })), h(c.preferences));
r.post('/onboarding', validate(z.object({ step: z.string().max(40), complete: z.boolean().optional() })), h(c.onboardingStep));
r.get('/terms/outstanding', h(c.outstandingTerms));
r.post('/terms/accept', validate(z.object({ acceptedPolicies: z.array(z.object({ slug: z.string(), version: z.number().int() })).min(1), context: z.string().max(40).optional() })), h(c.acceptTerms));

r.get('/verification', h(c.myVerification));
r.post('/verification', docLimit, upload.fields([{ name: 'idDocument', maxCount: 1 }, { name: 'selfie', maxCount: 1 }, { name: 'proofOfAddress', maxCount: 1 }]), (req, _res, next) => {
  req.body = { ...req.body, address: req.body.address ? safeJson(req.body.address) : undefined };
  next();
}, validate(z.object({ legalFirstName: z.string().min(1).max(80), legalLastName: z.string().min(1).max(80), dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), idType: z.string(), idNumber: z.string().min(4).max(40), address: z.object({ line1: z.string(), city: z.string(), state: z.string() }).optional() })), h(c.submitVerification));
r.post('/verification/:id/appeal', validate(z.object({ text: z.string().min(10).max(2000) })), h(c.appealVerification));
r.post('/role-applications', docLimit, upload.fields([{ name: 'documents', maxCount: 4 }]), (req, _res, next) => {
  if (typeof req.body.operatingStates === 'string') req.body.operatingStates = req.body.operatingStates.split(',').map((s) => s.trim()).filter(Boolean);
  if (req.body.yearsExperience) req.body.yearsExperience = Number(req.body.yearsExperience);
  next();
}, validate(z.object({ role: z.enum(['landlord', 'agent']), businessName: z.string().max(120).optional(), registrationNumber: z.string().max(40).optional(), professionalBody: z.string().max(120).optional(), yearsExperience: z.number().int().min(0).max(80).optional(), operatingStates: z.array(z.string()).max(37).optional(), statement: z.string().max(2000).optional() })), h(c.applyRole));
r.get('/role-applications', h(c.myRoleApplications));
r.post('/documents/:id/access', h(c.documentAccess));
r.get('/documents/download/:token', h(c.downloadDocument));

r.get('/closure', h(c.closureCheck));
r.post('/closure', validate(z.object({ password: z.string().max(128).optional(), confirm: z.string() })), h(c.close));
r.get('/export', limiter({ name: 'export', windowMs: 24 * 3600e3, max: 5, keyBy: 'user' }), h(c.exportData));
r.get('/statements/:kind/:format', h(c.statement));

function safeJson(s) {
  try {
    return typeof s === 'string' ? JSON.parse(s) : s;
  } catch {
    return undefined;
  }
}

module.exports = r;
