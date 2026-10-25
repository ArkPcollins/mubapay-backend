'use strict';
const { PrivateDocument, IdentityVerification, RoleApplication } = require('./verification.models');
const { User } = require('../users/user.model');
const storage = require('../../providers/storage/privateStorage');
const usersService = require('../users/users.service');
const notifications = require('../notifications/notifications.service');
const audit = require('../audit/audit.service');
const settings = require('../settings/settings.service');
const { withTransaction } = require('../../lib/db');
const { encryptString } = require('../../lib/crypto');
const { E } = require('../../lib/errors');
const { hasPermission } = require('../../middleware/auth');

const STAFF_DOC_PERMISSION = { identity_verification: 'kyc.documents.view', role_application: 'kyc.documents.view', property: 'properties.documents.view' };

async function attachDocument(user, { subjectType, subjectId, category, file }) {
  const saved = await storage.save(file.buffer, { declaredType: file.mimetype, category: subjectType });
  return PrivateDocument.create({ ownerId: user._id, category, subjectType, subjectId, storageKey: saved.storageKey, contentType: saved.contentType, sizeBytes: saved.sizeBytes, sha256: saved.sha256, originalName: String(file.originalname || '').slice(0, 120) });
}

// ---------------------------------------------------------------- identity verification
async function submitIdentity(user, body, files, req) {
  if (!user.emailVerifiedAt || !user.phoneVerifiedAt) throw E.verificationRequired('Verify your email and phone number before identity verification');
  const v = await settings.get('verification');
  if (!v.acceptedIdTypes.includes(body.idType)) throw E.validation([{ path: 'idType', message: `Accepted ID types: ${v.acceptedIdTypes.join(', ')}` }]);
  if (!files?.idDocument?.[0]) throw E.validation([{ path: 'idDocument', message: 'Upload a clear image or PDF of your ID' }]);
  if (!files?.selfie?.[0]) throw E.validation([{ path: 'selfie', message: 'Upload a selfie holding your ID' }]);
  const open = await IdentityVerification.findOne({ userId: user._id, status: 'pending' });
  if (open) throw E.conflict('A verification is already under review');
  if (user.kycStatus === 'approved') throw E.conflict('Your identity is already verified');
  const prev = await IdentityVerification.countDocuments({ userId: user._id });
  if (prev >= 5) throw E.conflict('Maximum verification attempts reached. Contact support.');
  const iv = await IdentityVerification.create({
    userId: user._id, legalFirstName: body.legalFirstName, legalLastName: body.legalLastName, dateOfBirthEnc: encryptString(body.dateOfBirth), idType: body.idType,
    idNumberEnc: encryptString(body.idNumber), idNumberLast4: String(body.idNumber).slice(-4), address: body.address, attempt: prev + 1, history: [{ at: new Date(), status: 'pending', by: user._id }],
  });
  try {
    await attachDocument(user, { subjectType: 'identity_verification', subjectId: iv._id, category: 'identity', file: files.idDocument[0] });
    await attachDocument(user, { subjectType: 'identity_verification', subjectId: iv._id, category: 'selfie', file: files.selfie[0] });
    if (files.proofOfAddress?.[0]) await attachDocument(user, { subjectType: 'identity_verification', subjectId: iv._id, category: 'proof_of_address', file: files.proofOfAddress[0] });
  } catch (err) {
    await IdentityVerification.deleteOne({ _id: iv._id });
    throw err;
  }
  await User.updateOne({ _id: user._id }, { $set: { kycStatus: 'pending' } });
  await audit.fromReq(req, { action: 'kyc.submitted', category: 'kyc', targetType: 'identity_verification', targetId: iv._id });
  await notifications.notifyStaff('kyc.review', { category: 'system', type: 'kyc_submitted', title: 'Identity verification submitted', body: `${body.legalFirstName} ${body.legalLastName}`, link: '/admin/verification' });
  return presentIdentity(iv);
}

function presentIdentity(iv, { staff = false } = {}) {
  const out = { id: String(iv._id), status: iv.status, idType: iv.idType, idNumberLast4: iv.idNumberLast4, legalFirstName: iv.legalFirstName, legalLastName: iv.legalLastName, customerMessage: iv.customerMessage, attempt: iv.attempt, createdAt: iv.createdAt, reviewedAt: iv.reviewedAt, appeal: iv.appeal };
  if (staff) Object.assign(out, { userId: String(iv.userId), reviewerNotes: iv.reviewerNotes, address: iv.address, history: iv.history });
  return out;
}

async function myIdentity(user) {
  const latest = await IdentityVerification.findOne({ userId: user._id }).sort({ createdAt: -1 });
  return { kycStatus: user.kycStatus, verificationTier: user.verificationTier, latest: latest ? presentIdentity(latest) : null };
}

async function reviewIdentity(staff, id, { decision, reviewerNotes, customerMessage }, req) {
  if (!['approve', 'reject', 'request_resubmission'].includes(decision)) throw E.badRequest('Invalid decision');
  if (decision !== 'approve' && (!customerMessage || customerMessage.length < 5)) throw E.validation([{ path: 'customerMessage', message: 'Tell the customer what to fix' }]);
  const iv = await IdentityVerification.findById(id);
  if (!iv) throw E.notFound('Verification');
  if (String(iv.userId) === String(staff._id)) throw E.forbidden('You cannot review your own verification');
  const status = { approve: 'approved', reject: 'rejected', request_resubmission: 'resubmission_required' }[decision];
  await withTransaction(async (session) => {
    const r = await IdentityVerification.findOneAndUpdate({ _id: id, status: 'pending' }, { $set: { status, reviewerId: staff._id, reviewerNotes, customerMessage, reviewedAt: new Date() }, $push: { history: { at: new Date(), status, by: staff._id, note: reviewerNotes } } }, { new: true, session });
    if (!r) throw E.invalidState('Verification is not pending');
    const set = { kycStatus: status === 'approved' ? 'approved' : status };
    if (status === 'approved') Object.assign(set, { firstName: iv.legalFirstName, lastName: iv.legalLastName });
    await User.updateOne({ _id: iv.userId }, { $set: set }, { session });
    await usersService.recomputeTier(iv.userId, session);
    await audit.record({ ...audit.ctxFrom(req), actor: staff, action: `kyc.${status}`, category: 'kyc', targetType: 'identity_verification', targetId: id, reason: reviewerNotes }, { session });
    const msg = { approved: ['Identity verified', 'Your identity has been verified. Higher limits and withdrawals are now available.'], rejected: ['Identity verification unsuccessful', customerMessage], resubmission_required: ['Action needed on your verification', customerMessage] }[status];
    await notifications.notify(iv.userId, { category: 'account', type: `kyc_${status}`, title: msg[0], body: msg[1], link: '/app/verification' }, { session });
  });
  return presentIdentity(await IdentityVerification.findById(id), { staff: true });
}

async function appealIdentity(user, id, text) {
  const iv = await IdentityVerification.findOneAndUpdate({ _id: id, userId: user._id, status: 'rejected', 'appeal.at': null }, { $set: { appeal: { text: String(text).slice(0, 2000), at: new Date() }, status: 'pending' }, $push: { history: { at: new Date(), status: 'pending', by: user._id, note: 'appeal' } } }, { new: true });
  if (!iv) throw E.invalidState('Only a rejected verification can be appealed once');
  await User.updateOne({ _id: user._id }, { $set: { kycStatus: 'pending' } });
  await notifications.notifyStaff('kyc.review', { category: 'system', type: 'kyc_appeal', title: 'Verification appeal', body: String(iv._id), link: '/admin/verification' });
  return presentIdentity(iv);
}

async function queue({ status = 'pending', page = 1, limit = 20 }) {
  const filter = { status };
  const [items, total] = await Promise.all([IdentityVerification.find(filter).sort({ createdAt: 1 }).skip((page - 1) * limit).limit(limit), IdentityVerification.countDocuments(filter)]);
  const docs = await PrivateDocument.find({ subjectType: 'identity_verification', subjectId: { $in: items.map((i) => i._id) }, deletedAt: null }).lean();
  return { items: items.map((i) => ({ ...presentIdentity(i, { staff: true }), documents: docs.filter((d) => String(d.subjectId) === String(i._id)).map((d) => ({ id: String(d._id), category: d.category, contentType: d.contentType, sizeBytes: d.sizeBytes })) })), meta: { page, limit, total, pages: Math.ceil(total / limit) } };
}

// ---------------------------------------------------------------- role applications
async function applyForRole(user, body, files, req) {
  if (!['landlord', 'agent'].includes(body.role)) throw E.badRequest('Role must be landlord or agent');
  if (user.capabilities?.[body.role]) throw E.conflict(`Your ${body.role} account is already active`);
  if (user.kycStatus !== 'approved') throw E.verificationRequired('Complete identity verification before applying');
  const open = await RoleApplication.findOne({ userId: user._id, role: body.role, status: 'pending' });
  if (open) throw E.conflict('An application is already under review');
  const app = await RoleApplication.create({ userId: user._id, role: body.role, businessName: body.businessName, registrationNumber: body.registrationNumber, professionalBody: body.professionalBody, yearsExperience: body.yearsExperience, operatingStates: body.operatingStates, statement: body.statement, history: [{ at: new Date(), status: 'pending', by: user._id }] });
  for (const f of files?.documents || []) await attachDocument(user, { subjectType: 'role_application', subjectId: app._id, category: body.role === 'agent' ? 'agent_authority' : 'ownership', file: f });
  await audit.fromReq(req, { action: 'role_application.submitted', category: 'kyc', targetType: 'role_application', targetId: app._id, metadata: { role: body.role } });
  await notifications.notifyStaff('roles.review', { category: 'system', type: 'role_application', title: `New ${body.role} application`, body: body.businessName || user.email, link: '/admin/verification/roles' });
  return app;
}

async function reviewRoleApplication(staff, id, { decision, reviewerNotes, customerMessage }, req) {
  const app = await RoleApplication.findById(id);
  if (!app) throw E.notFound('Application');
  if (String(app.userId) === String(staff._id)) throw E.forbidden('You cannot review your own application');
  const status = { approve: 'approved', reject: 'rejected', request_resubmission: 'resubmission_required' }[decision];
  if (!status) throw E.badRequest('Invalid decision');
  await withTransaction(async (session) => {
    const r = await RoleApplication.findOneAndUpdate({ _id: id, status: 'pending' }, { $set: { status, reviewerId: staff._id, reviewerNotes, customerMessage, reviewedAt: new Date() }, $push: { history: { at: new Date(), status, by: staff._id, note: reviewerNotes } } }, { new: true, session });
    if (!r) throw E.invalidState('Application is not pending');
    if (status === 'approved') await User.updateOne({ _id: app.userId }, { $set: { [`capabilities.${app.role}`]: true }, $addToSet: { roles: app.role } }, { session });
    await audit.record({ ...audit.ctxFrom(req), actor: staff, action: `role_application.${status}`, category: 'kyc', targetType: 'role_application', targetId: id, reason: reviewerNotes }, { session });
    await notifications.notify(app.userId, { category: 'account', type: `role_${status}`, title: status === 'approved' ? `Your ${app.role} account is active` : `Your ${app.role} application needs attention`, body: status === 'approved' ? 'You can now submit property listings for review.' : customerMessage, link: '/app/workspace' }, { session });
  });
  return RoleApplication.findById(id);
}

async function myRoleApplications(user) {
  return RoleApplication.find({ userId: user._id }).sort({ createdAt: -1 }).select('-reviewerNotes').lean();
}

async function roleQueue({ status = 'pending', page = 1, limit = 20 }) {
  const [items, total] = await Promise.all([RoleApplication.find({ status }).sort({ createdAt: 1 }).skip((page - 1) * limit).limit(limit).populate('userId', 'email firstName lastName kycStatus').lean(), RoleApplication.countDocuments({ status })]);
  const docs = await PrivateDocument.find({ subjectType: 'role_application', subjectId: { $in: items.map((i) => i._id) }, deletedAt: null }).lean();
  return { items: items.map((i) => ({ ...i, documents: docs.filter((d) => String(d.subjectId) === String(i._id)).map((d) => ({ id: String(d._id), category: d.category, contentType: d.contentType })) })), meta: { page, limit, total, pages: Math.ceil(total / limit) } };
}

// ---------------------------------------------------------------- private document access
/** Authorise access, audit it, and return a short-lived download token. */
async function requestDocumentAccess(user, documentId, req) {
  const doc = await PrivateDocument.findById(documentId);
  if (!doc || doc.deletedAt) throw E.notFound('Document');
  const isOwner = String(doc.ownerId) === String(user._id);
  const perm = STAFF_DOC_PERMISSION[doc.subjectType];
  const staffOk = perm && hasPermission(user, perm);
  if (!isOwner && !staffOk) {
    await audit.fromReq(req, { action: 'document.access_denied', category: 'access', outcome: 'denied', targetType: 'private_document', targetId: documentId, sensitiveRead: true });
    throw E.notFound('Document');
  }
  await audit.fromReq(req, { action: 'document.access_granted', category: 'access', targetType: 'private_document', targetId: documentId, sensitiveRead: true, metadata: { category: doc.category, subjectType: doc.subjectType, asOwner: isOwner } });
  return { token: storage.issueDownloadToken(String(doc._id), String(user._id)), expiresInSeconds: require('../../config').DOWNLOAD_TOKEN_TTL_SECONDS };
}

async function streamDocument(user, token, req, res) {
  const t = storage.verifyDownloadToken(token);
  if (!t || t.userId !== String(user._id)) throw E.forbidden('Download link expired or invalid');
  const doc = await PrivateDocument.findById(t.documentId).select('+storageKey');
  if (!doc || doc.deletedAt) throw E.notFound('Document');
  const data = await storage.read(doc.storageKey);
  await audit.fromReq(req, { action: 'document.downloaded', category: 'access', targetType: 'private_document', targetId: doc._id, sensitiveRead: true });
  res.set({ 'Content-Type': doc.contentType, 'Content-Disposition': 'inline', 'Cache-Control': 'no-store, private', 'X-Content-Type-Options': 'nosniff' });
  res.send(data);
}

module.exports = { attachDocument, submitIdentity, myIdentity, reviewIdentity, appealIdentity, queue, applyForRole, reviewRoleApplication, myRoleApplications, roleQueue, requestDocumentAccess, streamDocument, presentIdentity };
