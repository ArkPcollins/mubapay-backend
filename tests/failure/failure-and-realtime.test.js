'use strict';
const http = require('http');
const { io: ioClient } = require('socket.io-client');
const H = require('../helpers/harness');
const config = require('../../src/config');
const db = require('../../src/lib/db');
const socket = require('../../src/realtime/socket');
const { Notification } = require('../../src/modules/notifications/notification.model');
const notifications = require('../../src/modules/notifications/notifications.service');
const messaging = require('../../src/modules/messaging/messaging.service');
const { User } = require('../../src/modules/users/user.model');

let app;
beforeAll(async () => {
  app = await H.start();
});
afterAll(H.stop);

describe('notification delivery failures', () => {
  test('email provider failure is retried, recorded, and the in-app notification stays visible', async () => {
    process.env.EMAIL_TRANSPORT = 'brevo';
    process.env.BREVO_API_KEY = 'xkeysib-test';
    config.__reload();
    let calls = 0;
    globalThis.__providerFetch = async () => {
      calls += 1;
      return { ok: false, status: 503, text: async () => JSON.stringify({ message: 'unavailable' }) };
    };
    const u = await H.createUser();
    await notifications.notify(u.user._id, { category: 'financial', type: 'test', title: 'Money moved', body: 'x' });
    const n = await Notification.findOne({ userId: u.user._id, type: 'test' });
    expect(n.email.status).toBe('pending');
    const r1 = await notifications.deliverEmail(n._id);
    expect(r1.status).toBe('retry');
    await Notification.updateOne({ _id: n._id }, { $set: { 'email.attempts': 6 } });
    const r2 = await notifications.deliverEmail(n._id);
    expect(r2.status).toBe('failed');
    expect(calls).toBe(2);
    const list = await H.as(u).get('/api/v1/notifications');
    expect(list.body.data.some((x) => x.title === 'Money moved')).toBe(true); // still visible in-app
    // a rejected (4xx) request fails permanently without endless retries
    globalThis.__providerFetch = async () => ({ ok: false, status: 400, text: async () => JSON.stringify({ message: 'invalid sender' }) });
    await notifications.notify(u.user._id, { category: 'security', type: 'test2', title: 'Security', body: 'x' });
    const n2 = await Notification.findOne({ userId: u.user._id, type: 'test2' });
    expect((await notifications.deliverEmail(n2._id)).status).toBe('failed');
    // concurrent delivery attempts never double-send
    let sent = 0;
    globalThis.__providerFetch = async () => {
      sent += 1;
      await new Promise((r) => setTimeout(r, 50));
      return { ok: true, status: 201, text: async () => JSON.stringify({ messageId: 'm1' }) };
    };
    await notifications.notify(u.user._id, { category: 'security', type: 'test3', title: 'Once', body: 'x' });
    const n3 = await Notification.findOne({ userId: u.user._id, type: 'test3' });
    await Promise.all([notifications.deliverEmail(n3._id), notifications.deliverEmail(n3._id), notifications.deliverEmail(n3._id)]);
    expect(sent).toBe(1);
    expect((await Notification.findById(n3._id)).email.status).toBe('sent');
    delete globalThis.__providerFetch;
    process.env.EMAIL_TRANSPORT = 'console';
    config.__reload();
  });

  test('users cannot disable mandatory security/financial notifications', async () => {
    const u = await H.createUser();
    await H.as(u).patch('/api/v1/account/preferences').send({ notifications: { security: { email: false, inApp: false }, orders: { email: false } } });
    const fresh = await User.findById(u.user._id);
    expect(fresh.preferences.notifications.get('security')).toBeUndefined();
    expect(fresh.preferences.notifications.get('orders').email).toBe(false);
  });
});

describe('messaging safety', () => {
  test('block and report; staff restriction stops messaging; staff reads are audited', async () => {
    const a = await H.createUser();
    const b = await H.createUser();
    const c = await messaging.openConversation({ contextType: 'order', contextId: a.user._id, userIds: [a.user._id, b.user._id], subject: 'Order' });
    expect((await H.as(a).post(`/api/v1/messages/${c._id}/messages`).send({ body: 'hello' })).status).toBe(201);
    await H.as(b).post('/api/v1/messages/block').send({ targetUserId: String(a.user._id) });
    expect((await H.as(a).post(`/api/v1/messages/${c._id}/messages`).send({ body: 'hello again' })).status).toBe(403);
    const rep = await H.as(b).post('/api/v1/messages/report').send({ targetUserId: String(a.user._id), conversationId: String(c._id), reason: 'harassment' });
    const mod = await H.staffUser('moderator');
    const act = await H.as(mod).post(`/api/v1/admin/moderation/users/${rep.body.data._id}`).send({ action: 'restrict_messaging', note: 'Repeated harassment reports' });
    expect(act.status).toBe(200);
    await H.as(b).post('/api/v1/messages/block').send({ targetUserId: String(a.user._id), block: false });
    expect((await H.as(a).post(`/api/v1/messages/${c._id}/messages`).send({ body: 'x' })).status).toBe(403);
    const read = await H.as(mod).get(`/api/v1/messages/${c._id}`);
    expect(read.status).toBe(200);
    const { AuditEvent } = require('../../src/modules/audit/audit.model');
    expect(await AuditEvent.exists({ action: 'messaging.staff_read', actorId: mod.user._id })).toBeTruthy();
  });
});

describe('database outage', () => {
  test('readiness reports the database as down without leaking details; recovers on reconnect', async () => {
    const ok = await H.api().get('/health/ready');
    expect(ok.body.status).toBe('ok');
    await db.mongoose.connection.close();
    const down = await H.api().get('/health/ready');
    expect(down.status).toBe(503);
    expect(down.body).toEqual(expect.objectContaining({ status: 'down', database: 'down' }));
    expect(JSON.stringify(down.body)).not.toMatch(/mongodb:\/\//);
    const live = await H.api().get('/health/live');
    expect(live.status).toBe(200);
    await db.mongoose.connect(process.env.MONGODB_URI);
    expect((await H.api().get('/health/ready')).body.database).toBe('ok');
  });
});

describe('Socket.IO authorisation', () => {
  let server;
  let url;
  beforeAll(async () => {
    server = http.createServer(app);
    socket.attach(server);
    await new Promise((r) => server.listen(0, r));
    url = `http://127.0.0.1:${server.address().port}`;
  });
  afterAll(async () => {
    await new Promise((r) => server.close(r));
  });
  const connect = (token) => new Promise((resolve) => {
    const s = ioClient(url, { auth: token ? { token } : undefined, transports: ['websocket'], reconnection: false });
    s.on('connect', () => resolve({ s, ok: true }));
    s.on('connect_error', (e) => resolve({ s, ok: false, err: e.message }));
  });

  test('unauthenticated sockets are rejected; users get only their own events and rooms', async () => {
    const anon = await connect();
    expect(anon.ok).toBe(false);
    anon.s.close();
    const a = await H.createUser();
    const b = await H.createUser();
    const conv = await messaging.openConversation({ contextType: 'order', contextId: b.user._id, userIds: [b.user._id, (await H.createUser()).user._id] });
    const sa = await connect(a.token);
    expect(sa.ok).toBe(true);
    const join = await new Promise((r) => sa.s.emit('join', { room: `conversation:${conv._id}` }, r));
    expect(join.ok).toBe(false);
    const joinStaff = await new Promise((r) => sa.s.emit('join', { room: 'staff:withdrawals.approve' }, r));
    expect(joinStaff.ok).toBe(false);
    const received = [];
    sa.s.on('notification', (n) => received.push(n));
    await notifications.notify(b.user._id, { category: 'account', type: 'private_b', title: 'For B only' });
    await notifications.notify(a.user._id, { category: 'account', type: 'private_a', title: 'For A' });
    await new Promise((r) => setTimeout(r, 300));
    expect(received.map((n) => n.type)).toEqual(['private_a']);
    sa.s.close();
  });

  test('staff sockets require MFA-verified sessions', async () => {
    const staffNoMfa = await H.createUser({ roles: ['admin'], permissions: ['support.view'] });
    const r = await connect(staffNoMfa.token);
    expect(r.ok).toBe(false);
    r.s.close();
    const staff = await H.staffUser('support_agent');
    const ok = await connect(staff.token);
    expect(ok.ok).toBe(true);
    const join = await new Promise((res) => ok.s.emit('join', { room: 'staff:support' }, res));
    expect(join.ok).toBe(true);
    ok.s.close();
  });
});
