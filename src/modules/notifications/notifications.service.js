'use strict';
const { Notification } = require('./notification.model');
const { User } = require('../users/user.model');
const email = require('../../providers/email/brevo.adapter');
const templates = require('./templates');
const realtime = require('../../realtime/realtime');
const infra = require('../../infra');
const { afterCommit } = require('../../lib/db');
const logger = require('../../lib/logger');
const settings = require('../settings/settings.service');

const MAX_EMAIL_ATTEMPTS = 6;

async function prefsFor(userId, category, session) {
  const user = await User.findById(userId, { email: 1, firstName: 1, preferences: 1, status: 1 }).session(session || null);
  if (!user) return null;
  const pref = user.preferences?.notifications?.get?.(category) || {};
  return { user, emailOn: pref.email !== false, inAppOn: pref.inApp !== false };
}

/**
 * Create a notification. Security & financial categories are mandatory: they
 * are always stored in-app (and emailed) regardless of preferences.
 */
async function notify(userId, { category, type, title, body, link, data, emailTemplate, dedupeKey, forceEmail = false, skipEmail = false }, { session } = {}) {
  const p = await prefsFor(userId, category, session);
  if (!p || p.user.status === 'closed') return null;
  const mandatoryCats = (await settings.get('notifications')).mandatoryCategories;
  const mandatory = mandatoryCats.includes(category);
  if (!mandatory && !p.inAppOn && !p.emailOn && !forceEmail) return null;
  const marketing = category === 'marketing';
  const wantEmail = !skipEmail && (forceEmail || mandatory || (marketing ? p.user.preferences?.marketingEmail : p.emailOn));
  // Inside a transaction a duplicate-key error aborts the whole transaction, so
  // deduplication must be a read-before-write, never a caught insert error.
  if (dedupeKey) {
    const existing = await Notification.findOne({ dedupeKey }).session(session || null);
    if (existing) return existing;
  }
  let doc;
  try {
    [doc] = await Notification.create(
      [{
        userId, category, type, title, body, link, data, mandatory, dedupeKey,
        readAt: !mandatory && !p.inAppOn ? new Date() : undefined, // email-only preference: not shown as unread
        email: { wanted: wantEmail, status: wantEmail ? 'pending' : 'skipped', template: emailTemplate, to: p.user.email, nextAttemptAt: new Date() },
      }],
      { session }
    );
  } catch (err) {
    // Only safe to recover outside a transaction (inside one, the error aborts it and must propagate).
    if (err.code === 11000 && dedupeKey && !session) return Notification.findOne({ dedupeKey });
    throw err;
  }
  await afterCommit(session, async () => {
    realtime.toUser(userId, 'notification', { id: String(doc._id), category, type, title, body, link, createdAt: doc.createdAt });
    if (wantEmail) {
      await infra.queue.add('notification.email', { id: String(doc._id) }, { jobId: `notif-email:${doc._id}`, attempts: 1 }).catch((err) =>
        logger.warn({ err: err.message }, 'email enqueue failed; sweeper will deliver')
      );
    }
  });
  return doc;
}

/** Deliver a pending email exactly once (claims with a lease). */
async function deliverEmail(id) {
  const now = new Date();
  const n = await Notification.findOneAndUpdate(
    { _id: id, 'email.status': { $in: ['pending'] }, $or: [{ 'email.lockedUntil': null }, { 'email.lockedUntil': { $lt: now } }] },
    { $set: { 'email.status': 'sending', 'email.lockedUntil': new Date(Date.now() + 60000) }, $inc: { 'email.attempts': 1 } },
    { new: true }
  );
  if (!n) return { skipped: true };
  try {
    const user = await User.findById(n.userId, { firstName: 1, email: 1 });
    const rendered = templates.render(n);
    const r = await email.send({ to: n.email.to || user.email, toName: user?.firstName, subject: rendered.subject, html: rendered.html, text: rendered.text, tags: [n.category, n.type] });
    const status = r.status === 'sent' ? 'sent' : r.status === 'sent_console' ? 'captured_dev' : 'not_configured';
    await Notification.updateOne({ _id: n._id }, { $set: { 'email.status': status, 'email.providerMessageId': r.messageId, 'email.sentAt': status === 'sent' ? new Date() : undefined, 'email.lastError': r.reason, 'email.lockedUntil': null } });
    return { status };
  } catch (err) {
    const attempts = n.email.attempts;
    const final = attempts >= MAX_EMAIL_ATTEMPTS || err.outcome === 'rejected';
    await Notification.updateOne(
      { _id: n._id },
      { $set: { 'email.status': final ? 'failed' : 'pending', 'email.lastError': String(err.message).slice(0, 500), 'email.lockedUntil': null, 'email.nextAttemptAt': new Date(Date.now() + 30000 * 2 ** attempts) } }
    );
    logger.warn({ id: String(n._id), attempts, final, err: err.message }, 'email delivery failed');
    return { status: final ? 'failed' : 'retry' };
  }
}

/** Durable sweeper: deliver any pending emails whose retry time has arrived. */
async function sweepPendingEmails(limit = 100) {
  const due = await Notification.find({ 'email.status': 'pending', 'email.nextAttemptAt': { $lte: new Date() } }, { _id: 1 }).limit(limit).lean();
  let sent = 0;
  for (const d of due) {
    // eslint-disable-next-line no-await-in-loop
    const r = await deliverEmail(d._id);
    if (r.status === 'sent' || r.status === 'captured_dev') sent += 1;
  }
  // release stuck "sending" leases
  await Notification.updateMany({ 'email.status': 'sending', 'email.lockedUntil': { $lt: new Date() } }, { $set: { 'email.status': 'pending', 'email.lockedUntil': null } });
  return { processed: due.length, sent };
}

async function list(userId, { page = 1, limit = 20, unreadOnly = false } = {}) {
  const filter = { userId };
  if (unreadOnly) filter.readAt = null;
  const [items, total, unread] = await Promise.all([
    Notification.find(filter, { 'email.to': 0 }).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Notification.countDocuments(filter),
    Notification.countDocuments({ userId, readAt: null }),
  ]);
  return { items, meta: { page, limit, total, pages: Math.ceil(total / limit), unread } };
}

async function markRead(userId, ids) {
  const filter = { userId, readAt: null };
  if (ids !== 'all') filter._id = { $in: ids };
  const r = await Notification.updateMany(filter, { $set: { readAt: new Date() } });
  return { updated: r.modifiedCount };
}

/** Notify all staff holding a permission (in-app). */
async function notifyStaff(permission, payload, opts) {
  const staff = await User.find({ roles: { $in: ['admin', 'superadmin'] }, status: 'active', $or: [{ roles: 'superadmin' }, { staffPermissions: permission }] }, { _id: 1 }).lean();
  for (const s of staff) await notify(s._id, { ...payload, skipEmail: true }, opts);
  realtime.toStaff(permission, 'staff:queue', { type: payload.type });
}

module.exports = { notify, deliverEmail, sweepPendingEmails, list, markRead, notifyStaff };
