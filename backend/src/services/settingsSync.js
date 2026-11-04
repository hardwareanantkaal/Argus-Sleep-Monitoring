// Sensor settings sync (docs/API.md §3.6/3.7, §11 settings/set + settings/ack).
// Same idea as Water Tank:
//   1. A real change bumps device_settings.version (DB trigger) and is logged.
//   2. We publish the whole set RETAINED on <p>/<d>/settings/set, so a sensor
//      that is offline gets it the moment it reconnects.
//   3. The sensor saves to flash and answers {"v":N} on settings/ack. We
//      apply it only if applied_version < N <= version (old or duplicate acks
//      are ignored; the sensor must still re-ack a duplicate).
//   4. When a sensor comes online behind, we publish again.
const db = require('../db');
const log = require('../logger');
const mqtt = require('./mqtt');
const realtime = require('./realtime');
const live = require('./live');
const { syncState } = require('./deviceViews');

// The settings/set message (DEVICE-DATA.md §5).
const payload = (s) => ({
  v: s.version, exit_s: s.exit_s, live_s: s.live_s, idle_s: s.idle_s,
  struggle: s.struggle ? 1 : 0, unattended: s.unattended ? 1 : 0, unatt_min: s.unatt_min,
});

// The sensorSettings object of API.md §3.
function view(s, online) {
  return {
    exitS: s.exit_s, liveS: s.live_s, idleS: s.idle_s, struggle: s.struggle, unattended: s.unattended,
    unattMin: s.unatt_min, version: s.version, appliedVersion: s.applied_version,
    sync: syncState(s.version, s.applied_version, online),
  };
}

const isOnline = (deviceId) => !!live.getStatus(deviceId)?.online;

function emitSync(deviceId, s) {
  realtime.emitToDevice(deviceId, 'settings:sync', {
    deviceId, version: s.version, appliedVersion: s.applied_version,
    sync: syncState(s.version, s.applied_version, isOnline(deviceId)),
  });
}

// Publish the current settings (retained). Safe to call any time; if MQTT is
// down the sensor still gets them on the next republish (online / reconnect).
async function publish(deviceId) {
  const s = await db.one(
    `SELECT ds.*, d.mqtt_username FROM device_settings ds JOIN devices d ON d.id = ds.device_id WHERE ds.device_id = $1`,
    [deviceId]);
  if (!s) return null;
  try {
    await mqtt.publish(s.mqtt_username, 'settings/set', payload(s), { qos: 1, retain: true });
    await db.query('UPDATE device_settings SET sent_at = now() WHERE device_id = $1', [deviceId]);
  } catch (err) {
    log.warn({ err: err.message, deviceId }, 'settings publish failed (will retry on reconnect)');
  }
  emitSync(deviceId, s);
  return s;
}

// PATCH 3.7: write, let the trigger bump the version, publish.
const COLS = { exitS: 'exit_s', liveS: 'live_s', idleS: 'idle_s', struggle: 'struggle', unattended: 'unattended', unattMin: 'unatt_min' };
async function update(deviceId, changes, userId) {
  const sets = [];
  const vals = [deviceId, userId];
  for (const [k, col] of Object.entries(COLS)) {
    if (changes[k] === undefined) continue;
    vals.push(changes[k]);
    sets.push(`${col} = $${vals.length}`);
  }
  if (sets.length) {
    await db.query(`UPDATE device_settings SET ${sets.join(', ')}, updated_by = $2 WHERE device_id = $1`, vals);
    await publish(deviceId);
  }
  const s = await db.one('SELECT * FROM device_settings WHERE device_id = $1', [deviceId]);
  return view(s, isOnline(deviceId));
}

async function get(deviceId) {
  const s = await db.one('SELECT * FROM device_settings WHERE device_id = $1', [deviceId]);
  return s ? view(s, isOnline(deviceId)) : null;
}

// settings/ack {"v":N}
async function onAck(mac, buf) {
  let v;
  try { v = JSON.parse(buf.toString()).v; } catch { return; }
  if (!Number.isInteger(v)) return;
  const { rows: [s] } = await db.query(
    `UPDATE device_settings ds SET applied_version = $2, applied_at = now()
       FROM devices d
      WHERE d.id = ds.device_id AND d.mqtt_username = $1 AND ds.applied_version < $2 AND $2 <= ds.version
      RETURNING ds.*`, [mac, v]);
  if (!s) return; // old, duplicate or unknown version: nothing to do
  await db.query(`INSERT INTO device_events (device_id, type, message) VALUES ($1, 'settings_applied', $2)`,
    [s.device_id, `version ${v}`]);
  emitSync(s.device_id, s);
}

// Sensor came online: re-send if it hasn't confirmed the latest version.
async function onOnline(mac, d) {
  const s = await db.one('SELECT version, applied_version FROM device_settings WHERE device_id = $1', [d.deviceId]);
  if (s && s.applied_version < s.version) await publish(d.deviceId);
}

// A deleted device: clear its retained settings on the broker.
const clear = (mac) => mqtt.publish(mac, 'settings/set', '', { qos: 1, retain: true }).catch(() => {});

function start() {
  mqtt.on('settings/ack', onAck);
  live.onOnline(onOnline);
}

module.exports = { start, publish, update, get, view, clear, payload };
