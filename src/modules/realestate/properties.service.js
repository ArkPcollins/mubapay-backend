'use strict';
const crypto = require('crypto');
const { Property, SavedProperty } = require('./realestate.models');
const { User } = require('../users/user.model');
const settings = require('../settings/settings.service');
const cloudinary = require('../../providers/media/cloudinary.adapter');
const notifications = require('../notifications/notifications.service');
const messaging = require('../messaging/messaging.service');
const audit = require('../audit/audit.service');
const verification = require('../verification/verification.service');
const { PrivateDocument } = require('../verification/verification.models');
const infra = require('../../infra');
const { E } = require('../../lib/errors');
const { hasPermission } = require('../../middleware/auth');

const slugify = (s) => `${String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}-${crypto.randomBytes(3).toString('hex')}`;
const CACHE_PREFIX = 'properties:search:';
const invalidate = () => infra.cache.invalidatePrefix(CACHE_PREFIX);

function isManager(user, p) {
  return p.managers.some((m) => m.status === 'active' && String(m.userId) === String(user._id));
}

function assertCanSubmit(user) {
  if (!user.capabilities?.landlord && !user.capabilities?.agent) throw E.forbidden('Only approved landlords and agents can list properties. Apply from your workspace.');
}

async function validate(data) {
  const prop = await settings.get('property');
  const caps = await settings.get('feeCaps');
  if (data.media?.length > prop.maxMediaPerListing) throw E.validation([{ path: 'media', message: `Maximum ${prop.maxMediaPerListing} media items` }]);
  if (data.media) data.media = data.media.map((m) => ({ ...m, url: cloudinary.assertOwnMedia(m.url) }));
  if (data.viewingFee?.required) {
    if (!(await settings.isEnabled('property_viewing_fees'))) throw E.featureDisabled('property_viewing_fees');
    if (!Number.isSafeInteger(data.viewingFee.amountKobo) || data.viewingFee.amountKobo <= 0) throw E.validation([{ path: 'viewingFee.amountKobo', message: 'Enter the viewing fee' }]);
    if (data.viewingFee.amountKobo > caps.maxViewingFeeKobo) throw E.validation([{ path: 'viewingFee.amountKobo', message: 'Viewing fee exceeds the platform maximum' }]);
  }
  if (data.listingType === 'land' && data.propertyType !== 'land') data.propertyType = 'land';
  if (data.listingType === 'rent' && !data.rentPeriod) data.rentPeriod = 'yearly';
  if (data.lat != null && data.lng != null) data.location = { ...(data.location || {}), geo: { type: 'Point', coordinates: [Number(data.lng), Number(data.lat)] } };
  data.mediaTypes = [...new Set((data.media || []).map((m) => m.kind))].concat(data.plan2d ? ['plan_2d'] : []);
  return data;
}

async function create(user, data, req) {
  await settings.assertFeature('property_listings');
  assertCanSubmit(user);
  const basis = user.capabilities.landlord && data.listingAuthority?.basis !== 'agent_mandate' ? 'owner' : 'agent_mandate';
  if (basis === 'agent_mandate' && !user.capabilities.agent) throw E.forbidden('Only approved agents can list under an agent mandate');
  await validate(data);
  const submit = data.submit !== false;
  const p = await Property.create({
    ...data, slug: slugify(data.title), submittedBy: user._id, status: submit ? 'pending_review' : 'draft',
    managers: [{ userId: user._id, role: basis === 'owner' ? 'owner' : 'agent', authorizedBy: user._id, authorizedAt: new Date() }],
    listingAuthority: { basis, notes: data.listingAuthority?.notes },
    moderationHistory: [{ at: new Date(), by: user._id, action: submit ? 'submitted' : 'draft_created' }],
  });
  if (submit) await notifications.notifyStaff('properties.moderate', { category: 'system', type: 'property_review', title: 'Property listing awaiting review', body: p.title, link: '/admin/moderation/properties' });
  await audit.fromReq(req, { action: 'property.created', category: 'moderation', targetType: 'property', targetId: p._id });
  return p;
}

async function update(user, id, data, req) {
  const p = await Property.findById(id);
  if (!p) throw E.notFound('Property');
  if (!isManager(user, p)) {
    await audit.fromReq(req, { action: 'property.edit_denied', category: 'access', outcome: 'denied', targetType: 'property', targetId: id });
    throw E.notFound('Property');
  }
  await validate({ ...p.toObject(), ...data });
  const fields = ['title', 'description', 'listingType', 'propertyType', 'priceKobo', 'rentPeriod', 'location', 'bedrooms', 'bathrooms', 'landSizeSqm', 'amenities', 'furnishing', 'availability', 'media', 'plan2d', 'viewingFee', 'mediaTypes'];
  const validated = await validate({ ...data });
  for (const f of fields) if (validated[f] !== undefined) p[f] = validated[f];
  const material = ['title', 'description', 'priceKobo', 'media', 'location', 'listingType', 'viewingFee'].some((k) => data[k] !== undefined);
  if (data.submit !== false && (material || ['draft', 'rejected'].includes(p.status)) && p.status !== 'hidden') {
    p.status = 'pending_review';
    p.moderationHistory.push({ at: new Date(), by: user._id, action: 'resubmitted' });
  }
  await p.save();
  await invalidate();
  return p;
}

/** Owners may authorise an approved agent to manage a listing (and revoke it). */
async function setAgent(user, id, { agentEmail, revoke }, req) {
  const p = await Property.findById(id);
  if (!p) throw E.notFound('Property');
  const owner = p.managers.find((m) => m.role === 'owner' && m.status === 'active' && String(m.userId) === String(user._id));
  if (!owner) throw E.forbidden('Only the property owner can authorise agents');
  const agent = await User.findOne({ email: String(agentEmail).toLowerCase(), 'capabilities.agent': true });
  if (!agent) throw E.notFound('Approved agent');
  if (revoke) await Property.updateOne({ _id: id, 'managers.userId': agent._id }, { $set: { 'managers.$.status': 'revoked' } });
  else {
    const exists = p.managers.find((m) => String(m.userId) === String(agent._id));
    if (exists) await Property.updateOne({ _id: id, 'managers.userId': agent._id }, { $set: { 'managers.$.status': 'active', 'managers.$.authorizedAt': new Date() } });
    else await Property.updateOne({ _id: id }, { $push: { managers: { userId: agent._id, role: 'agent', authorizedBy: user._id, authorizedAt: new Date() } } });
    await notifications.notify(agent._id, { category: 'property', type: 'agent_assigned', title: 'You were assigned a property', body: p.title, link: '/app/agent' });
  }
  await audit.fromReq(req, { action: revoke ? 'property.agent_revoked' : 'property.agent_authorized', category: 'access', targetType: 'property', targetId: id, metadata: { agentId: String(agent._id) } });
  return Property.findById(id);
}

async function attachDocument(user, id, file, category, req) {
  const p = await Property.findById(id);
  if (!p || !isManager(user, p)) throw E.notFound('Property');
  if (!['ownership', 'agent_authority', 'agreement', 'other'].includes(category)) throw E.badRequest('Invalid document category');
  const d = await verification.attachDocument(user, { subjectType: 'property', subjectId: p._id, category, file });
  await audit.fromReq(req, { action: 'property.document_uploaded', category: 'kyc', targetType: 'property', targetId: id, metadata: { category } });
  return { id: String(d._id), category: d.category, contentType: d.contentType };
}

async function moderate(staff, id, { decision, reason, authorityVerified }, req) {
  const p = await Property.findById(id);
  if (!p) throw E.notFound('Property');
  if (isManager(staff, p)) throw E.forbidden('You cannot moderate your own listing');
  const map = { approve: [['pending_review'], 'published'], reject: [['pending_review'], 'rejected'], hide: [['published'], 'hidden'], unhide: [['hidden'], 'published'] };
  if (!map[decision]) throw E.badRequest('Invalid decision');
  if (decision !== 'approve' && decision !== 'unhide' && (!reason || reason.length < 5)) throw E.validation([{ path: 'reason', message: 'A reason is required' }]);
  if (decision === 'approve') {
    const docs = await PrivateDocument.countDocuments({ subjectType: 'property', subjectId: p._id, deletedAt: null });
    if (!authorityVerified) throw E.validation([{ path: 'authorityVerified', message: 'Confirm you verified the listing authority (ownership or agent mandate)' }]);
    if (!docs && p.listingAuthority.basis === 'agent_mandate') throw E.validation([{ path: 'documents', message: 'Agent-mandate listings require an authority document' }]);
  }
  const [from, to] = map[decision];
  const set = { status: to };
  if (decision === 'approve') Object.assign(set, { publishedAt: p.publishedAt || new Date(), rejectionReason: null, 'listingAuthority.verifiedAt': new Date(), 'listingAuthority.verifiedBy': staff._id });
  if (decision === 'reject') set.rejectionReason = reason;
  const r = await Property.findOneAndUpdate({ _id: id, status: { $in: from } }, { $set: set, $push: { moderationHistory: { at: new Date(), by: staff._id, action: decision, note: reason } } }, { new: true });
  if (!r) throw E.invalidState(`Listing is ${p.status}`);
  await audit.fromReq(req, { action: `property.${decision}`, category: 'moderation', targetType: 'property', targetId: id, reason });
  for (const m of p.managers.filter((x) => x.status === 'active')) await notifications.notify(m.userId, { category: 'property', type: `property_${decision}`, title: decision === 'approve' ? 'Listing published' : `Listing ${decision === 'reject' ? 'needs changes' : decision === 'hide' ? 'hidden' : 'restored'}`, body: `${p.title}${reason ? `: ${reason}` : ''}`, link: '/app/landlord/properties' });
  await invalidate();
  return r;
}

// ---------------------------------------------------------------- discovery
function presentPublic(p, { revealAddress = false } = {}) {
  return {
    id: String(p._id), slug: p.slug, title: p.title, description: p.description, listingType: p.listingType, propertyType: p.propertyType, priceKobo: p.priceKobo, rentPeriod: p.rentPeriod,
    location: { area: p.location?.area, city: p.location?.city, lga: p.location?.lga, state: p.location?.state, approxCoordinates: p.location?.geo?.coordinates ? { lng: Number(p.location.geo.coordinates[0].toFixed(3)), lat: Number(p.location.geo.coordinates[1].toFixed(3)) } : null, address: revealAddress ? p.location?.addressPrivate : undefined },
    bedrooms: p.bedrooms, bathrooms: p.bathrooms, landSizeSqm: p.landSizeSqm, amenities: p.amenities, furnishing: p.furnishing, availability: p.availability,
    media: p.media, plan2d: p.plan2d || null, mediaTypes: p.mediaTypes || [], viewingFee: p.viewingFee, sponsored: Boolean(p.promotedUntil && new Date(p.promotedUntil) > new Date()),
    publishedAt: p.publishedAt, listedBy: p.listingAuthority?.basis === 'agent_mandate' ? 'Verified agent' : 'Verified landlord',
  };
}

async function search(q) {
  const key = `${CACHE_PREFIX}${crypto.createHash('sha1').update(JSON.stringify(q)).digest('hex')}`;
  const cached = await infra.cache.get(key);
  if (cached) return cached;
  const filter = { status: 'published', 'availability.status': q.includeUnavailable === 'true' ? { $exists: true } : { $in: ['available', 'under_offer'] } };
  if (q.q) filter.$text = { $search: String(q.q).slice(0, 100) };
  if (q.listingType) filter.listingType = q.listingType;
  if (q.propertyType) filter.propertyType = { $in: String(q.propertyType).split(',') };
  if (q.state) filter['location.state'] = new RegExp(`^${String(q.state).replace(/[^a-zA-Z ]/g, '')}$`, 'i');
  if (q.city) filter['location.city'] = new RegExp(`^${String(q.city).replace(/[^a-zA-Z ]/g, '')}$`, 'i');
  if (q.minPrice || q.maxPrice) filter.priceKobo = { ...(q.minPrice ? { $gte: Number(q.minPrice) } : {}), ...(q.maxPrice ? { $lte: Number(q.maxPrice) } : {}) };
  if (q.bedrooms) filter.bedrooms = { $gte: Number(q.bedrooms) };
  if (q.bathrooms) filter.bathrooms = { $gte: Number(q.bathrooms) };
  if (q.minLand || q.maxLand) filter.landSizeSqm = { ...(q.minLand ? { $gte: Number(q.minLand) } : {}), ...(q.maxLand ? { $lte: Number(q.maxLand) } : {}) };
  if (q.amenities) filter.amenities = { $all: String(q.amenities).split(',') };
  if (q.furnishing) filter.furnishing = q.furnishing;
  if (q.viewingFee === 'none') filter['viewingFee.required'] = false;
  if (q.viewingFee === 'required') filter['viewingFee.required'] = true;
  if (q.media) filter.mediaTypes = { $all: String(q.media).split(',') };
  if (q.listedWithinDays) filter.publishedAt = { $gte: new Date(Date.now() - Number(q.listedWithinDays) * 864e5) };
  if (q.lat && q.lng && q.radiusKm && !q.q) filter['location.geo'] = { $geoWithin: { $centerSphere: [[Number(q.lng), Number(q.lat)], Number(q.radiusKm) / 6378.1] } };
  const sortMap = { newest: { publishedAt: -1 }, price_asc: { priceKobo: 1 }, price_desc: { priceKobo: -1 }, relevance: q.q ? { score: { $meta: 'textScore' } } : { publishedAt: -1 } };
  const page = Math.max(1, Number(q.page) || 1);
  const limit = Math.min(48, Math.max(1, Number(q.limit) || 20));
  const projection = q.q ? { score: { $meta: 'textScore' } } : {};
  const [rows, total, sponsored] = await Promise.all([
    Property.find(filter, projection).sort({ ...(sortMap[q.sort] || sortMap.relevance), _id: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Property.countDocuments(filter),
    page === 1 ? Property.find({ ...filter, promotedUntil: { $gt: new Date() } }, projection).limit(3).lean() : [],
  ]);
  const out = { items: rows.map((p) => presentPublic(p)), sponsored: sponsored.map((p) => presentPublic(p)), meta: { page, limit, total, pages: Math.ceil(total / limit) } };
  await infra.cache.set(key, out, 60);
  return out;
}

async function getBySlug(slug, viewer) {
  const p = await Property.findOne({ slug }).lean();
  if (!p) throw E.notFound('Property');
  const manager = viewer && p.managers.some((m) => m.status === 'active' && String(m.userId) === String(viewer._id));
  const staff = viewer && hasPermission(viewer, 'properties.moderate');
  if (p.status !== 'published' && !manager && !staff) throw E.notFound('Property');
  Property.updateOne({ _id: p._id }, { $inc: { 'stats.views': 1 } }).catch(() => {});
  let reveal = Boolean(manager || staff);
  if (viewer && !reveal) {
    const { ViewingAppointment } = require('./realestate.models');
    reveal = Boolean(await ViewingAppointment.exists({ propertyId: p._id, customerId: viewer._id, status: { $in: ['confirmed', 'completed'] } }));
  }
  const out = presentPublic(p, { revealAddress: reveal });
  out.indexable = p.status === 'published';
  if (manager || staff) Object.assign(out, { status: p.status, rejectionReason: p.rejectionReason, moderationHistory: p.moderationHistory, managers: p.managers, stats: p.stats, listingAuthority: p.listingAuthority });
  return out;
}

async function enquire(user, propertyId, { message }, req) {
  const p = await Property.findOne({ _id: propertyId, status: 'published' });
  if (!p) throw E.notFound('Property');
  const provider = p.managers.find((m) => m.status === 'active' && m.role === 'agent') || p.managers.find((m) => m.status === 'active');
  if (String(provider.userId) === String(user._id)) throw E.badRequest('This is your listing');
  const c = await messaging.openConversation({ contextType: 'property', contextId: p._id, userIds: [user._id, provider.userId], subject: p.title });
  await Property.updateOne({ _id: p._id }, { $inc: { 'stats.enquiries': 1 } });
  if (message) await messaging.send(user, c._id, message, req);
  return { conversationId: String(c._id) };
}

async function myProperties(user) {
  const rows = await Property.find({ 'managers.userId': user._id, 'managers.status': 'active' }).sort({ updatedAt: -1 }).lean();
  return rows.map((p) => ({ ...presentPublic(p, { revealAddress: true }), status: p.status, rejectionReason: p.rejectionReason, stats: p.stats, myRole: p.managers.find((m) => String(m.userId) === String(user._id))?.role, moderationHistory: p.moderationHistory }));
}

async function moderationQueue({ status = 'pending_review' }) {
  const rows = await Property.find({ status }).sort({ updatedAt: 1 }).limit(100).populate('submittedBy', 'email firstName lastName capabilities').lean();
  const docs = await PrivateDocument.find({ subjectType: 'property', subjectId: { $in: rows.map((r) => r._id) }, deletedAt: null }).lean();
  return rows.map((p) => ({ ...presentPublic(p, { revealAddress: true }), status: p.status, submittedBy: p.submittedBy, listingAuthority: p.listingAuthority, moderationHistory: p.moderationHistory, documents: docs.filter((d) => String(d.subjectId) === String(p._id)).map((d) => ({ id: String(d._id), category: d.category, contentType: d.contentType })) }));
}

async function toggleSaved(user, propertyId, save) {
  if (save) await SavedProperty.updateOne({ userId: user._id, propertyId }, { $setOnInsert: { userId: user._id, propertyId } }, { upsert: true });
  else await SavedProperty.deleteOne({ userId: user._id, propertyId });
  return { saved: save };
}
async function listSaved(user) {
  const rows = await SavedProperty.find({ userId: user._id }).lean();
  const props = await Property.find({ _id: { $in: rows.map((r) => r.propertyId) } }).lean();
  return props.map((p) => ({ ...presentPublic(p), available: p.status === 'published' }));
}

module.exports = { create, update, setAgent, attachDocument, moderate, search, getBySlug, enquire, myProperties, moderationQueue, toggleSaved, listSaved, isManager, presentPublic, invalidate };
