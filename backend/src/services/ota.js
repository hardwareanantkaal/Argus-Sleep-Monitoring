// OTA firmware updates (docs/API.md §9.5–9.9, §11 ota / ota/status).
//
// A rollout freezes its device list when it starts (ota_rollout_devices).
// Each device is sent  <p>/<d>/ota {rid, ver, url, sha256, size}  only when
//   - the rollout is running,
//   - the device is online, and
//   - the device's local time is inside the install window (e.g. 10:00–18:00,
//     so sensors never reboot while someone sleeps).
// The url is /fw/<releaseId>.bin?t=<10-minute token>. The device reports
// downloading / success / failed on ota/status; success also counts when it
// comes back reporting fw == the new version (info or state).
//   per device: pending -> sent -> downloading -> success | failed   (skipped)
//   rollout:    running <-> paused -> finished | cancelled
const jwt = require('jsonwebtoken');
const { DateTime } = require('luxon');
const config = require('../config');
const db = require('../db');
const log = require('../logger');
const mqtt = require('./mqtt');
const live = require('./live');
const realtime = require('./realtime');

// deferred = the firmware postponed it (sleep session active); re-offered every 60 s.
const OPEN = ['pending', 'deferred', 'sent', 'downloading'];

// ---- download tokens (/fw/<id>.bin?t=...) --------------------------------
function signDownload(releaseId, mac) {
  return jwt.sign({ r: releaseId, m: mac }, config.jwtSecret,
    { algorithm: 'HS256', audience: 'fw', expiresIn: config.otaTokenTtlS });
}
function verifyDownload(token, releaseId) {
  try {
    const p = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'], audience: 'fw' });
    return p.r === releaseId ? p : null;
  } catch {
    return null;
  }
}

// ---- progress ------------------------------------------------------------
async function counts(rolloutId, q = db) {
  const { rows } = await q.query(
    'SELECT status, count(*)::int AS n FROM ota_rollout_devices WHERE rollout_id = $1 GROUP BY status', [rolloutId]);
  const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
  return {
    done: by.success || 0,
    downloading: (by.sent || 0) + (by.downloading || 0),
    waiting: (by.pending || 0) + (by.deferred || 0),
    deferred: by.deferred || 0,
    failed: by.failed || 0,
    skipped: by.skipped || 0,
  };
}

async function emitProgress(rolloutId, deviceId = null, deviceStatus = null) {
  const r = await db.one('SELECT status FROM ota_rollouts WHERE id = $1', [rolloutId]);
  if (!r) return;
  realtime.emitToAdmins('rollouts', 'rollout:progress',
    { rolloutId, status: r.status, counts: await counts(rolloutId), deviceId, deviceStatus });
}

// A running rollout with nothing left to do is finished.
async function maybeFinish(rolloutId) {
  const r = await db.query(
    `UPDATE ota_rollouts SET status = 'finished', finished_at = now()
      WHERE id = $1 AND status = 'running'
        AND NOT EXISTS (SELECT 1 FROM ota_rollout_devices WHERE rollout_id = $1 AND status = ANY($2))
      RETURNING id`, [rolloutId, OPEN]);
  if (r.rowCount) await emitProgress(rolloutId);
}

// ---- sending -------------------------------------------------------------
function inWindow(from, to, tz, now = DateTime.now()) {
  if (!from || !to) return true;
  const t = now.setZone(tz || 'Asia/Kolkata');
  const m = t.hour * 60 + t.minute;
  const [fh, fm] = from.split(':').map(Number);
  const [th, tm] = to.split(':').map(Number);
  const a = fh * 60 + fm;
  const b = th * 60 + tm;
  return a <= b ? m >= a && m < b : m >= a || m < b;   // window across midnight, e.g. 22:00–06:00
}

// Send the OTA message to every device of running rollouts that is pending,
// online and inside its window. `onlyMac` limits it to one device.
async function dispatch(onlyMac = null) {
  const { rows } = await db.query(
    `SELECT rd.rollout_id, rd.device_id, rd.status AS prev_status, d.mqtt_username AS mac, d.timezone, r.window_from, r.window_to,
            f.id AS release_id, f.version, f.sha256, f.file_size
       FROM ota_rollout_devices rd
       JOIN ota_rollouts r ON r.id = rd.rollout_id AND r.status = 'running'
       JOIN firmware_releases f ON f.id = r.release_id
       JOIN devices d ON d.id = rd.device_id AND NOT d.is_disabled
      WHERE rd.status IN ('pending', 'deferred') AND ($1::text IS NULL OR d.mqtt_username = $1)
      ORDER BY rd.rollout_id, d.serial_no`, [onlyMac]);
  for (const x of rows) {
    if (!live.getStatus(x.device_id)?.online) continue;
    if (!inWindow(x.window_from?.slice(0, 5), x.window_to?.slice(0, 5), x.timezone)) continue;
    const url = `${config.fwBaseUrl}/fw/${x.release_id}.bin?t=${signDownload(x.release_id, x.mac)}`;
    try {
      await mqtt.publish(x.mac, 'ota', { rid: x.rollout_id, ver: x.version, url, sha256: x.sha256, size: x.file_size }, { qos: 1 });
    } catch (err) {
      log.warn({ err: err.message, mac: x.mac }, 'ota publish failed; will retry');
      continue;
    }
    const u = await db.query(
      `UPDATE ota_rollout_devices SET status = 'sent', updated_at = now()
        WHERE rollout_id = $1 AND device_id = $2 AND status IN ('pending', 'deferred') `,
      [x.rollout_id, x.device_id]);
    if (u.rowCount && x.prev_status !== 'deferred') {
      await db.query(`INSERT INTO device_events (device_id, type, message, data) VALUES ($1, 'ota_started', $2, $3)`,
        [x.device_id, `update to ${x.version} sent`, JSON.stringify({ rid: x.rollout_id })]);
      await emitProgress(x.rollout_id, x.device_id, 'sent');
    }
  }
}

// Mark one device's result. Only moves forward from an open status.
async function setDeviceStatus(rolloutId, deviceId, status, error = null) {
  const allowedFrom = status === 'downloading' || status === 'deferred' ? ['pending', 'deferred', 'sent'] : OPEN;
  const u = await db.query(
    `UPDATE ota_rollout_devices SET status = $3, error = $4, updated_at = now()
      WHERE rollout_id = $1 AND device_id = $2 AND status = ANY($5) RETURNING rollout_id`,
    [rolloutId, deviceId, status, error, allowedFrom]);
  if (!u.rowCount) return false;
  if (status === 'success' || status === 'failed') {
    const ver = await db.one('SELECT f.version FROM ota_rollouts r JOIN firmware_releases f ON f.id = r.release_id WHERE r.id = $1', [rolloutId]);
    await db.query('INSERT INTO device_events (device_id, type, severity, message, data) VALUES ($1, $2, $3, $4, $5)',
      [deviceId, status === 'success' ? 'ota_success' : 'ota_failed', status === 'success' ? 'info' : 'warning',
        status === 'success' ? `updated to ${ver?.version}` : `update to ${ver?.version} failed: ${error || 'unknown'}`,
        JSON.stringify({ rid: rolloutId })]);
  }
  await emitProgress(rolloutId, deviceId, status);
  if (status === 'success' || status === 'failed') await maybeFinish(rolloutId);
  return true;
}

// ota/status {"rid":7,"s":"downloading"|"success"|"failed","err":"..."}
async function onStatus(mac, buf) {
  let m;
  try { m = JSON.parse(buf.toString()); } catch { return; }
  if (!Number.isInteger(m?.rid) || !['downloading', 'deferred', 'success', 'failed'].includes(m.s)) return;
  const d = await db.one('SELECT id FROM devices WHERE mqtt_username = $1', [mac]);
  if (!d) return;
  const err = m.s === 'failed' || m.s === 'deferred' ? String(m.err || m.s).slice(0, 200) : null;
  await setDeviceStatus(m.rid, d.id, m.s, err);
}

// info/state reported a firmware version: an open OTA to that version = success.
async function onFirmware(d, fw) {
  if (!fw) return;
  const { rows } = await db.query(
    `SELECT rd.rollout_id FROM ota_rollout_devices rd
       JOIN ota_rollouts r ON r.id = rd.rollout_id JOIN firmware_releases f ON f.id = r.release_id
      WHERE rd.device_id = $1 AND rd.status IN ('sent', 'downloading') AND f.version = $2`, [d.deviceId, fw]);
  for (const r of rows) await setDeviceStatus(r.rollout_id, d.deviceId, 'success');
}

// ---- rollouts ------------------------------------------------------------
// Freeze the device list. Devices with auto_update off are left out unless
// listed by serial; devices already on the version are skipped; a device
// still open in an older rollout is moved over (old row -> skipped).
async function create(c, { release, target, percent, serials, fromVersion, windowFrom, windowTo, notes, userId }) {
  let sql = `SELECT d.id, s.fw_version FROM devices d LEFT JOIN device_state s ON s.device_id = d.id
              WHERE NOT d.is_disabled AND COALESCE(s.fw_version, '') <> $1`;
  const vals = [release.version];
  if (target === 'serials') {
    vals.push(serials);
    sql += ` AND d.serial_no = ANY($${vals.length}::text[])`;
  } else {
    sql += ' AND d.auto_update';
    if (target === 'from_version') { vals.push(fromVersion); sql += ` AND s.fw_version = $${vals.length}`; }
  }
  let { rows: devices } = await c.query(sql, vals);
  if (target === 'percent') {
    devices = devices.sort(() => Math.random() - 0.5).slice(0, Math.ceil((devices.length * percent) / 100));
  }
  const { rows: [r] } = await c.query(
    `INSERT INTO ota_rollouts (release_id, target, target_percent, target_from_version, window_from, window_to, notes, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
    [release.id, target, target === 'percent' ? percent : null, target === 'from_version' ? fromVersion : null,
      windowFrom, windowTo, notes || null, userId]);
  if (devices.length) {
    const ids = devices.map((x) => x.id);
    await c.query(
      `UPDATE ota_rollout_devices SET status = 'skipped', error = 'replaced by rollout ' || $2, updated_at = now()
        WHERE device_id = ANY($1::uuid[]) AND status = ANY($3)`, [ids, r.id, OPEN]);
    await c.query(
      `INSERT INTO ota_rollout_devices (rollout_id, device_id, from_version)
       SELECT $1, x.id, x.fw FROM unnest($2::uuid[], $3::text[]) AS x(id, fw)`,
      [r.id, ids, devices.map((x) => x.fw_version)]);
  } else {
    await c.query(`UPDATE ota_rollouts SET status = 'finished', finished_at = now() WHERE id = $1`, [r.id]);
  }
  return { rolloutId: r.id, devices: devices.length };
}

// Pause / resume / cancel / retry-failed. Returns the new status.
async function control(rolloutId, action) {
  const r = await db.one('SELECT status FROM ota_rollouts WHERE id = $1', [rolloutId]);
  if (!r) return null;
  if (action === 'pause') {
    if (r.status !== 'running') return { error: `cannot pause a ${r.status} rollout` };
    await db.query(`UPDATE ota_rollouts SET status = 'paused' WHERE id = $1`, [rolloutId]);
  } else if (action === 'resume') {
    if (r.status !== 'paused') return { error: `cannot resume a ${r.status} rollout` };
    await db.query(`UPDATE ota_rollouts SET status = 'running' WHERE id = $1`, [rolloutId]);
  } else if (action === 'cancel') {
    if (!['running', 'paused'].includes(r.status)) return { error: `cannot cancel a ${r.status} rollout` };
    await db.query(`UPDATE ota_rollouts SET status = 'cancelled', finished_at = now() WHERE id = $1`, [rolloutId]);
    await db.query(`UPDATE ota_rollout_devices SET status = 'skipped', error = 'rollout cancelled', updated_at = now()
                     WHERE rollout_id = $1 AND status IN ('pending', 'deferred')`, [rolloutId]);
  } else if (action === 'retry') {
    if (r.status === 'cancelled') return { error: 'cannot retry a cancelled rollout' };
    const u = await db.query(`UPDATE ota_rollout_devices SET status = 'pending', error = NULL, updated_at = now()
                               WHERE rollout_id = $1 AND status = 'failed'`, [rolloutId]);
    if (u.rowCount) await db.query(`UPDATE ota_rollouts SET status = 'running', finished_at = NULL WHERE id = $1 AND status <> 'paused'`, [rolloutId]);
  }
  await emitProgress(rolloutId);
  dispatch().catch((err) => log.error({ err }, 'ota dispatch failed'));
  return { status: (await db.one('SELECT status FROM ota_rollouts WHERE id = $1', [rolloutId])).status };
}

function start() {
  mqtt.on('ota/status', onStatus);
  live.onOnline((mac) => dispatch(mac));
  live.onFirmware(onFirmware);
  // Every minute: install windows open, MQTT reconnects, etc.
  setInterval(() => dispatch().catch((err) => log.error({ err }, 'ota dispatch failed')), 60_000).unref();
}

module.exports = { start, create, control, dispatch, counts, verifyDownload, signDownload, inWindow, OPEN };
