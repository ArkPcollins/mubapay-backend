'use strict';
/**
 * Realtime fan-out facade. The API process registers its Socket.IO server;
 * worker processes may register an emitter (Redis variant). If neither is
 * available, emits are dropped silently — every realtime event is also
 * persisted (notification / message records), and clients poll as fallback.
 */
let io = null;
let emitter = null;

function setServer(server) {
  io = server;
}
function setEmitter(e) {
  emitter = e;
}
function target() {
  return io || emitter;
}

function toUser(userId, event, payload) {
  const t = target();
  if (t) t.to(`user:${userId}`).emit(event, payload);
}
function toRoom(room, event, payload) {
  const t = target();
  if (t) t.to(room).emit(event, payload);
}
function toStaff(permissionRoom, event, payload) {
  const t = target();
  if (t) t.to(`staff:${permissionRoom}`).emit(event, payload);
}

module.exports = { setServer, setEmitter, toUser, toRoom, toStaff, hasTransport: () => Boolean(target()) };
