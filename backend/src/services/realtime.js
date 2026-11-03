// Socket.IO: live updates to the browser (docs/API.md §10).
// Connect: io({ withCredentials: true, transports: ['websocket'] }), same
// origin. The handshake is checked with the same argus_at cookie as REST.
// Rooms:
//   user:<id>        every socket of one user (joined on connect)
//   device:<id>      device:status, settings:sync   (devices:subscribe)
//   live:<id>        device:live                    (live:subscribe, needs live.view)
//   admin:devices    device:status, command:status  (admin:subscribe, devices.view)
//   admin:rollouts   rollout:progress               (admin:subscribe, firmware.view)
const { Server } = require('socket.io');
const config = require('../config');
const db = require('../db');
const log = require('../logger');
const { userFromAccessToken } = require('../middleware/auth');
const { staffPermissions } = require('./users');
const access = require('./access');
const { verifyAccess, AT } = require('./tokens');

let io = null;

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const isUuid = (s) => typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const reply = (ack, v) => { if (typeof ack === 'function') ack(v); };

function attach(server) {
  io = new Server(server, {
    path: '/socket.io',
    transports: ['websocket'],
    cors: { origin: config.corsOrigins, credentials: true },
    // Cross-site WebSocket hijacking guard: only our web origins.
    allowRequest: (req, cb) => cb(null, config.corsOrigins.includes(req.headers.origin)),
  });

  io.use(async (socket, next) => {
    try {
      const token = parseCookies(socket.handshake.headers.cookie)[AT];
      socket.user = await userFromAccessToken(token);
      socket.tokenExp = verifyAccess(token).exp;
      next();
    } catch (err) {
      const e = new Error(err.message);
      e.data = { code: err.code || 'INVALID_TOKEN' };
      next(e);
    }
  });

  io.on('connection', (socket) => {
    const u = socket.user;
    socket.join(`user:${u.id}`);

    // When the access cookie expires: tell the app, then disconnect. The app
    // calls POST /auth/refresh and reconnects with the new cookie.
    const ms = socket.tokenExp * 1000 - Date.now();
    const timer = setTimeout(() => {
      socket.emit('auth:expired', {});
      socket.disconnect(true);
    }, Math.max(ms, 0));
    socket.on('disconnect', () => clearTimeout(timer));

    socket.on('devices:subscribe', async (msg, ack) => {
      try {
        const ids = (Array.isArray(msg?.deviceIds) ? msg.deviceIds : []).filter(isUuid).slice(0, 200);
        const allowed = await access.accessibleDevices(u.id, ids);
        for (const id of allowed) socket.join(`device:${id}`);
        reply(ack, { ok: true, deviceIds: allowed, status: await statusOf(allowed) });
      } catch (err) {
        log.error({ err }, 'devices:subscribe failed');
        reply(ack, { ok: false });
      }
    });

    socket.on('devices:unsubscribe', (msg) => {
      for (const id of (msg?.deviceIds || []).filter(isUuid)) socket.leave(`device:${id}`);
    });

    socket.on('live:subscribe', async (msg, ack) => {
      const id = msg?.deviceId;
      if (!isUuid(id)) return reply(ack, { ok: false, code: 'VALIDATION' });
      const perms = await access.devicePerms(u.id, id);
      if (!perms.has('live.view')) return reply(ack, { ok: false, code: 'NOT_FOUND' });
      socket.join(`live:${id}`);
      reply(ack, { ok: true, live: require('./live').getLive(id) });
    });

    socket.on('live:unsubscribe', (msg) => {
      if (isUuid(msg?.deviceId)) socket.leave(`live:${msg.deviceId}`);
    });

    socket.on('admin:subscribe', async (msg, ack) => {
      if (u.staff_role_id == null) return reply(ack, { ok: false, code: 'FORBIDDEN' });
      const perms = new Set(await staffPermissions(u.id));
      const want = Array.isArray(msg?.topics) ? msg.topics : [];
      const joined = [];
      if (want.includes('devices') && perms.has('devices.view')) { socket.join('admin:devices'); joined.push('devices'); }
      if (want.includes('rollouts') && perms.has('firmware.view')) { socket.join('admin:rollouts'); joined.push('rollouts'); }
      reply(ack, { ok: joined.length > 0, topics: joined });
    });
  });

  return io;
}

// Current online status for a list of devices (from device_state).
async function statusOf(ids) {
  if (!ids.length) return [];
  const { rows } = await db.query(
    `SELECT d.id, d.serial_no, COALESCE(s.is_online, false) AS online, s.last_seen_at
       FROM devices d LEFT JOIN device_state s ON s.device_id = d.id WHERE d.id = ANY($1::uuid[])`, [ids]);
  return rows.map((r) => ({ deviceId: r.id, serial: r.serial_no, online: r.online, lastSeenAt: r.last_seen_at }));
}

// ---- emitters (no-ops until attach() ran, e.g. in tests) ----------------
function emitDeviceStatus(deviceId, payload) {
  io?.to(`device:${deviceId}`).to('admin:devices').emit('device:status', payload);
}
function emitLive(deviceId, payload) {
  io?.to(`live:${deviceId}`).emit('device:live', payload);
}
function emitToDevice(deviceId, event, payload) {
  io?.to(`device:${deviceId}`).emit(event, payload);
}
function emitToUser(userId, event, payload) {
  io?.to(`user:${userId}`).emit(event, payload);
}
function emitToAdmins(topic, event, payload) {
  io?.to(`admin:${topic}`).emit(event, payload);
}

// After access to a device is removed: take every socket of that user out of
// the device's rooms, and tell them (API.md access:changed).
async function revokeDevice(userId, deviceId, myPermissions = null) {
  if (!io) return;
  const sockets = await io.in(`user:${userId}`).fetchSockets();
  for (const s of sockets) {
    if (!myPermissions || !myPermissions.includes('live.view')) s.leave(`live:${deviceId}`);
    if (!myPermissions) s.leave(`device:${deviceId}`);
  }
  emitToUser(userId, 'access:changed', { deviceId, myPermissions });
}

// Logout-all / disable / role change: close every socket of the user.
function disconnectUser(userId) {
  io?.in(`user:${userId}`).disconnectSockets(true);
}

module.exports = {
  attach, emitDeviceStatus, emitLive, emitToDevice, emitToUser, emitToAdmins, revokeDevice, disconnectUser,
};
