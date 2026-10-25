'use strict';
/**
 * Dual-approval engine for high-risk financial actions and critical security
 * changes. An initiator creates a request; DIFFERENT authorised staff approve
 * it. Execution happens exactly once (atomic status claim) inside a MongoDB
 * transaction. The initiator can never satisfy an approval requirement.
 */
const { mongoose, withTransaction } = require('../../lib/db');
const { E } = require('../../lib/errors');
const audit = require('../audit/audit.service');
const notifications = require('../notifications/notifications.service');
const { hasPermission } = require('../../middleware/auth');

const { Schema } = mongoose;
const approvalSchema = new Schema(
  {
    action: { type: String, required: true },
    payload: { type: Schema.Types.Mixed, required: true },
    summary: String,
    reason: { type: String, required: true },
    initiatedBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    requiredApprovals: { type: Number, default: 1 },
    approverPermission: { type: String, required: true },
    approvals: [{ by: { type: Schema.Types.ObjectId, ref: 'User' }, at: Date, note: String }],
    rejection: { by: { type: Schema.Types.ObjectId, ref: 'User' }, at: Date, note: String },
    status: { type: String, enum: ['pending', 'approved_executing', 'executed', 'rejected', 'failed', 'cancelled'], default: 'pending' },
    result: Schema.Types.Mixed,
    error: String,
    targetType: String,
    targetId: String,
    expiresAt: Date,
  },
  { timestamps: true }
);
approvalSchema.index({ status: 1, createdAt: -1 });
approvalSchema.index({ action: 1, status: 1 });
const ApprovalRequest = mongoose.models.ApprovalRequest || mongoose.model('ApprovalRequest', approvalSchema);

/** action → { initiatorPermission, approverPermission, requiredApprovals, validate(payload), execute(payload, ctx, session), summarize(payload) } */
const actions = new Map();
function defineAction(name, def) {
  actions.set(name, def);
}

async function initiate(actor, action, payload, reason, req) {
  const def = actions.get(action);
  if (!def) throw E.notFound('Approval action');
  if (!reason || reason.trim().length < 10) throw E.validation([{ path: 'reason', message: 'A detailed reason (10+ characters) is required' }]);
  if (!hasPermission(actor, def.initiatorPermission)) throw E.forbidden();
  const clean = def.validate ? await def.validate(payload, actor) : payload;
  const doc = await ApprovalRequest.create({
    action, payload: clean, reason, initiatedBy: actor._id, requiredApprovals: def.requiredApprovals || 1, approverPermission: def.approverPermission,
    summary: def.summarize ? def.summarize(clean) : action, targetType: def.targetType, targetId: clean.targetId || clean.userId, expiresAt: new Date(Date.now() + 7 * 864e5),
  });
  await audit.fromReq(req, { action: 'approval.initiated', category: 'finance', targetType: 'approval', targetId: doc._id, reason, metadata: { action, summary: doc.summary } });
  await notifications.notifyStaff(def.approverPermission, { category: 'system', type: 'approval_needed', title: 'Approval required', body: doc.summary, link: '/admin/approvals' });
  return doc;
}

async function approve(actor, id, note, req) {
  const doc = await ApprovalRequest.findById(id);
  if (!doc) throw E.notFound('Approval request');
  const def = actions.get(doc.action);
  if (!hasPermission(actor, doc.approverPermission)) throw E.forbidden();
  if (String(doc.initiatedBy) === String(actor._id)) throw E.forbidden('Separation of duties: the initiator cannot approve their own request');
  if (doc.payload?.userId && String(doc.payload.userId) === String(actor._id)) throw E.forbidden('You cannot approve an action that affects your own account');
  if (doc.expiresAt && doc.expiresAt < new Date()) throw E.invalidState('This approval request has expired');
  const updated = await ApprovalRequest.findOneAndUpdate(
    { _id: id, status: 'pending', 'approvals.by': { $ne: actor._id }, initiatedBy: { $ne: actor._id } },
    { $push: { approvals: { by: actor._id, at: new Date(), note } } },
    { new: true }
  );
  if (!updated) throw E.invalidState('Request is not pending, or you already approved it');
  await audit.fromReq(req, { action: 'approval.approved', category: 'finance', targetType: 'approval', targetId: id, reason: note, metadata: { action: doc.action, count: updated.approvals.length, required: updated.requiredApprovals } });
  if (updated.approvals.length < updated.requiredApprovals) return updated;

  const claimed = await ApprovalRequest.findOneAndUpdate({ _id: id, status: 'pending' }, { $set: { status: 'approved_executing' } }, { new: true });
  if (!claimed) return ApprovalRequest.findById(id);
  try {
    const result = await withTransaction(async (session) => {
      const r = await def.execute(claimed.payload, { request: claimed, approvers: claimed.approvals.map((a) => a.by), initiatedBy: claimed.initiatedBy, req }, session);
      await ApprovalRequest.updateOne({ _id: id }, { $set: { status: 'executed', result: r } }, { session });
      await audit.record({ ...audit.ctxFrom(req), actor, action: 'approval.executed', category: 'finance', targetType: 'approval', targetId: id, metadata: { action: claimed.action, result: r } }, { session });
      return r;
    });
    return ApprovalRequest.findById(id).then((d) => Object.assign(d.toObject(), { result }));
  } catch (err) {
    await ApprovalRequest.updateOne({ _id: id }, { $set: { status: 'failed', error: err.message } });
    await audit.fromReq(req, { action: 'approval.execution_failed', category: 'finance', outcome: 'failure', targetType: 'approval', targetId: id, reason: err.message });
    throw err;
  }
}

async function reject(actor, id, note, req) {
  const doc = await ApprovalRequest.findById(id);
  if (!doc) throw E.notFound('Approval request');
  if (!hasPermission(actor, doc.approverPermission) && String(doc.initiatedBy) !== String(actor._id)) throw E.forbidden();
  const status = String(doc.initiatedBy) === String(actor._id) ? 'cancelled' : 'rejected';
  const updated = await ApprovalRequest.findOneAndUpdate({ _id: id, status: 'pending' }, { $set: { status, rejection: { by: actor._id, at: new Date(), note } } }, { new: true });
  if (!updated) throw E.invalidState('Request is no longer pending');
  await audit.fromReq(req, { action: `approval.${status}`, category: 'finance', targetType: 'approval', targetId: id, reason: note });
  return updated;
}

async function list({ status = 'pending', page = 1, limit = 20 } = {}) {
  const filter = status === 'all' ? {} : { status };
  const [items, total] = await Promise.all([
    ApprovalRequest.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).populate('initiatedBy', 'email firstName lastName').populate('approvals.by', 'email').lean(),
    ApprovalRequest.countDocuments(filter),
  ]);
  return { items, meta: { page, limit, total, pages: Math.ceil(total / limit) } };
}

module.exports = { ApprovalRequest, defineAction, initiate, approve, reject, list, actions };
