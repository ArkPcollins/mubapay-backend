'use strict';
const crypto = require('crypto');
const { Category, Product, ProductReport, SavedProduct, SavedSearch } = require('./marketplace.models');
const { User } = require('../users/user.model');
const settings = require('../settings/settings.service');
const cloudinary = require('../../providers/media/cloudinary.adapter');
const notifications = require('../notifications/notifications.service');
const audit = require('../audit/audit.service');
const consent = require('../legal/consent.service');
const infra = require('../../infra');
const { E } = require('../../lib/errors');
const { escapeRegex } = require('../../lib/http');
const { koboToNairaString } = require('../../lib/money');

const slugify = (s) => `${String(s).toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60)}-${crypto.randomBytes(3).toString('hex')}`;
const CACHE_PREFIX = 'products:search:';

async function invalidateSearchCache() {
  await infra.cache.invalidatePrefix(CACHE_PREFIX);
}

// ---------------------------------------------------------------- categories
async function listCategories({ includeInactive = false } = {}) {
  return Category.find(includeInactive ? {} : { active: true }).sort({ sortOrder: 1, name: 1 }).lean();
}

async function upsertCategory(staff, data, id, req) {
  const doc = id
    ? await Category.findByIdAndUpdate(id, { $set: data }, { new: true, runValidators: true })
    : await Category.create({ ...data, slug: data.slug || slugify(data.name).replace(/-[a-f0-9]{6}$/, '') });
  if (!doc) throw E.notFound('Category');
  await audit.fromReq(req, { action: id ? 'category.updated' : 'category.created', category: 'config', targetType: 'category', targetId: doc._id, metadata: data });
  await invalidateSearchCache();
  return doc;
}

// ---------------------------------------------------------------- shared validation
async function validateCommon(data, kind) {
  const cat = await Category.findById(data.categoryId);
  if (!cat || !cat.active) throw E.validation([{ path: 'categoryId', message: 'Choose a valid category' }]);
  if (cat.prohibited) throw E.validation([{ path: 'categoryId', message: `Listings in this category are not permitted: ${cat.prohibitedReason || 'prohibited items policy'}` }]);
  if (kind === 'used' && !cat.allowsUsed) throw E.validation([{ path: 'categoryId', message: 'Used items are not accepted in this category' }]);
  if (kind === 'new' && !cat.allowsNew) throw E.validation([{ path: 'categoryId', message: 'New items are not sold in this category' }]);
  if (!Number.isSafeInteger(data.priceKobo) || data.priceKobo < 100) throw E.validation([{ path: 'priceKobo', message: 'Price must be at least ₦1' }]);
  if (data.images) data.images = data.images.map((img) => ({ ...img, url: cloudinary.assertOwnMedia(img.url) }));
  const delivery = await settings.get('delivery');
  if (data.fulfilment?.originState && !delivery.coverageStates.map((s) => s.toLowerCase()).includes(String(data.fulfilment.originState).toLowerCase())) {
    throw E.validation([{ path: 'fulfilment.originState', message: `Items must be located in a covered state: ${delivery.coverageStates.join(', ')}` }]);
  }
  return cat;
}

// ---------------------------------------------------------------- admin: new products
async function createNewProduct(staff, data, req) {
  await validateCommon(data, 'new');
  const doc = await Product.create({ ...data, kind: 'new', condition: 'new', sellerId: null, slug: slugify(data.title), status: data.publish ? 'published' : 'draft', publishedAt: data.publish ? new Date() : undefined, moderationHistory: [{ at: new Date(), by: staff._id, action: 'created' }] });
  await audit.fromReq(req, { action: 'product.created', category: 'moderation', targetType: 'product', targetId: doc._id });
  await invalidateSearchCache();
  return doc;
}

async function updateNewProduct(staff, id, data, req) {
  const p = await Product.findOne({ _id: id, kind: 'new' });
  if (!p) throw E.notFound('Product');
  if (data.categoryId || data.images || data.priceKobo != null) await validateCommon({ ...p.toObject(), ...data }, 'new');
  const allowed = ['title', 'description', 'brand', 'categoryId', 'priceKobo', 'stock', 'images', 'weightKg', 'fulfilment', 'promotedUntil'];
  for (const k of allowed) if (data[k] !== undefined) p[k] = data[k];
  if (data.status && ['draft', 'published', 'archived', 'hidden'].includes(data.status)) {
    if (data.status === 'published' && !p.publishedAt) p.publishedAt = new Date();
    p.status = data.status;
  }
  p.moderationHistory.push({ at: new Date(), by: staff._id, action: 'updated', note: Object.keys(data).join(',') });
  await p.save();
  await audit.fromReq(req, { action: 'product.updated', category: 'moderation', targetType: 'product', targetId: p._id, metadata: { fields: Object.keys(data) } });
  await invalidateSearchCache();
  return p;
}

// ---------------------------------------------------------------- used listings
async function createUsedListing(user, data, req) {
  await settings.assertFeature('used_listings');
  const v = await settings.get('verification');
  if (user.verificationTier < v.usedSellerMinTier) throw E.verificationRequired(`Selling fairly-used items requires verification tier ${v.usedSellerMinTier}`, { requiredTier: v.usedSellerMinTier });
  if (data.acceptedPolicies) await consent.recordAcceptances(user._id, data.acceptedPolicies, { context: 'listing', ip: req.ip, userAgent: req.get('user-agent') });
  await consent.assertUserAccepted(user._id, 'listing');
  if (!['like_new', 'good', 'fair'].includes(data.condition)) throw E.validation([{ path: 'condition', message: 'Choose the item condition' }]);
  if (!data.conditionNotes || data.conditionNotes.length < 10) throw E.validation([{ path: 'conditionNotes', message: 'Describe the condition (at least 10 characters), including any defects' }]);
  await validateCommon(data, 'used');
  if (!user.capabilities.usedSeller) await User.updateOne({ _id: user._id }, { $set: { 'capabilities.usedSeller': true } });
  const submit = data.submit !== false;
  const doc = await Product.create({
    ...data, kind: 'used', sellerId: user._id, stock: Math.min(data.stock || 1, 20), slug: slugify(data.title),
    status: submit ? 'pending_review' : 'draft', moderationHistory: [{ at: new Date(), by: user._id, action: submit ? 'submitted' : 'draft_created' }],
  });
  if (submit) await notifications.notifyStaff('listings.moderate', { category: 'system', type: 'listing_review', title: 'Used listing awaiting moderation', body: doc.title, link: '/admin/moderation/products' });
  return doc;
}

async function updateUsedListing(user, id, data) {
  const p = await Product.findOne({ _id: id, kind: 'used', sellerId: user._id });
  if (!p) throw E.notFound('Listing');
  if (['archived'].includes(p.status)) throw E.invalidState('Archived listings cannot be edited');
  await validateCommon({ ...p.toObject(), ...data }, 'used');
  for (const k of ['title', 'description', 'brand', 'categoryId', 'condition', 'conditionNotes', 'priceKobo', 'stock', 'images', 'weightKg', 'fulfilment']) if (data[k] !== undefined) p[k] = data[k];
  // Any edit to a published/rejected listing sends it back to moderation.
  if (data.submit !== false && ['published', 'rejected', 'draft', 'hidden'].includes(p.status)) {
    if (p.status === 'hidden') throw E.forbidden('This listing was hidden by moderators. Contact support to appeal.');
    p.status = 'pending_review';
    p.moderationHistory.push({ at: new Date(), by: user._id, action: 'resubmitted' });
  }
  await p.save();
  await invalidateSearchCache();
  return p;
}

async function archiveUsedListing(user, id) {
  const p = await Product.findOneAndUpdate({ _id: id, kind: 'used', sellerId: user._id }, { $set: { status: 'archived' }, $push: { moderationHistory: { at: new Date(), by: user._id, action: 'archived' } } }, { new: true });
  if (!p) throw E.notFound('Listing');
  await invalidateSearchCache();
  return p;
}

async function moderate(staff, id, { decision, reason }, req) {
  if (!['approve', 'reject', 'hide', 'unhide'].includes(decision)) throw E.badRequest('Invalid decision');
  if (['reject', 'hide'].includes(decision) && (!reason || reason.length < 5)) throw E.validation([{ path: 'reason', message: 'A reason is required' }]);
  const p = await Product.findById(id);
  if (!p) throw E.notFound('Listing');
  if (p.sellerId && String(p.sellerId) === String(staff._id)) throw E.forbidden('You cannot moderate your own listing');
  const from = { approve: ['pending_review'], reject: ['pending_review'], hide: ['published'], unhide: ['hidden'] }[decision];
  const to = { approve: 'published', reject: 'rejected', hide: 'hidden', unhide: 'published' }[decision];
  const set = { status: to };
  if (decision === 'approve') { set.publishedAt = p.publishedAt || new Date(); set.rejectionReason = null; }
  if (decision === 'reject') set.rejectionReason = reason;
  if (decision === 'hide') set.hiddenReason = reason;
  const updated = await Product.findOneAndUpdate({ _id: id, status: { $in: from } }, { $set: set, $push: { moderationHistory: { at: new Date(), by: staff._id, action: decision, note: reason } } }, { new: true });
  if (!updated) throw E.invalidState(`Listing is "${p.status}" and cannot be ${decision}d`);
  if (decision === 'unhide') await ProductReport.updateMany({ productId: id, status: 'open' }, { $set: { status: 'dismissed', reviewedBy: staff._id } });
  if (decision === 'hide') await ProductReport.updateMany({ productId: id, status: 'open' }, { $set: { status: 'actioned', reviewedBy: staff._id } });
  await audit.fromReq(req, { action: `listing.${decision}`, category: 'moderation', targetType: 'product', targetId: id, reason });
  if (p.sellerId) {
    const msg = { approve: ['Listing approved', `"${p.title}" is now live.`], reject: ['Listing needs changes', `"${p.title}" was not approved: ${reason}. Edit and resubmit.`], hide: ['Listing hidden', `"${p.title}" was hidden: ${reason}`], unhide: ['Listing restored', `"${p.title}" is visible again.`] }[decision];
    await notifications.notify(p.sellerId, { category: 'orders', type: `listing_${decision}`, title: msg[0], body: msg[1], link: '/app/seller/listings' });
  }
  await invalidateSearchCache();
  return updated;
}

async function report(user, productId, { category, details }) {
  const p = await Product.findOne({ _id: productId, status: 'published' });
  if (!p) throw E.notFound('Listing');
  if (p.sellerId && String(p.sellerId) === String(user._id)) throw E.badRequest('You cannot report your own listing');
  try {
    await ProductReport.create({ productId, reporterId: user._id, category, details });
  } catch (err) {
    if (err.code === 11000) throw E.conflict('You have already reported this listing');
    throw err;
  }
  const mk = await settings.get('marketplace');
  const [distinct, serious] = await Promise.all([
    ProductReport.countDocuments({ productId, status: 'open' }),
    ProductReport.countDocuments({ productId, status: 'open', category: { $in: mk.reportAutoHideSeriousCategories } }),
  ]);
  await Product.updateOne({ _id: productId }, { $set: { reportCount: distinct } });
  // Auto-hide ONLY when the configured serious-risk threshold is met — not on a single report.
  if (distinct >= mk.reportAutoHideDistinctReporters || serious >= mk.reportAutoHideSeriousThreshold) {
    const hidden = await Product.findOneAndUpdate({ _id: productId, status: 'published' }, { $set: { status: 'hidden', hiddenReason: 'Automatically hidden pending review after multiple reports' }, $push: { moderationHistory: { at: new Date(), action: 'auto_hidden', note: `reports=${distinct}, serious=${serious}` } } });
    if (hidden) {
      await audit.record({ actorType: 'system', action: 'listing.auto_hidden', category: 'moderation', targetType: 'product', targetId: productId, metadata: { distinct, serious } });
      await notifications.notifyStaff('listings.moderate', { category: 'system', type: 'listing_auto_hidden', title: 'Listing auto-hidden after reports', body: p.title, link: '/admin/moderation/products' });
      await invalidateSearchCache();
    }
  }
  return { reported: true };
}

// ---------------------------------------------------------------- discovery
function presentProduct(p, { sellerName, categoryName } = {}) {
  return {
    id: String(p._id), slug: p.slug, kind: p.kind, title: p.title, description: p.description, brand: p.brand, categoryId: String(p.categoryId), categoryName,
    condition: p.condition, conditionNotes: p.conditionNotes, priceKobo: p.priceKobo, inStock: p.stock > 0, stock: p.stock, images: p.images,
    fulfilment: { delivery: p.fulfilment?.delivery, collection: p.fulfilment?.collection, originState: p.fulfilment?.originState, originCity: p.fulfilment?.originCity, collectionPointId: p.fulfilment?.collectionPointId },
    seller: p.sellerId ? { type: 'verified_individual', displayName: sellerName } : { type: 'mubapay', displayName: 'MubaPay' },
    sponsored: Boolean(p.promotedUntil && new Date(p.promotedUntil) > new Date()),
    publishedAt: p.publishedAt,
  };
}

async function search(q) {
  const cacheKey = `${CACHE_PREFIX}${crypto.createHash('sha1').update(JSON.stringify(q)).digest('hex')}`;
  const cached = await infra.cache.get(cacheKey);
  if (cached) return { ...cached, cached: true };
  const filter = { status: 'published' };
  if (q.q) filter.$text = { $search: String(q.q).slice(0, 100) };
  if (q.category) filter.categoryId = q.category;
  if (q.kind) filter.kind = q.kind;
  if (q.condition) filter.condition = { $in: String(q.condition).split(',') };
  if (q.brand) filter.brand = new RegExp(`^${escapeRegex(q.brand)}$`, 'i');
  if (q.minPrice || q.maxPrice) filter.priceKobo = { ...(q.minPrice ? { $gte: Number(q.minPrice) } : {}), ...(q.maxPrice ? { $lte: Number(q.maxPrice) } : {}) };
  if (q.inStock === 'true') filter.stock = { $gt: 0 };
  if (q.seller === 'mubapay') filter.sellerId = null;
  if (q.seller === 'individual') filter.sellerId = { $ne: null };
  if (q.delivery === 'true') filter['fulfilment.delivery'] = true;
  if (q.collection === 'true') filter['fulfilment.collection'] = true;
  if (q.state) {
    const d = await settings.get('delivery');
    if (!d.coverageStates.map((s) => s.toLowerCase()).includes(String(q.state).toLowerCase())) {
      return { items: [], sponsored: [], meta: { page: 1, limit: 0, total: 0, pages: 0 }, notice: `Delivery is not yet available in ${q.state}. Current coverage: ${d.coverageStates.join(', ')}` };
    }
  }
  const sortMap = { newest: { publishedAt: -1 }, price_asc: { priceKobo: 1 }, price_desc: { priceKobo: -1 }, popular: { soldCount: -1 }, relevance: q.q ? { score: { $meta: 'textScore' } } : { publishedAt: -1 } };
  const sort = { ...(sortMap[q.sort] || sortMap.relevance), _id: -1 };
  const page = Math.max(1, Number(q.page) || 1);
  const limit = Math.min(48, Math.max(1, Number(q.limit) || 24));
  const projection = q.q ? { score: { $meta: 'textScore' } } : {};
  const [rows, total, sponsoredRows] = await Promise.all([
    Product.find(filter, projection).sort(sort).skip((page - 1) * limit).limit(limit).lean(),
    Product.countDocuments(filter),
    page === 1 ? Product.find({ ...filter, promotedUntil: { $gt: new Date() } }, projection).limit(4).lean() : [],
  ]);
  const enrich = await enricher([...rows, ...sponsoredRows]);
  const result = {
    items: rows.map((p) => presentProduct(p, enrich(p))),
    // Sponsored placements are returned separately and must be shown with a "Sponsored" label.
    sponsored: sponsoredRows.map((p) => presentProduct(p, enrich(p))),
    meta: { page, limit, total, pages: Math.ceil(total / limit) },
  };
  await infra.cache.set(cacheKey, result, 60);
  return result;
}

async function enricher(products) {
  const sellerIds = [...new Set(products.filter((p) => p.sellerId).map((p) => String(p.sellerId)))];
  const catIds = [...new Set(products.map((p) => String(p.categoryId)))];
  const [sellers, cats] = await Promise.all([User.find({ _id: { $in: sellerIds } }, { firstName: 1, lastName: 1 }).lean(), Category.find({ _id: { $in: catIds } }, { name: 1 }).lean()]);
  const sm = new Map(sellers.map((s) => [String(s._id), [s.firstName, (s.lastName || '').slice(0, 1)].filter(Boolean).join(' ') + (s.lastName ? '.' : '')]));
  const cm = new Map(cats.map((c) => [String(c._id), c.name]));
  return (p) => ({ sellerName: sm.get(String(p.sellerId)), categoryName: cm.get(String(p.categoryId)) });
}

async function getBySlug(slug, viewer) {
  const p = await Product.findOne({ slug }).lean();
  if (!p) throw E.notFound('Product');
  const isOwner = viewer && p.sellerId && String(p.sellerId) === String(viewer._id);
  const isStaff = viewer && (viewer.roles.includes('admin') || viewer.roles.includes('superadmin'));
  if (p.status !== 'published' && !isOwner && !isStaff) throw E.notFound('Product');
  Product.updateOne({ _id: p._id }, { $inc: { viewCount: 1 } }).catch(() => {});
  const out = presentProduct(p, (await enricher([p]))(p));
  if (isOwner || isStaff) Object.assign(out, { status: p.status, rejectionReason: p.rejectionReason, hiddenReason: p.hiddenReason, moderationHistory: isStaff ? p.moderationHistory : p.moderationHistory.map((h) => ({ at: h.at, action: h.action, note: h.note })) });
  out.indexable = p.status === 'published';
  return out;
}

async function sellerListings(user, { status }) {
  const filter = { sellerId: user._id, kind: 'used' };
  if (status) filter.status = status;
  const rows = await Product.find(filter).sort({ updatedAt: -1 }).limit(200).lean();
  return rows.map((p) => ({ ...presentProduct(p), status: p.status, rejectionReason: p.rejectionReason, hiddenReason: p.hiddenReason, reportCount: p.reportCount, soldCount: p.soldCount, moderationHistory: p.moderationHistory }));
}

async function moderationQueue({ status = 'pending_review', page = 1, limit = 20 }) {
  const filter = status === 'reported' ? { reportCount: { $gt: 0 }, status: { $in: ['published', 'hidden'] } } : { status };
  const [rows, total] = await Promise.all([Product.find(filter).sort({ updatedAt: 1 }).skip((page - 1) * limit).limit(limit).lean(), Product.countDocuments(filter)]);
  const enrich = await enricher(rows);
  const reports = await ProductReport.find({ productId: { $in: rows.map((r) => r._id) }, status: 'open' }).lean();
  return { items: rows.map((p) => ({ ...presentProduct(p, enrich(p)), status: p.status, sellerId: p.sellerId && String(p.sellerId), moderationHistory: p.moderationHistory, reports: reports.filter((r) => String(r.productId) === String(p._id)) })), meta: { page, limit, total, pages: Math.ceil(total / limit) } };
}

// ---------------------------------------------------------------- saved items & searches
async function toggleSaved(user, productId, save) {
  if (save) await SavedProduct.updateOne({ userId: user._id, productId }, { $setOnInsert: { userId: user._id, productId } }, { upsert: true });
  else await SavedProduct.deleteOne({ userId: user._id, productId });
  return { saved: save };
}
async function listSaved(user) {
  const rows = await SavedProduct.find({ userId: user._id }).sort({ createdAt: -1 }).limit(200).lean();
  const products = await Product.find({ _id: { $in: rows.map((r) => r.productId) } }).lean();
  const enrich = await enricher(products);
  return products.map((p) => ({ ...presentProduct(p, enrich(p)), available: p.status === 'published' && p.stock > 0 }));
}

async function saveSearch(user, { scope, name, query, alertsEnabled, alertFrequency }) {
  const count = await SavedSearch.countDocuments({ userId: user._id });
  if (count >= 20) throw E.conflict('You can keep up to 20 saved searches');
  return SavedSearch.create({ userId: user._id, scope, name, query, alertsEnabled, alertFrequency, lastNotifiedAt: new Date() });
}
async function listSavedSearches(user) {
  return SavedSearch.find({ userId: user._id }).sort({ createdAt: -1 }).lean();
}
async function updateSavedSearch(user, id, data) {
  const s = await SavedSearch.findOneAndUpdate({ _id: id, userId: user._id }, { $set: { alertsEnabled: data.alertsEnabled, alertFrequency: data.alertFrequency, name: data.name } }, { new: true });
  if (!s) throw E.notFound('Saved search');
  return s;
}
async function deleteSavedSearch(user, id) {
  await SavedSearch.deleteOne({ _id: id, userId: user._id });
}

/** Search alerts job: notify users about new matching listings. */
async function runProductSearchAlerts() {
  const searches = await SavedSearch.find({ scope: 'products', alertsEnabled: true }).limit(1000);
  let notified = 0;
  for (const s of searches) {
    const waitMs = { instant: 0, daily: 864e5, weekly: 7 * 864e5 }[s.alertFrequency] || 864e5;
    if (Date.now() - s.lastNotifiedAt.getTime() < waitMs) continue;
    const q = s.query || {};
    const filter = { status: 'published', publishedAt: { $gt: s.lastNotifiedAt } };
    if (q.q) filter.$text = { $search: String(q.q) };
    if (q.category) filter.categoryId = q.category;
    if (q.condition) filter.condition = { $in: String(q.condition).split(',') };
    if (q.maxPrice) filter.priceKobo = { $lte: Number(q.maxPrice) };
    // eslint-disable-next-line no-await-in-loop
    const n = await Product.countDocuments(filter);
    if (n > 0) {
      // eslint-disable-next-line no-await-in-loop
      await notifications.notify(s.userId, { category: 'marketing', type: 'search_alert', title: `${n} new match${n > 1 ? 'es' : ''} for "${s.name || q.q || 'your search'}"`, body: 'New listings match your saved search.', link: `/marketplace?${new URLSearchParams(q).toString()}` });
      notified += 1;
    }
    s.lastNotifiedAt = new Date();
    // eslint-disable-next-line no-await-in-loop
    await s.save();
  }
  return { searches: searches.length, notified };
}

module.exports = {
  listCategories, upsertCategory, createNewProduct, updateNewProduct, createUsedListing, updateUsedListing, archiveUsedListing, moderate, report,
  search, getBySlug, sellerListings, moderationQueue, toggleSaved, listSaved, saveSearch, listSavedSearches, updateSavedSearch, deleteSavedSearch,
  runProductSearchAlerts, presentProduct, invalidateSearchCache, koboToNairaString,
};
