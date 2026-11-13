// Device commands (docs/API.md §3.8, §8.8–8.10, §11 cmd / cmd/ack / logs).
// Decision D4: an OFFLINE sensor's command waits in device_commands and is
// sent when it reconnects. config_mode and recalibrate expire after 30 s
// (interactive buttons: firing hours later would surprise the customer);
// the others after 24 h.
//   pending -> sent -> acked | failed        (expired when its time runs out)
const db = require('../db');
const log = require('../logger');
const mqtt = require('./mqtt');
const live = require('./live');
const realtime = require('./realtime');

const TTL_S = { config_mode: 30, recalibrate: 30, end_session: 30, reboot: 24 * 3600, ota_check: 24 * 3600, logs: 24 * 3600 };
const LOG_MAX = 65536;

const isOnline = (deviceId) => !!live.getStatus(deviceId)?.online;

function emitStatus(c, serial) {
  const payload = { commandId: c.id, deviceId: c.device_id, serial, type: c.type, status: c.status, error: c.error || null };
  if (c.requested_by) realtime.emitToUser(c.requested_by, 'command:status', payload);
  realtime.emitToAdmins('devices', 'command:status', payload);
}

async function serialOf(deviceId) {
  return (await db.one('SELECT serial_no FROM devices WHERE id = $1', [deviceId]))?.serial_no;
}

// Publish one pending command; mark it sent.
async function send(c, mac) {
  await mqtt.publish(mac, 'cmd', { id: c.id, c: c.type }, { qos: 1 });
  const { rows: [u] } = await db.query(
    `UPDATE device_commands SET status = 'sent', sent_at = now() WHERE id = $1 AND status = 'pending' RETURNING *`, [c.id]);
  if (u) emitStatus(u, await serialOf(u.device_id));
  return u || c;
}

// Create a command. Returns the row; status is 'sent' if the sensor is online
// (and MQTT is up), otherwise 'pending' (= "queued" in the API).
async function create(deviceId, type, requestedBy) {
  const { rows: [c] } = await db.query(
    `INSERT INTO device_commands (device_id, type, requested_by, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4)) RETURNING *`,
    [deviceId, type, requestedBy, TTL_S[type]]);
  if (isOnline(deviceId)) {
    const d = await db.one('SELECT mqtt_username FROM devices WHERE id = $1', [deviceId]);
    try {
      return await send(c, d.mqtt_username);
    } catch (err) {
      log.warn({ err: err.message, commandId: c.id }, 'command publish failed; stays queued');
    }
  }
  return c;
}

// Customer buttons (3.8 Wi-Fi setup, 3.8b recalibrate): no queue. If the
// sensor didn't get it right now, it is expired at once, so the web can say
// "the sensor is offline" instead of waiting 30 s. Returns the row.
async function createNow(deviceId, type, requestedBy) {
  const c = await create(deviceId, type, requestedBy);
  if (c.status !== 'pending') return c;
  const { rows: [x] } = await db.query(
    `UPDATE device_commands SET status = 'expired', error = 'device offline' WHERE id = $1 AND status = 'pending' RETURNING *`, [c.id]);
  if (x) emitStatus(x, await serialOf(x.device_id));
  return x || c;
}

// API wording: pending = "queued".
const apiStatus = (s) => (s === 'pending' ? 'queued' : s);

// cmd/ack {"id":812,"ok":1} or {"id":812,"ok":0,"err":"..."}
async function onAck(mac, buf) {
  let m;
  try { m = JSON.parse(buf.toString()); } catch { return; }
  if (!Number.isInteger(m?.id)) return;
  const ok = m.ok === 1 || m.ok === true;
  const { rows: [c] } = await db.query(
    `UPDATE device_commands dc SET status = $3, acked_at = now(), error = $4
       FROM devices d
      WHERE dc.id = $2 AND dc.device_id = d.id AND d.mqtt_username = $1 AND dc.status IN ('pending', 'sent')
      RETURNING dc.*`,
    [mac, m.id, ok ? 'acked' : 'failed', ok ? null : String(m.err || 'failed').slice(0, 200)]);
  if (c) emitStatus(c, await serialOf(c.device_id));
}

// logs: {"id":812,"part":1,"of":4,"text":"..."}, each part <= 3 KB. Parts are
// joined in memory; the upload is stored when all parts are in. Incomplete
// uploads are dropped after 2 minutes.
const partial = new Map(); // `${mac}:${id}` -> {parts: [], of, at}
async function onLogs(mac, buf) {
  let m;
  try { m = JSON.parse(buf.toString()); } catch { return; }
  if (!Number.isInteger(m?.id) || !Number.isInteger(m.part) || !Number.isInteger(m.of)
      || m.of < 1 || m.of > 64 || m.part < 1 || m.part > m.of || typeof m.text !== 'string') return;
  const key = `${mac}:${m.id}`;
  let p = partial.get(key);
  if (!p) { p = { parts: new Array(m.of).fill(null), of: m.of, at: Date.now() }; partial.set(key, p); }
  if (p.of !== m.of) return;
  p.parts[m.part - 1] = m.text;
  if (p.parts.some((x) => x === null)) return;
  partial.delete(key);
  const content = p.parts.join('').slice(0, LOG_MAX);
  const c = await db.one(
    `SELECT dc.id, dc.device_id FROM device_commands dc JOIN devices d ON d.id = dc.device_id
      WHERE dc.id = $2 AND d.mqtt_username = $1 AND dc.type = 'logs'`, [mac, m.id]);
  if (!c) return;
  await db.query('INSERT INTO device_log_uploads (device_id, command_id, content) VALUES ($1, $2, $3)', [c.device_id, c.id, content]);
  await db.query(`INSERT INTO device_events (device_id, type, message) VALUES ($1, 'logs_uploaded', $2)`,
    [c.device_id, `${content.length} bytes`]);
}

// Sensor came online: send its queued commands, oldest first.
async function onOnline(mac, d) {
  const { rows } = await db.query(
    `SELECT * FROM device_commands WHERE device_id = $1 AND status = 'pending' AND expires_at > now() ORDER BY id`, [d.deviceId]);
  for (const c of rows) {
    try { await send(c, mac); } catch (err) { log.warn({ err: err.message, commandId: c.id }, 'queued command not sent'); return; }
  }
}

// Expire commands whose time ran out (every 10 s).
async function expire() {
  const { rows } = await db.query(
    `UPDATE device_commands SET status = 'expired' WHERE status IN ('pending', 'sent') AND expires_at <= now() RETURNING *`);
  for (const c of rows) emitStatus(c, await serialOf(c.device_id));
  const old = Date.now() - 120_000;
  for (const [k, p] of partial) if (p.at < old) partial.delete(k);
}

function start() {
  mqtt.on('cmd/ack', onAck);
  mqtt.on('logs', onLogs);
  live.onOnline(onOnline);
  setInterval(() => expire().catch((err) => log.error({ err }, 'command expiry failed')), 10_000).unref();
}

module.exports = { start, create, createNow, apiStatus, expire, TTL_S };
