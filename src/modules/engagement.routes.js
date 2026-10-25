'use strict';
/**
 * Messaging, notifications, support and public legal documents.
 * Thin controllers; all logic is in the respective services.
 */
const express = require('express');
const { z } = require('zod');
const messaging = require('./messaging/messaging.service');
const notifications = require('./notifications/notifications.service');
const support = require('./support/support.service');
const { LegalDocument, SLUGS } = require('./legal/legal.models');
const { asyncHandler: h, validate, ok, created } = require('../lib/http');
const { requireAuth } = require('../middleware/auth');
const { limiter } = require('../middleware/common');
const { E } = require('../lib/errors');
const config = require('../config');

const oid = z.string().regex(/^[a-f0-9]{24}$/);

// ---------------- legal (public)
const legal = express.Router();
legal.get('/', h(async (_req, res) => {
  const docs = await LegalDocument.aggregate([{ $match: { status: 'published' } }, { $sort: { version: -1 } }, { $group: { _id: '$slug', version: { $first: '$version' }, title: { $first: '$title' }, effectiveAt: { $first: '$effectiveAt' }, reviewedByProfessional: { $first: '$reviewedByProfessional' } } }]);
  ok(res, docs.map((d) => ({ slug: d._id, version: d.version, title: d.title, effectiveAt: d.effectiveAt, reviewedByProfessional: d.reviewedByProfessional })));
}));
legal.get('/:slug', h(async (req, res) => {
  if (!SLUGS.includes(req.params.slug)) throw E.notFound('Document');
  const filter = { slug: req.params.slug, status: { $in: ['published', 'superseded'] } };
  if (req.query.version) filter.version = Number(req.query.version);
  const doc = await LegalDocument.findOne(filter).sort({ version: -1 }).lean();
  if (!doc) throw E.notFound('Document');
  const versions = await LegalDocument.find({ slug: req.params.slug, status: { $in: ['published', 'superseded'] } }, { version: 1, effectiveAt: 1, summaryOfChanges: 1, status: 1 }).sort({ version: -1 }).lean();
  ok(res, { ...doc, versions });
}));

// ---------------- messaging
const msg = express.Router();
msg.use(requireAuth);
msg.get('/', h(async (req, res) => ok(res, await messaging.list(req.user))));
msg.get('/:id', h(async (req, res) => ok(res, await messaging.messages(req.user, req.params.id, req))));
msg.post('/:id/messages', limiter({ name: 'msg', windowMs: 60e3, max: 30, keyBy: 'user' }), validate(z.object({ body: z.string().min(1).max(2000) })), h(async (req, res) => created(res, await messaging.send(req.user, req.params.id, req.body.body, req))));
msg.post('/report', validate(z.object({ targetUserId: oid, conversationId: oid.optional(), messageId: oid.optional(), reason: z.enum(['spam', 'harassment', 'fraud', 'off_platform_payment', 'inappropriate', 'other']), details: z.string().max(1000).optional() })), h(async (req, res) => created(res, await messaging.reportUser(req.user, req.body))));
msg.post('/block', validate(z.object({ targetUserId: oid, block: z.boolean().default(true) })), h(async (req, res) => ok(res, await messaging.block(req.user, req.body.targetUserId, req.body.block))));

// ---------------- notifications
const notif = express.Router();
notif.use(requireAuth);
notif.get('/', h(async (req, res) => {
  const r = await notifications.list(req.user._id, { page: Number(req.query.page) || 1, limit: Math.min(50, Number(req.query.limit) || 20), unreadOnly: req.query.unread === 'true' });
  ok(res, r.items, r.meta);
}));
notif.post('/read', validate(z.object({ ids: z.union([z.literal('all'), z.array(oid).max(200)]) })), h(async (req, res) => ok(res, await notifications.markRead(req.user._id, req.body.ids))));

// ---------------- support
const sup = express.Router();
sup.get('/channels', h(async (_req, res) => ok(res, support.channels())));
// Brevo inbound parsing webhook — authenticated by a secret path segment (Brevo does not sign inbound webhooks).
sup.post('/inbound-email/:secret', express.json({ limit: '2mb' }), h(async (req, res) => {
  const expected = config.BREVO_INBOUND_SECRET;
  if (!expected || !require('../lib/crypto').safeEqual(req.params.secret, expected)) throw E.notFound('Route');
  const items = req.body?.items || [req.body];
  for (const it of items) await support.handleInboundEmail(it);
  ok(res, { received: items.length });
}));
sup.use(requireAuth);
sup.get('/tickets', h(async (req, res) => ok(res, await support.mine(req.user))));
sup.post('/tickets', limiter({ name: 'ticket', windowMs: 3600e3, max: 10, keyBy: 'user' }), validate(z.object({ category: z.enum(['financial', 'security', 'dispute', 'order', 'property', 'delivery', 'general', 'account']), subject: z.string().min(3).max(200), body: z.string().min(5).max(5000), related: z.object({ type: z.string().max(40), id: z.string().max(60) }).optional() })), h(async (req, res) => created(res, await support.create(req.user, req.body))));
sup.get('/tickets/:id', h(async (req, res) => ok(res, await support.get(req.user, req.params.id))));
sup.post('/tickets/:id/messages', limiter({ name: 'ticketmsg', windowMs: 60e3, max: 20, keyBy: 'user' }), validate(z.object({ body: z.string().min(1).max(5000) })), h(async (req, res) => ok(res, await support.reply(req.user, req.params.id, req.body.body, req))));
sup.post('/tickets/:id/status', validate(z.object({ status: z.enum(['resolved', 'closed', 'open', 'pending_customer', 'pending_staff']) })), h(async (req, res) => ok(res, await support.setStatus(req.user, req.params.id, req.body.status, req))));
sup.post('/tickets/:id/rating', validate(z.object({ score: z.number().int().min(1).max(5), comment: z.string().max(500).optional() })), h(async (req, res) => ok(res, await support.rate(req.user, req.params.id, req.body))));
sup.post('/live-chat', validate(z.object({ subject: z.string().max(200).optional(), category: z.enum(['financial', 'security', 'dispute', 'order', 'property', 'delivery', 'general', 'account']).optional() })), h(async (req, res) => created(res, await support.startLiveChat(req.user, req.body))));

module.exports = { legal, msg, notif, sup };
