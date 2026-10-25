'use strict';
const { LegalDocument, ConsentRecord } = require('./legal.models');
const { E } = require('../../lib/errors');

const REQUIRED = {
  registration: ['terms_of_service', 'privacy_policy'],
  wallet: ['wallet_terms'],
  savings: ['savings_terms'],
  checkout: ['marketplace_refund_policy', 'delivery_policy'],
  viewing: ['property_viewing_policy'],
  listing: ['prohibited_items_policy'],
};

async function latestPublished(slugs) {
  const docs = await LegalDocument.aggregate([
    { $match: { slug: { $in: slugs }, status: 'published' } },
    { $sort: { version: -1 } },
    { $group: { _id: '$slug', version: { $first: '$version' }, title: { $first: '$title' }, material: { $first: '$material' } } },
  ]);
  return new Map(docs.map((d) => [d._id, d]));
}

/**
 * Verify the client confirmed the CURRENT version of each required document.
 * accepted: [{ slug, version }]
 */
async function assertRequiredAccepted(accepted = [], context) {
  const slugs = REQUIRED[context] || [];
  const latest = await latestPublished(slugs);
  const missing = [];
  for (const s of slugs) {
    const l = latest.get(s);
    if (!l) continue; // nothing published yet (should not happen after seed)
    const a = (accepted || []).find((x) => x.slug === s);
    if (!a || Number(a.version) !== l.version) missing.push({ slug: s, version: l.version, title: l.title });
  }
  if (missing.length) throw E.validation(missing.map((m) => ({ path: `acceptedPolicies.${m.slug}`, message: `You must accept the current ${m.title} (v${m.version})`, slug: m.slug, version: m.version })));
}

async function recordAcceptances(userId, accepted = [], { ip, userAgent, context, session } = {}) {
  if (!accepted?.length) return;
  const docs = accepted.map((a) => ({ userId, kind: 'policy_acceptance', documentSlug: a.slug, documentVersion: Number(a.version), context, ip, userAgent }));
  await ConsentRecord.insertMany(docs, { session });
}

/** Separate confirmation for a financial commitment (e.g. savings early-exit terms). */
async function recordFinancialCommitment(userId, { statement, relatedType, relatedId, ip, userAgent }, session) {
  await ConsentRecord.create([{ userId, kind: 'financial_commitment', statement, relatedType, relatedId: String(relatedId), ip, userAgent }], { session });
}

async function recordMarketing(userId, granted, { ip, userAgent } = {}) {
  await ConsentRecord.create({ userId, kind: 'marketing_email', granted, ip, userAgent, context: 'preferences' });
}

/** Documents the user has not accepted at their latest material version. */
async function outstanding(userId, context) {
  const slugs = context ? REQUIRED[context] : [...new Set(Object.values(REQUIRED).flat())];
  const latest = await latestPublished(slugs);
  const out = [];
  for (const [slug, doc] of latest) {
    const last = await ConsentRecord.findOne({ userId, kind: 'policy_acceptance', documentSlug: slug }).sort({ at: -1 }).lean();
    if (!last) {
      if (!context || REQUIRED[context].includes(slug)) out.push({ slug, version: doc.version, title: doc.title, reason: 'not_accepted' });
      continue;
    }
    if (last.documentVersion < doc.version) {
      const materialSince = await LegalDocument.exists({ slug, version: { $gt: last.documentVersion, $lte: doc.version }, material: true });
      if (materialSince) out.push({ slug, version: doc.version, title: doc.title, reason: 'material_update' });
    }
  }
  return out;
}

/** Throws if the user must (re)accept documents for this context. */
async function assertUserAccepted(userId, context) {
  const o = await outstanding(userId, context);
  if (o.length) {
    const err = E.conflict('Please review and accept the latest terms before continuing', 'TERMS_ACCEPTANCE_REQUIRED', { documents: o });
    throw err;
  }
}

module.exports = { REQUIRED, latestPublished, assertRequiredAccepted, recordAcceptances, recordFinancialCommitment, recordMarketing, outstanding, assertUserAccepted };
