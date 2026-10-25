'use strict';
/**
 * Contextual, text-only messaging. Conversations always belong to a context
 * (property enquiry, viewing appointment, order, transaction) — there is no
 * general-purpose DM. Phone numbers and emails are masked unless the
 * workflow permits disclosure (confirmed appointment + user opt-in).
 */
const { mongoose } = require('../../lib/db');
const { E } = require('../../lib/errors');
const { User } = require('../users/user.model');
const notifications = require('../notifications/notifications.service');
const audit = require('../audit/audit.service');
const realtime = require('../../realtime/realtime');
const { hasPermission } = require('../../middleware/auth');

const { Schema } = mongoose;
const conversationSchema = new Schema(
  {
    contextType: { type: String, enum: ['property', 'appointment', 'order', 'transaction'], required: true },
    contextId: { type: Schema.Types.ObjectId, required: true },
    participantIds: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    subject: String,
    lastMessageAt: Date,
    status: { type: String, enum: ['open', 'closed', 'restricted'], default: 'open' },
    disclosureAllowed: { type: Boolean, default: false },
  },
  { timestamps: true }
);
conversationSchema.index({ contextType: 1, contextId: 1, participantIds: 1 });
conversationSchema.index({ participantIds: 1, lastMessageAt: -1 });

const messageSchema = new Schema(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    body: { type: String, required: true, maxlength: 2000 },
    masked: { type: Boolean, default: false },
    readBy: [{ type: Schema.Types.ObjectId }],
    hiddenByModeration: { type: Boolean, default: false },
  },
  { timestamps: true }
);
messageSchema.index({ conversationId: 1, createdAt: 1 });

const userReportSchema = new Schema(
  {
    reporterId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    targetUserId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation' },
    messageId: { type: Schema.Types.ObjectId, ref: 'Message' },
    reason: { type: String, enum: ['spam', 'harassment', 'fraud', 'off_platform_payment', 'inappropriate', 'other'], required: true },
    details: { type: String, maxlength: 1000 },
    status: { type: String, enum: ['open', 'actioned', 'dismissed'], default: 'open' },
    resolution: { by: { type: Schema.Types.ObjectId, ref: 'User' }, at: Date, note: String, action: String },
  },
  { timestamps: true }
);
userReportSchema.index({ status: 1, createdAt: -1 });

const Conversation = mongoose.models.Conversation || mongoose.model('Conversation', conversationSchema);
const Message = mongoose.models.Message || mongoose.model('Message', messageSchema);
const UserReport = mongoose.models.UserReport || mongoose.model('UserReport', userReportSchema);

const PHONE_RE = /(\+?234|0)[\s-]?[789][01]\d[\s-]?\d{3}[\s-]?\d{4}/g;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
function maskContacts(text) {
  let masked = false;
  const out = text.replace(PHONE_RE, () => { masked = true; return '[phone hidden]'; }).replace(EMAIL_RE, () => { masked = true; return '[email hidden]'; });
  return { text: out, masked };
}

/**
 * Contact details may be exchanged once the two participants have a confirmed
 * (or completed) viewing for the property the conversation is about. The flag is
 * then stored on the conversation so the check runs once.
 */
async function disclosureNowAllowed(c) {
  if (c.contextType !== 'property') return false;
  const { ViewingAppointment } = require('../realestate/realestate.models');
  const ok = await ViewingAppointment.exists({ propertyId: c.contextId, customerId: { $in: c.participantIds }, providerId: { $in: c.participantIds }, status: { $in: ['confirmed', 'completed'] } });
  if (ok) await Conversation.updateOne({ _id: c._id }, { $set: { disclosureAllowed: true } });
  return Boolean(ok);
}

/** Find or create the conversation for a context between two users. */
async function openConversation({ contextType, contextId, userIds, subject }) {
  const ids = [...new Set(userIds.map(String))];
  let c = await Conversation.findOne({ contextType, contextId, participantIds: { $all: ids, $size: ids.length } });
  if (!c) c = await Conversation.create({ contextType, contextId, participantIds: ids, subject, lastMessageAt: new Date() });
  return c;
}

async function assertParticipant(user, conversationId, { allowStaff = true } = {}) {
  const c = await Conversation.findById(conversationId);
  if (!c) throw E.notFound('Conversation');
  const isParticipant = c.participantIds.some((p) => String(p) === String(user._id));
  if (!isParticipant) {
    if (allowStaff && hasPermission(user, 'messaging.moderate')) return { c, staff: true };
    throw E.notFound('Conversation');
  }
  return { c, staff: false };
}

async function send(user, conversationId, body, req) {
  if (user.restriction?.scopes?.includes('messaging')) throw E.forbidden('Your messaging access is restricted. Contact support.');
  const { c, staff } = await assertParticipant(user, conversationId, { allowStaff: false });
  if (staff) throw E.forbidden();
  if (c.status !== 'open') throw E.forbidden('This conversation is closed');
  const others = c.participantIds.filter((p) => String(p) !== String(user._id));
  const blockers = await User.find({ _id: { $in: others }, blockedUserIds: user._id }, { _id: 1 }).lean();
  if (blockers.length) throw E.forbidden('You cannot message this user');
  const text = String(body || '').trim();
  if (!text) throw E.validation([{ path: 'body', message: 'Message cannot be empty' }]);
  if (text.length > 2000) throw E.validation([{ path: 'body', message: 'Message too long (2000 characters max)' }]);
  const disclosure = c.disclosureAllowed || (await disclosureNowAllowed(c));
  const { text: finalText, masked } = disclosure ? { text, masked: false } : maskContacts(text);
  const m = await Message.create({ conversationId: c._id, senderId: user._id, body: finalText, masked, readBy: [user._id] });
  await Conversation.updateOne({ _id: c._id }, { $set: { lastMessageAt: new Date() } });
  realtime.toRoom(`conversation:${c._id}`, 'message', { id: String(m._id), conversationId: String(c._id), senderId: String(user._id), body: finalText, createdAt: m.createdAt });
  for (const o of others) {
    await notifications.notify(o, { category: c.contextType === 'order' ? 'orders' : 'property', type: 'new_message', title: 'New message', body: finalText.slice(0, 120), link: `/app/messages/${c._id}`, skipEmail: true });
  }
  return { ...m.toObject(), notice: masked ? 'Contact details are hidden until a viewing is confirmed and both parties allow sharing. Keep payments on MubaPay.' : undefined };
}

async function list(user) {
  const convs = await Conversation.find({ participantIds: user._id }).sort({ lastMessageAt: -1 }).limit(100).lean();
  const counterpartIds = [...new Set(convs.flatMap((c) => c.participantIds.map(String)).filter((id) => id !== String(user._id)))];
  const users = await User.find({ _id: { $in: counterpartIds } }, { firstName: 1, lastName: 1 }).lean();
  const um = new Map(users.map((u) => [String(u._id), [u.firstName, (u.lastName || '').slice(0, 1)].filter(Boolean).join(' ')]));
  const unread = await Message.aggregate([{ $match: { conversationId: { $in: convs.map((c) => c._id) }, readBy: { $ne: user._id } } }, { $group: { _id: '$conversationId', n: { $sum: 1 } } }]);
  const unm = new Map(unread.map((u) => [String(u._id), u.n]));
  return convs.map((c) => ({ id: String(c._id), contextType: c.contextType, contextId: String(c.contextId), subject: c.subject, lastMessageAt: c.lastMessageAt, status: c.status, with: c.participantIds.filter((p) => String(p) !== String(user._id)).map((p) => ({ id: String(p), displayName: um.get(String(p)) })), unread: unm.get(String(c._id)) || 0 }));
}

async function messages(user, conversationId, req) {
  const { c, staff } = await assertParticipant(user, conversationId);
  if (staff) await audit.fromReq(req, { action: 'messaging.staff_read', category: 'access', targetType: 'conversation', targetId: conversationId, sensitiveRead: true });
  const rows = await Message.find({ conversationId: c._id, ...(staff ? {} : { hiddenByModeration: false }) }).sort({ createdAt: 1 }).limit(500).lean();
  if (!staff) await Message.updateMany({ conversationId: c._id, readBy: { $ne: user._id } }, { $addToSet: { readBy: user._id } });
  return { conversation: { id: String(c._id), contextType: c.contextType, contextId: String(c.contextId), subject: c.subject, status: c.status, disclosureAllowed: c.disclosureAllowed }, messages: rows.map((m) => ({ id: String(m._id), senderId: String(m.senderId), mine: String(m.senderId) === String(user._id), body: m.body, masked: m.masked, createdAt: m.createdAt, hidden: m.hiddenByModeration })) };
}

async function reportUser(user, { targetUserId, conversationId, messageId, reason, details }) {
  if (String(targetUserId) === String(user._id)) throw E.badRequest('You cannot report yourself');
  if (conversationId) await assertParticipant(user, conversationId, { allowStaff: false });
  const r = await UserReport.create({ reporterId: user._id, targetUserId, conversationId, messageId, reason, details });
  await notifications.notifyStaff('messaging.moderate', { category: 'system', type: 'user_reported', title: 'User reported', body: reason, link: '/admin/moderation/users' });
  return r;
}

async function block(user, targetUserId, blockIt = true) {
  if (String(targetUserId) === String(user._id)) throw E.badRequest('You cannot block yourself');
  await User.updateOne({ _id: user._id }, blockIt ? { $addToSet: { blockedUserIds: targetUserId } } : { $pull: { blockedUserIds: targetUserId } });
  return { blocked: blockIt };
}

async function moderateReport(staff, id, { action, note }, req) {
  if (!['dismiss', 'warn', 'restrict_messaging', 'hide_message'].includes(action)) throw E.badRequest('Invalid action');
  if (!note || note.length < 5) throw E.validation([{ path: 'note', message: 'A reason is required' }]);
  const r = await UserReport.findById(id);
  if (!r) throw E.notFound('Report');
  if (action === 'restrict_messaging') await User.updateOne({ _id: r.targetUserId }, { $addToSet: { 'restriction.scopes': 'messaging' }, $set: { 'restriction.reason': note, 'restriction.by': staff._id, 'restriction.at': new Date() } });
  if (action === 'hide_message' && r.messageId) await Message.updateOne({ _id: r.messageId }, { $set: { hiddenByModeration: true } });
  if (action === 'warn') await notifications.notify(r.targetUserId, { category: 'account', type: 'conduct_warning', title: 'Community guidelines warning', body: note });
  await UserReport.updateOne({ _id: id }, { $set: { status: action === 'dismiss' ? 'dismissed' : 'actioned', resolution: { by: staff._id, at: new Date(), note, action } } });
  await audit.fromReq(req, { action: `user_report.${action}`, category: 'moderation', targetType: 'user', targetId: r.targetUserId, reason: note });
  return UserReport.findById(id);
}

async function reportQueue({ status = 'open' }) {
  return UserReport.find({ status }).sort({ createdAt: 1 }).limit(100).populate('reporterId targetUserId', 'email firstName lastName').lean();
}

module.exports = { Conversation, Message, UserReport, openConversation, send, list, messages, reportUser, block, moderateReport, reportQueue, maskContacts, assertParticipant };
