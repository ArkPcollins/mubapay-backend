'use strict';
/**
 * Customer support across four channels: in-app tickets, email (Brevo inbound
 * parsing + outbound replies), live chat (Socket.IO on a ticket), and WhatsApp
 * Business Cloud API. Priority: 1 financial/security, 2 disputes/orders, 3 general.
 * Support staff see only tickets assigned to them unless they hold support.view_all,
 * and support permissions never grant financial powers.
 */
const crypto = require('crypto');
const { mongoose } = require('../../lib/db');
const { User } = require('../users/user.model');
const notifications = require('../notifications/notifications.service');
const audit = require('../audit/audit.service');
const realtime = require('../../realtime/realtime');
const whatsapp = require('../../providers/whatsapp/whatsapp.adapter');
const email = require('../../providers/email/brevo.adapter');
const usersService = require('../users/users.service');
const config = require('../../config');
const { E } = require('../../lib/errors');
const { hasPermission } = require('../../middleware/auth');
const { esc, layout } = require('../notifications/templates');

const { Schema } = mongoose;
const PRIORITY = { financial: 1, security: 1, dispute: 2, order: 2, property: 2, delivery: 2, general: 3, account: 3 };

const ticketSchema = new Schema(
  {
    reference: { type: String, required: true },
    userId: { type: Schema.Types.ObjectId, ref: 'User' },
    contact: { email: String, phone: String, name: String }, // for email/WhatsApp senders without an account match
    category: { type: String, enum: Object.keys(PRIORITY), required: true },
    priority: { type: Number, required: true },
    subject: { type: String, required: true, maxlength: 200 },
    status: { type: String, enum: ['open', 'pending_staff', 'pending_customer', 'resolved', 'closed'], default: 'open' },
    channel: { type: String, enum: ['in_app', 'email', 'live_chat', 'whatsapp'], required: true },
    assignedTo: { type: Schema.Types.ObjectId, ref: 'User' },
    related: { type: { type: String }, id: String },
    messages: [{ authorType: { type: String, enum: ['customer', 'staff', 'system'] }, authorId: { type: Schema.Types.ObjectId, ref: 'User' }, body: { type: String, maxlength: 5000 }, channel: String, at: { type: Date, default: Date.now }, delivery: { status: String, error: String } }],
    lastCustomerMessageAt: Date,
    firstResponseAt: Date,
    resolvedAt: Date,
    satisfaction: { score: Number, comment: String },
  },
  { timestamps: true }
);
ticketSchema.index({ reference: 1 }, { unique: true });
ticketSchema.index({ status: 1, priority: 1, createdAt: 1 });
ticketSchema.index({ assignedTo: 1, status: 1 });
ticketSchema.index({ userId: 1, createdAt: -1 });
ticketSchema.index({ 'contact.phone': 1, status: 1 });
const SupportTicket = mongoose.models.SupportTicket || mongoose.model('SupportTicket', ticketSchema);

const newRef = () => `TCK-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

function canSee(user, t) {
  if (t.userId && String(t.userId) === String(user._id)) return 'customer';
  if (hasPermission(user, 'support.view_all')) return 'staff';
  if (hasPermission(user, 'support.view') && t.assignedTo && String(t.assignedTo) === String(user._id)) return 'staff';
  return null;
}

function present(t, viewer) {
  return { id: String(t._id), reference: t.reference, category: t.category, priority: t.priority, subject: t.subject, status: t.status, channel: t.channel, related: t.related, assignedTo: viewer === 'staff' ? t.assignedTo : undefined, contact: viewer === 'staff' ? t.contact : undefined, userId: viewer === 'staff' ? t.userId : undefined, messages: (t.messages || []).map((m) => ({ authorType: m.authorType, body: m.body, channel: m.channel, at: m.at, delivery: viewer === 'staff' ? m.delivery : undefined })), createdAt: t.createdAt, updatedAt: t.updatedAt, satisfaction: t.satisfaction };
}

async function create(user, { category, subject, body, related, channel = 'in_app' }) {
  if (!PRIORITY[category]) throw E.validation([{ path: 'category', message: 'Choose a category' }]);
  const t = await SupportTicket.create({ reference: newRef(), userId: user._id, category, priority: PRIORITY[category], subject, channel, related, messages: [{ authorType: 'customer', authorId: user._id, body, channel }], lastCustomerMessageAt: new Date() });
  await notifications.notify(user._id, { category: 'support', type: 'ticket_created', title: `Support request ${t.reference} received`, body: 'Our team will respond soon. Financial and security issues are handled first.', link: `/app/support/${t._id}` });
  await notifications.notifyStaff(t.priority === 1 ? 'support.view_all' : 'support.manage', { category: 'system', type: 'ticket_created', title: `New P${t.priority} ticket`, body: subject, link: '/admin/support' });
  realtime.toStaff('support', 'ticket:new', { id: String(t._id), priority: t.priority });
  return present(t, 'customer');
}

async function reply(user, id, body, req) {
  const t = await SupportTicket.findById(id);
  if (!t) throw E.notFound('Ticket');
  const viewer = canSee(user, t);
  if (!viewer) throw E.notFound('Ticket');
  if (viewer === 'staff' && !hasPermission(user, 'support.manage')) throw E.forbidden();
  if (['closed'].includes(t.status)) throw E.invalidState('Ticket is closed; open a new one');
  const text = String(body || '').trim().slice(0, 5000);
  if (!text) throw E.validation([{ path: 'body', message: 'Message required' }]);
  const msg = { authorType: viewer, authorId: user._id, body: text, channel: viewer === 'customer' ? 'in_app' : t.channel, at: new Date() };
  if (viewer === 'staff') {
    if (!t.firstResponseAt) t.firstResponseAt = new Date();
    if (!t.assignedTo) t.assignedTo = user._id;
    t.status = 'pending_customer';
    msg.delivery = await deliverStaffReply(t, text);
    await audit.fromReq(req, { action: 'support.reply', category: 'support', targetType: 'ticket', targetId: t._id });
  } else {
    t.status = 'pending_staff';
    t.lastCustomerMessageAt = new Date();
  }
  t.messages.push(msg);
  await t.save();
  realtime.toRoom(`ticket:${t._id}`, 'ticket:message', { ticketId: String(t._id), authorType: msg.authorType, body: text, at: msg.at });
  if (viewer === 'staff' && t.userId) await notifications.notify(t.userId, { category: 'support', type: 'ticket_reply', title: `Reply on ${t.reference}`, body: text.slice(0, 200), link: `/app/support/${t._id}` });
  return present(t, viewer);
}

/** Send the staff reply on the ticket's originating channel. */
async function deliverStaffReply(t, text) {
  try {
    if (t.channel === 'whatsapp') {
      const phone = t.contact?.phone;
      const within24h = t.lastCustomerMessageAt && Date.now() - t.lastCustomerMessageAt.getTime() < 24 * 3600e3;
      if (!within24h) return { status: 'not_sent', error: 'Outside WhatsApp 24-hour service window — use an approved template or reply in-app/email' };
      await whatsapp.sendText(phone, `[${t.reference}] ${text}`);
      return { status: 'sent' };
    }
    if (t.channel === 'email') {
      const to = t.contact?.email || (t.userId && (await User.findById(t.userId, { email: 1 }))?.email);
      const r = await email.send({ to, subject: `Re: [${t.reference}] ${t.subject}`, html: layout(`Support request ${t.reference}`, `<p>${esc(text).replace(/\n/g, '<br/>')}</p>`), text });
      return { status: r.status };
    }
    return { status: 'in_app' };
  } catch (err) {
    return { status: 'failed', error: err.message };
  }
}

async function get(user, id) {
  const t = await SupportTicket.findById(id);
  if (!t) throw E.notFound('Ticket');
  const viewer = canSee(user, t);
  if (!viewer) throw E.notFound('Ticket');
  return present(t, viewer);
}

async function mine(user) {
  const rows = await SupportTicket.find({ userId: user._id }).sort({ updatedAt: -1 }).limit(100);
  return rows.map((t) => present(t, 'customer'));
}

async function staffQueue(user, { status, assigned, page = 1, limit = 30 }) {
  const filter = {};
  if (status) filter.status = status;
  else filter.status = { $in: ['open', 'pending_staff', 'pending_customer'] };
  if (!hasPermission(user, 'support.view_all') || assigned === 'me') filter.assignedTo = user._id;
  if (assigned === 'unassigned' && hasPermission(user, 'support.view_all')) filter.assignedTo = null;
  const [rows, total] = await Promise.all([SupportTicket.find(filter).sort({ priority: 1, createdAt: 1 }).skip((page - 1) * limit).limit(limit), SupportTicket.countDocuments(filter)]);
  return { items: rows.map((t) => ({ ...present(t, 'staff'), messages: undefined, lastMessage: t.messages[t.messages.length - 1]?.body?.slice(0, 120) })), meta: { page, limit, total, pages: Math.ceil(total / limit) } };
}

async function assign(staff, id, assigneeId, req) {
  if (!hasPermission(staff, 'support.view_all') && String(assigneeId) !== String(staff._id)) throw E.forbidden('Only supervisors can assign tickets to others');
  const assignee = await User.findById(assigneeId);
  if (!assignee || !hasPermission(assignee, 'support.view')) throw E.badRequest('Assignee must be support staff');
  const t = await SupportTicket.findByIdAndUpdate(id, { $set: { assignedTo: assignee._id } }, { new: true });
  if (!t) throw E.notFound('Ticket');
  await audit.fromReq(req, { action: 'support.assigned', category: 'support', targetType: 'ticket', targetId: id, metadata: { assigneeId } });
  return present(t, 'staff');
}

async function setStatus(user, id, status, req) {
  const t = await SupportTicket.findById(id);
  if (!t) throw E.notFound('Ticket');
  const viewer = canSee(user, t);
  if (!viewer) throw E.notFound('Ticket');
  if (viewer === 'customer' && !['resolved', 'closed'].includes(status)) throw E.forbidden();
  if (viewer === 'staff' && !hasPermission(user, 'support.manage')) throw E.forbidden();
  t.status = status;
  if (['resolved', 'closed'].includes(status)) t.resolvedAt = new Date();
  t.messages.push({ authorType: 'system', body: `Status changed to ${status}`, at: new Date() });
  await t.save();
  if (viewer === 'staff') await audit.fromReq(req, { action: 'support.status', category: 'support', targetType: 'ticket', targetId: id, metadata: { status } });
  return present(t, viewer);
}

async function rate(user, id, { score, comment }) {
  const t = await SupportTicket.findOneAndUpdate({ _id: id, userId: user._id, status: { $in: ['resolved', 'closed'] } }, { $set: { satisfaction: { score: Math.max(1, Math.min(5, Number(score))), comment } } }, { new: true });
  if (!t) throw E.invalidState('You can rate a ticket after it is resolved');
  return present(t, 'customer');
}

/** Live chat: start (or resume) a chat ticket; messages flow over Socket.IO + REST. */
async function startLiveChat(user, { subject, category = 'general' }) {
  const existing = await SupportTicket.findOne({ userId: user._id, channel: 'live_chat', status: { $in: ['open', 'pending_staff', 'pending_customer'] } });
  if (existing) return present(existing, 'customer');
  return create(user, { category, subject: subject || 'Live chat', body: 'Chat started', channel: 'live_chat' });
}

/** Inbound WhatsApp message (processed from the durable webhook pipeline). */
async function handleWhatsAppInbound(ev) {
  const m = ev.payload || {};
  const from = m.from;
  const text = m.text?.body || (m.type !== 'text' ? `[${m.type} message — attachments are not supported; please describe your issue in text]` : '');
  const phone = usersService.normalisePhone(`+${from}`);
  const user = phone ? await User.findOne({ phone, phoneVerifiedAt: { $ne: null } }) : null;
  let t = await SupportTicket.findOne({ channel: 'whatsapp', 'contact.phone': from, status: { $in: ['open', 'pending_staff', 'pending_customer'] } });
  if (!t) {
    t = await SupportTicket.create({ reference: newRef(), userId: user?._id, contact: { phone: from, name: m.contacts?.[0]?.profile?.name }, category: 'general', priority: PRIORITY.general, subject: text.slice(0, 80) || 'WhatsApp enquiry', channel: 'whatsapp', messages: [], lastCustomerMessageAt: new Date() });
    await notifications.notifyStaff('support.manage', { category: 'system', type: 'ticket_created', title: 'New WhatsApp support message', body: text.slice(0, 120), link: '/admin/support' });
  }
  t.messages.push({ authorType: 'customer', authorId: user?._id, body: text, channel: 'whatsapp', at: new Date() });
  t.status = 'pending_staff';
  t.lastCustomerMessageAt = new Date();
  await t.save();
  realtime.toRoom(`ticket:${t._id}`, 'ticket:message', { ticketId: String(t._id), authorType: 'customer', body: text });
  return { handled: true };
}

/** Inbound email (Brevo inbound parsing webhook, authenticated by a secret path token). */
async function handleInboundEmail(item) {
  const fromEmail = String(item.From?.Address || item.from || '').toLowerCase();
  const subject = String(item.Subject || item.subject || 'Email enquiry').slice(0, 200);
  const body = String(item.ExtractedMarkdownMessage || item.RawTextBody || item.text || '').slice(0, 5000);
  if (!fromEmail) return { ignored: true };
  const refMatch = subject.match(/\[(TCK-[A-F0-9]{8})\]/);
  const user = await User.findOne({ email: fromEmail });
  let t = refMatch ? await SupportTicket.findOne({ reference: refMatch[1] }) : null;
  if (t && t.contact?.email && t.contact.email !== fromEmail && (!user || String(t.userId) !== String(user._id))) t = null;
  if (!t) t = await SupportTicket.create({ reference: newRef(), userId: user?._id, contact: { email: fromEmail, name: item.From?.Name }, category: 'general', priority: PRIORITY.general, subject, channel: 'email', messages: [] });
  t.messages.push({ authorType: 'customer', authorId: user?._id, body, channel: 'email', at: new Date() });
  t.status = 'pending_staff';
  t.lastCustomerMessageAt = new Date();
  await t.save();
  return { handled: true, ticket: t.reference };
}

function channels() {
  return {
    in_app: { available: true },
    live_chat: { available: true },
    email: { available: Boolean(config.integrations.brevo), address: config.SUPPORT_EMAIL },
    whatsapp: { available: config.integrations.whatsapp, note: config.integrations.whatsapp ? undefined : 'WhatsApp support is not configured on this server' },
  };
}

module.exports = { SupportTicket, create, reply, get, mine, staffQueue, assign, setStatus, rate, startLiveChat, handleWhatsAppInbound, handleInboundEmail, channels, canSee, PRIORITY };
