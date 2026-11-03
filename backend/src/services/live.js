// Live device state (docs/API.md §11 status/info/state, §10 device:status/device:live).
// MQTT -> in-memory cache -> Socket.IO. Health values (heart rate etc.) are
// NEVER written to the database; device_state only gets connection health,
// and only on change or as a 5-minute heartbeat.
//
// Online/offline comes from three places:
//   1. retained "online" on <p>/<d>/status when the sensor connects
//   2. the broker's last will "offline" when the connection drops
//   3. the stale sweep: no message for DEVICE_STALE_S (a last will can be lost)
const config = require('../config');
const db = require('../db');
const log = require('../logger');
const mqtt = require('./mqtt');
const realtime = require('./realtime');

const HEARTBEAT_MS = 5 * 60_000;
const SWEEP_MS = 15_000;

// mac -> { deviceId, serial, online, lastSeenAt, live, rssi, uptimeS, fw, dbWrittenAt }
const devices = new Map();
// mac -> promise chain: messages of one device are handled one at a time.
const locks = new Map();
const onlineListeners = [];

function withLock(mac, fn) {
  const prev = locks.get(mac) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(mac, next.catch(() => {}));
  return next;
}

// Cached device row by MQTT username. Unknown MACs return null (the broker
// shouldn't have let them in, but never trust that).
async function entry(mac) {
  let d = devices.get(mac);
  if (d) return d;
  const row = await db.one('SELECT id, serial_no FROM devices WHERE mqtt_username = $1', [mac]);
  if (!row) return null;
  d = { deviceId: row.id, serial: row.serial_no, online: false, lastSeenAt: null, live: null,
    rssi: null, uptimeS: null, fw: null, dbWrittenAt: 0 };
  devices.set(mac, d);
  return d;
}

function statusPayload(d) {
  return { deviceId: d.deviceId, serial: d.serial, online: d.online, lastSeenAt: d.lastSeenAt };
}

async function setOnline(mac, d, online, reason) {
  if (d.online === online) return;
  d.online = online;
  const now = new Date();
  await db.query(
    `INSERT INTO device_state (device_id, is_online, last_seen_at, online_since, offline_since, updated_at)
     VALUES ($1, $2, $3::timestamptz, CASE WHEN $2 THEN $3::timestamptz END,
             CASE WHEN $2 THEN NULL ELSE $3::timestamptz END, now())
     ON CONFLICT (device_id) DO UPDATE SET
       is_online = $2,
       last_seen_at = COALESCE($4::timestamptz, device_state.last_seen_at),
       online_since = CASE WHEN $2 THEN $3::timestamptz ELSE device_state.online_since END,
       offline_since = CASE WHEN $2 THEN NULL ELSE $3::timestamptz END,
       updated_at = now()`,
    [d.deviceId, online, now, online ? now : null]);
  await db.query(`INSERT INTO device_events (device_id, type, message) VALUES ($1, $2, $3)`,
    [d.deviceId, online ? 'online' : 'offline', reason]);
  if (!online) d.live = null;
  realtime.emitDeviceStatus(d.deviceId, statusPayload(d));
  log.info({ mac, online, reason }, 'device presence');
  if (online) for (const fn of onlineListeners) Promise.resolve().then(() => fn(mac, d)).catch((err) => log.error({ err }, 'online listener failed'));
}

// Any message from the device proves it is connected.
async function seen(mac, d) {
  d.lastSeenAt = new Date().toISOString();
  if (!d.online) await setOnline(mac, d, true, 'message received');
}

function parseJson(payload) {
  try {
    const v = JSON.parse(payload.toString());
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null;
  } catch {
    return null;
  }
}

// Keep only the documented live keys, as numbers (DEVICE-DATA.md §2).
const LIVE_KEYS = ['pr', 'bed', 'ss', 'hr', 'br', 'bs', 'mv', 'mr', 'dist', 'rssi'];
function cleanLive(s) {
  const out = {};
  for (const k of LIVE_KEYS) {
    const n = Number(s[k]);
    out[k] = s[k] === undefined || s[k] === null || !Number.isFinite(n) ? null : n;
  }
  return out;
}

// ---- MQTT handlers -----------------------------------------------------
async function onStatus(mac, payload) {
  const d = await entry(mac);
  if (!d) return;
  const v = payload.toString().trim();
  if (v === 'online') {
    d.lastSeenAt = new Date().toISOString();
    await setOnline(mac, d, true, 'status online');
  } else if (v === 'offline') {
    await setOnline(mac, d, false, 'last will / status offline');
  }
}

async function onInfo(mac, payload) {
  const d = await entry(mac);
  const info = parseJson(payload);
  if (!d || !info) return;
  await seen(mac, d);
  const radarOk = info.radar === undefined ? null : Number(info.radar) === 1;
  const prev = await db.one('SELECT radar_ok FROM device_state WHERE device_id = $1', [d.deviceId]);
  d.fw = typeof info.fw === 'string' ? info.fw.slice(0, 40) : d.fw;
  await db.query(
    `UPDATE device_state SET fw_version = COALESCE($2, fw_version), ip = COALESCE($3::inet, ip),
            wifi_ssid = COALESCE($4, wifi_ssid), radar_ok = COALESCE($5, radar_ok),
            last_seen_at = now(), updated_at = now()
      WHERE device_id = $1`,
    [d.deviceId, d.fw, /^[0-9a-fA-F:.]{3,45}$/.test(info.ip || '') ? info.ip : null,
      typeof info.ssid === 'string' ? info.ssid.slice(0, 64) : null, radarOk]);
  if (radarOk !== null && prev && prev.radar_ok !== null && prev.radar_ok !== radarOk) {
    await db.query(`INSERT INTO device_events (device_id, type, severity, message) VALUES ($1, $2, $3, $4)`,
      [d.deviceId, radarOk ? 'radar_ok' : 'radar_fault', radarOk ? 'info' : 'warning', 'from info message']);
  }
}

async function onState(mac, payload) {
  const d = await entry(mac);
  const s = parseJson(payload);
  if (!d || !s) return;
  await seen(mac, d);
  const live = cleanLive(s);
  d.live = { ...live, at: d.lastSeenAt };
  const fwChanged = typeof s.fw === 'string' && s.fw !== d.fw;
  if (typeof s.fw === 'string') d.fw = s.fw.slice(0, 40);
  d.rssi = live.rssi;
  d.uptimeS = Number.isFinite(Number(s.up)) ? Number(s.up) : d.uptimeS;
  realtime.emitLive(d.deviceId, { deviceId: d.deviceId, serial: d.serial, ...d.live });
  liveListeners.forEach((fn) => Promise.resolve().then(() => fn(d, live)).catch((err) => log.error({ err }, 'live listener failed')));

  // Connection health to the DB: on firmware change or every 5 minutes.
  if (fwChanged || Date.now() - d.dbWrittenAt > HEARTBEAT_MS) {
    d.dbWrittenAt = Date.now();
    await db.query(
      `UPDATE device_state SET last_seen_at = $2, wifi_rssi = $3, uptime_s = $4,
              fw_version = COALESCE($5, fw_version), updated_at = now()
        WHERE device_id = $1`,
      [d.deviceId, d.lastSeenAt, d.rssi, d.uptimeS, d.fw]);
  }
}

// Stale sweep: online devices silent for longer than DEVICE_STALE_S.
async function sweep(now = Date.now()) {
  for (const [mac, d] of devices) {
    if (d.online && d.lastSeenAt && now - new Date(d.lastSeenAt).getTime() > config.deviceStaleS * 1000) {
      await withLock(mac, () => setOnline(mac, d, false, `no message for ${config.deviceStaleS} s`));
    }
  }
}

const liveListeners = [];

function start() {
  mqtt.on('status', (mac, p) => withLock(mac, () => onStatus(mac, p)));
  mqtt.on('info', (mac, p) => withLock(mac, () => onInfo(mac, p)));
  mqtt.on('state', (mac, p) => withLock(mac, () => onState(mac, p)));
  setInterval(() => sweep().catch((err) => log.error({ err }, 'stale sweep failed')), SWEEP_MS).unref();
}

// ---- read side (REST and Socket.IO) -------------------------------------
function byDeviceId(deviceId) {
  for (const d of devices.values()) if (d.deviceId === deviceId) return d;
  return null;
}
const getLive = (deviceId) => byDeviceId(deviceId)?.live || null;
const getStatus = (deviceId) => {
  const d = byDeviceId(deviceId);
  return d ? { online: d.online, lastSeenAt: d.lastSeenAt } : null;
};

// Forget a device (deleted/re-registered) so its row is reloaded.
const forget = (mac) => devices.delete(mac);

module.exports = {
  start, sweep, getLive, getStatus, forget, withLock, entry,
  onOnline: (fn) => onlineListeners.push(fn),
  onLive: (fn) => liveListeners.push(fn),
  // exposed for tests
  _handlers: { onStatus, onInfo, onState },
};
