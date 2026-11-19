// Fall Detection product (migration 013, docs/DEVICE-DATA.md §8).
// ESP32-S3 + TI IWR6843AOP radar. The device runs the fall algorithm itself
// and sends only two kinds of message:
//   fall/<mac>/alive   "I am alive" every 60 s, QoS 0. NOT stored: it marks the
//                      device online and goes to the screen as live values.
//   fall/<mac>/event   one FALL or RECOVERED, QoS 1. STORED in fall_events.
//   fall/<mac>/status  retained "online" / last will "offline" (same as sleep).
// A FALL opens an in-app 'fall' alert; the matching RECOVERED closes it.
const db = require('../db');
const log = require('../logger');
const mqtt = require('./mqtt');
const live = require('./live');
const realtime = require('./realtime');
const alerts = require('./alerts');

const PRESETS = new Set(['LOW', 'MED', 'HIGH']);

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const flag = (v) => (v === 1 || v === true ? 1 : v === 0 || v === false ? 0 : null);
// [x, y, z] of finite numbers, else nulls (the hardware may not give it).
const vec = (v) => (Array.isArray(v) && v.length === 3 && v.every((x) => num(x) !== null) ? v : [null, null, null]);
// Device time if it looks synced (after 2020, not in the future), else now.
const when = (ts) => (Number.isInteger(ts) && ts > 1_600_000_000 && ts < Date.now() / 1000 + 3600 ? new Date(ts * 1000) : new Date());
const isCounter = (v) => Number.isSafeInteger(v) && v >= 0;

// ---- fall/<mac>/alive -----------------------------------------------------
// {"fw":"0.1.0","up":36012,"rssi":-61,"radar":1,"pr":1,"preset":"MED"}
async function onAlive(mac, payload) {
  const d = await live.entry(mac);
  const m = live.parseJson(payload);
  if (!d || !m) return;
  await live.seen(mac, d);
  const values = {
    product: 'fall',
    pr: flag(m.pr),
    radar: flag(m.radar),
    preset: PRESETS.has(m.preset) ? m.preset : null,
    rssi: num(m.rssi),
  };
  live.setLive(d, values);
  const fwChanged = live.noteFirmware(d, m.fw);
  d.rssi = values.rssi;
  d.uptimeS = num(m.up) ?? d.uptimeS;

  // Connection health to the DB, as for the sleep device: on a firmware or
  // radar change, else every 5 minutes. radar_ok changes also log an event.
  const radarOk = values.radar === null ? null : values.radar === 1;
  const radarChanged = radarOk !== null && d.radarOk !== undefined && d.radarOk !== radarOk;
  if (fwChanged || radarChanged || d.radarOk === undefined || Date.now() - d.dbWrittenAt > live.HEARTBEAT_MS) {
    d.dbWrittenAt = Date.now();
    await db.query(
      `UPDATE device_state SET last_seen_at = $2, wifi_rssi = $3, uptime_s = $4,
              fw_version = COALESCE($5, fw_version), radar_ok = COALESCE($6, radar_ok), updated_at = now()
        WHERE device_id = $1`,
      [d.deviceId, d.lastSeenAt, d.rssi, d.uptimeS, d.fw, radarOk]);
  }
  if (radarChanged) {
    await db.query('INSERT INTO device_events (device_id, type, severity, message) VALUES ($1, $2, $3, $4)',
      [d.deviceId, radarOk ? 'radar_ok' : 'radar_fault', radarOk ? 'info' : 'warning', 'from alive message']);
  }
  if (radarOk !== null) d.radarOk = radarOk;
}

// ---- fall/<mac>/event -----------------------------------------------------
// FALL:      {"eid":17,"t":"fall","ts":1763541000,"tid":1,"ema_now":0.42,"ema_peak":1.68,
//             "drop_m":1.26,"drop_pct":75,"pos":[x,y,z],"vel":[vx,vy,vz],"h":0.42,"pr":1,"preset":"MED"}
// RECOVERED: {"eid":18,"t":"recovered","ts":1763541095,"tid":1,"fall_eid":17}
// Returns the stored row (or null: invalid, or a resend of an eid we already have).
function validate(m) {
  if (!m || (m.t !== 'fall' && m.t !== 'recovered')) return null;
  if (!isCounter(m.eid) || !Number.isInteger(m.tid) || m.tid < 0 || m.tid > 255) return null;
  if (m.t === 'recovered') {
    return { kind: 'recovered', eid: m.eid, tid: m.tid, at: when(m.ts), fallEid: isCounter(m.fall_eid) ? m.fall_eid : null };
  }
  const dropM = num(m.drop_m);
  if (dropM === null) return null;
  return {
    kind: 'fall', eid: m.eid, tid: m.tid, at: when(m.ts),
    emaNow: num(m.ema_now), emaPeak: num(m.ema_peak), dropM, dropPct: num(m.drop_pct),
    pos: vec(m.pos), vel: vec(m.vel), h: num(m.h),
    pr: flag(m.pr), preset: PRESETS.has(m.preset) ? m.preset : null,
  };
}

const VIEW_COLS = `id, eid, kind, occurred_at, tid, ema_now, ema_peak, drop_m, drop_pct, pos_x, pos_y, pos_z,
  vel_x, vel_y, vel_z, height_m, presence, preset, fall_eid, recovered_at, recovery_s`;

async function onFallEvent(mac, payload) {
  const d = await live.entry(mac);
  const m = live.parseJson(payload);
  if (!d || !m) return null;
  await live.seen(mac, d);
  const e = validate(m);
  if (!e) {
    log.info({ mac, t: m.t, eid: m.eid }, 'invalid fall event ignored');
    return null;
  }

  if (e.kind === 'fall') {
    const { rows: [row] } = await db.query(
      `INSERT INTO fall_events (device_id, eid, kind, occurred_at, tid, ema_now, ema_peak, drop_m, drop_pct,
                                pos_x, pos_y, pos_z, vel_x, vel_y, vel_z, height_m, presence, preset)
       VALUES ($1, $2, 'fall', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       ON CONFLICT (device_id, eid) DO NOTHING RETURNING ${VIEW_COLS}`,
      [d.deviceId, e.eid, e.at, e.tid, e.emaNow, e.emaPeak, e.dropM, e.dropPct, ...e.pos, ...e.vel, e.h,
        e.pr === null ? null : e.pr === 1, e.preset]);
    if (!row) return null; // resend
    await alerts.fallStarted(d, Math.round(e.dropM * 100), e.at);
    realtime.emitToDevice(d.deviceId, 'device:fall', { deviceId: d.deviceId, serial: d.serial, event: view(row) });
    log.warn({ mac, eid: e.eid, tid: e.tid, dropM: e.dropM }, 'fall detected');
    return row;
  }

  // RECOVERED: store it, then close the FALL it belongs to. Without fall_eid
  // (or an unknown one) it closes the latest open fall of the same track id.
  return db.tx(async (c) => {
    const { rows: [row] } = await c.query(
      `INSERT INTO fall_events (device_id, eid, kind, occurred_at, tid, fall_eid)
       VALUES ($1, $2, 'recovered', $3, $4, $5)
       ON CONFLICT (device_id, eid) DO NOTHING RETURNING ${VIEW_COLS}`,
      [d.deviceId, e.eid, e.at, e.tid, e.fallEid]);
    if (!row) return null;
    const openFall = async (extra, vals) => (await c.query(
      `SELECT id, eid, occurred_at FROM fall_events
        WHERE device_id = $1 AND kind = 'fall' AND recovered_at IS NULL ${extra}
        ORDER BY occurred_at DESC, id DESC LIMIT 1 FOR UPDATE`, [d.deviceId, ...vals])).rows[0];
    const fall = (e.fallEid !== null && await openFall('AND eid = $2', [e.fallEid]))
      || await openFall('AND tid = $2', [e.tid]);
    if (fall) {
      const recoveryS = Math.max(0, Math.round((e.at - new Date(fall.occurred_at)) / 1000));
      await c.query('UPDATE fall_events SET recovered_at = $2, recovery_s = $3 WHERE id = $1', [fall.id, e.at, recoveryS]);
      if (row.fall_eid === null) await c.query('UPDATE fall_events SET fall_eid = $2 WHERE id = $1', [row.id, fall.eid]);
    }
    const stillDown = (await c.query(
      "SELECT 1 FROM fall_events WHERE device_id = $1 AND kind = 'fall' AND recovered_at IS NULL LIMIT 1", [d.deviceId])).rowCount;
    return { row, stillDown };
  }).then(async (r) => {
    if (!r) return null;
    if (!r.stillDown) await alerts.fallEnded(d, e.at);
    realtime.emitToDevice(d.deviceId, 'device:fall', { deviceId: d.deviceId, serial: d.serial, event: view(r.row) });
    log.info({ mac, eid: e.eid, tid: e.tid }, 'fall recovered');
    return r.row;
  });
}

// One stored row as the API shows it (docs/API.md §4b).
function view(r) {
  const xyz = (a, b, c) => (a === null && b === null && c === null ? null : [a, b, c]);
  return {
    id: r.id,
    eid: Number(r.eid),
    kind: r.kind,
    at: r.occurred_at,
    tid: r.tid,
    ...(r.kind === 'fall' ? {
      emaNow: r.ema_now, emaPeak: r.ema_peak, dropM: r.drop_m, dropPct: r.drop_pct,
      pos: xyz(r.pos_x, r.pos_y, r.pos_z), vel: xyz(r.vel_x, r.vel_y, r.vel_z),
      heightM: r.height_m, presence: r.presence, preset: r.preset,
      recoveredAt: r.recovered_at, recoveryS: r.recovery_s,
    } : { fallEid: r.fall_eid === null ? null : Number(r.fall_eid) }),
  };
}

// Newest first, keyset paging by id.
async function list(deviceId, { limit = 30, cursor = null } = {}) {
  const rows = await db.many(
    `SELECT ${VIEW_COLS} FROM fall_events WHERE device_id = $1 AND ($2::bigint IS NULL OR id < $2)
      ORDER BY id DESC LIMIT $3`, [deviceId, cursor, limit + 1]);
  const more = rows.length > limit;
  return { items: rows.slice(0, limit).map(view), nextCursor: more ? String(rows[limit - 1].id) : null };
}

function start() {
  mqtt.onFall('status', (mac, p) => live.withLock(mac, () => live._handlers.onStatus(mac, p)));
  mqtt.onFall('alive', (mac, p) => live.withLock(mac, () => onAlive(mac, p)));
  mqtt.onFall('event', (mac, p) => live.withLock(mac, () => onFallEvent(mac, p)));
}

module.exports = { start, list, view, validate, _handlers: { onAlive, onFallEvent } };
