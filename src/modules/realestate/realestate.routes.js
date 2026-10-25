'use strict';
const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const props = require('./properties.service');
const appts = require('./appointments.service');
const geocoding = require('../../providers/geocoding/nominatim.adapter');
const { asyncHandler: h, validate, ok, created } = require('../../lib/http');
const { requireAuth, optionalAuth, requireActive } = require('../../middleware/auth');
const { idempotent, limiter } = require('../../middleware/common');

const media = z.object({ url: z.string().url(), publicId: z.string().optional(), caption: z.string().max(140).optional(), kind: z.enum(['photo', 'site_photo', 'floor_plan', 'tour_360', 'walkthrough_3d']) });
const listing = z.object({
  title: z.string().min(5).max(140), description: z.string().min(30).max(6000), listingType: z.enum(['rent', 'sale', 'land']),
  propertyType: z.enum(['apartment', 'self_contain', 'mini_flat', 'bungalow', 'duplex', 'terrace', 'detached', 'commercial', 'shop', 'land']),
  priceKobo: z.number().int().min(100), rentPeriod: z.enum(['yearly', 'monthly']).optional(),
  location: z.object({ addressPrivate: z.string().max(300).optional(), area: z.string().max(120).optional(), city: z.string().min(2), lga: z.string().optional(), state: z.string().min(2) }),
  lat: z.number().min(-90).max(90).optional(), lng: z.number().min(-180).max(180).optional(),
  bedrooms: z.number().int().min(0).max(50).optional(), bathrooms: z.number().int().min(0).max(50).optional(), landSizeSqm: z.number().min(0).optional(),
  amenities: z.array(z.string().max(40)).max(40).optional(), furnishing: z.enum(['unfurnished', 'semi_furnished', 'furnished']).optional(),
  availability: z.object({ status: z.enum(['available', 'under_offer', 'let', 'sold']).optional(), availableFrom: z.string().optional() }).optional(),
  media: z.array(media).max(40).optional(), plan2d: z.object({ rooms: z.array(z.object({ name: z.string().max(40), points: z.array(z.tuple([z.number(), z.number()])).min(3).max(50), areaSqm: z.number().optional() })).max(40) }).optional(),
  viewingFee: z.object({ required: z.boolean(), amountKobo: z.number().int().min(0) }).optional(),
  listingAuthority: z.object({ basis: z.enum(['owner', 'agent_mandate']), notes: z.string().max(1000).optional() }).optional(),
  submit: z.boolean().optional(),
});
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1 } });

/* Thin controllers delegating to services. */
const ctl = {
  search: async (req, res) => {
    const r = await props.search(req.query);
    ok(res, { items: r.items, sponsored: r.sponsored }, r.meta);
  },
  get: async (req, res) => ok(res, await props.getBySlug(req.params.slug, req.user)),
  geocode: async (req, res) => ok(res, await geocoding.search(req.query.q)),
  reverse: async (req, res) => ok(res, await geocoding.reverse(req.query.lat, req.query.lng)),
  create: async (req, res) => created(res, await props.create(req.user, req.body, req)),
  update: async (req, res) => ok(res, await props.update(req.user, req.params.id, req.body, req)),
  mine: async (req, res) => ok(res, await props.myProperties(req.user)),
  agent: async (req, res) => ok(res, await props.setAgent(req.user, req.params.id, req.body, req)),
  doc: async (req, res) => created(res, await props.attachDocument(req.user, req.params.id, req.file, req.body.category, req)),
  enquire: async (req, res) => created(res, await props.enquire(req.user, req.params.id, req.body, req)),
  save: async (req, res) => ok(res, await props.toggleSaved(req.user, req.params.id, true)),
  unsave: async (req, res) => ok(res, await props.toggleSaved(req.user, req.params.id, false)),
  saved: async (req, res) => ok(res, await props.listSaved(req.user)),
  requestViewing: async (req, res) => created(res, await appts.request(req.user, req.params.id, req.body, req)),
  appointments: async (req, res) => ok(res, await appts.list(req.user, { as: req.query.as, status: req.query.status })),
  appointment: async (req, res) => ok(res, await appts.get(req.user, req.params.id)),
  respond: async (req, res) => ok(res, await appts.respond(req.user, req.params.id, req.body, req)),
  accept: async (req, res) => ok(res, await appts.acceptProposal(req.user, req.params.id, req.body)),
  pay: async (req, res) => ok(res, await appts.payFee(req.user, req.params.id, req.body, { idempotencyKey: req.idempotencyKey, req })),
  cancel: async (req, res) => ok(res, await appts.cancel(req.user, req.params.id, req.body, req)),
  attend: async (req, res) => ok(res, await appts.confirmAttendance(req.user, req.params.id)),
  noShow: async (req, res) => ok(res, await appts.reportNoShow(req.user, req.params.id, req.body, req)),
};

const r = express.Router();
r.get('/properties', h(ctl.search));
r.get('/properties/:slug', optionalAuth, h(ctl.get));
r.get('/geocode', limiter({ name: 'geo', windowMs: 60e3, max: 20 }), h(ctl.geocode));
r.get('/geocode/reverse', limiter({ name: 'geo', windowMs: 60e3, max: 20 }), h(ctl.reverse));

r.use(requireAuth);
r.post('/listings', requireActive, validate(listing), h(ctl.create));
r.patch('/listings/:id', requireActive, validate(listing.partial()), h(ctl.update));
r.get('/listings/mine', h(ctl.mine));
r.post('/listings/:id/agents', validate(z.object({ agentEmail: z.string().email(), revoke: z.boolean().optional() })), h(ctl.agent));
r.post('/listings/:id/documents', upload.single('file'), validate(z.object({ category: z.enum(['ownership', 'agent_authority', 'agreement', 'other']) })), h(ctl.doc));
r.post('/properties/:id/enquiries', limiter({ name: 'enquiry', windowMs: 3600e3, max: 30, keyBy: 'user' }), validate(z.object({ message: z.string().max(2000).optional() })), h(ctl.enquire));
r.put('/properties/:id/save', h(ctl.save));
r.delete('/properties/:id/save', h(ctl.unsave));
r.get('/saved', h(ctl.saved));
r.post('/properties/:id/viewings', validate(z.object({ slots: z.array(z.string()).min(1).max(3), note: z.string().max(500).optional(), acceptedPolicies: z.array(z.object({ slug: z.string(), version: z.number().int() })).optional() })), h(ctl.requestViewing));
r.get('/appointments', h(ctl.appointments));
r.get('/appointments/:id', h(ctl.appointment));
r.post('/appointments/:id/respond', validate(z.object({ action: z.enum(['confirm', 'propose', 'decline']), slot: z.string().optional(), slots: z.array(z.string()).max(3).optional(), reason: z.string().max(300).optional() })), h(ctl.respond));
r.post('/appointments/:id/accept', validate(z.object({ slot: z.string() })), h(ctl.accept));
r.post('/appointments/:id/pay', requireActive, idempotent('viewing.pay'), validate(z.object({ method: z.enum(['wallet', 'paystack']) })), h(ctl.pay));
r.post('/appointments/:id/cancel', validate(z.object({ reason: z.string().min(3).max(300) })), h(ctl.cancel));
r.post('/appointments/:id/attendance', h(ctl.attend));
r.post('/appointments/:id/no-show', validate(z.object({ note: z.string().max(500).optional() })), h(ctl.noShow));

module.exports = r;
