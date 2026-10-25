'use strict';
/**
 * Authenticated Socket.IO server.
 *  - Handshake authenticates with the same access token (cookie or auth.token).
 *  - Each socket auto-joins only its own private room `user:<id>`.
 *  - Joining any other room requires a server-side authorisation check:
 *      conversation:<id>  → must be a participant
 *      ticket:<id>        → ticket owner or permitted support staff
 *      staff:<permission> → staff holding that permission
 */
const { Server } = require('socket.io');
const cookie = require('cookie-parser');
const config = require('../config');
const infra = require('../infra');
const realtime = require('./realtime');
const { resolveUser, hasPermission, ACCESS_COOKIE } = require('../middleware/auth');
const logger = require('../lib/logger');

function parseCookies(header) {
  const out = {};
  String(header || '').split(';').forEach((p) => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}

function attach(httpServer) {
  const io = new Server(httpServer, { path: '/socket.io', cors: { origin: config.corsOrigins, credentials: true }, serveClient: false, maxHttpBufferSize: 64 * 1024 });
  const adapter = infra.socketAdapter();
  if (adapter) io.adapter(adapter);

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token || parseCookies(socket.handshake.headers.cookie)[ACCESS_COOKIE];
      if (!token) return next(new Error('unauthorized'));
      const r = await resolveUser(token);
      if (!r) return next(new Error('unauthorized'));
      if (r.user.isStaff() && (!r.user.twoFactor?.enabled || !r.payload.mfa)) return next(new Error('two_factor_required'));
      socket.data.user = r.user;
      next();
    } catch (err) {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const user = socket.data.user;
    socket.join(`user:${user._id}`);

    socket.on('join', async ({ room } = {}, ack = () => {}) => {
      try {
        const [kind, id] = String(room || '').split(':');
        let allowed = false;
        if (kind === 'conversation') {
          const { Conversation } = require('../modules/messaging/messaging.service');
          allowed = Boolean(await Conversation.exists({ _id: id, participantIds: user._id }));
        } else if (kind === 'ticket') {
          const support = require('../modules/support/support.service');
          const t = await support.SupportTicket.findById(id);
          allowed = Boolean(t && support.canSee(user, t));
        } else if (kind === 'staff') {
          allowed = user.isStaff() && hasPermission(user, id === 'support' ? 'support.view' : id);
        }
        if (!allowed) return ack({ ok: false, error: 'forbidden' });
        socket.join(room);
        return ack({ ok: true });
      } catch {
        return ack({ ok: false, error: 'invalid' });
      }
    });

    socket.on('leave', ({ room } = {}) => socket.leave(String(room)));

    // Live support chat: send a message on a ticket (same authorisation as REST).
    socket.on('ticket:send', async ({ ticketId, body } = {}, ack = () => {}) => {
      try {
        const support = require('../modules/support/support.service');
        await support.reply(user, ticketId, body, { ip: socket.handshake.address, id: socket.id, get: () => socket.handshake.headers['user-agent'] });
        ack({ ok: true });
      } catch (err) {
        ack({ ok: false, error: err.message });
      }
    });
  });

  realtime.setServer(io);
  logger.info({ adapter: adapter ? 'redis' : 'in-memory' }, 'Socket.IO attached');
  return io;
}

module.exports = { attach, cookie };
