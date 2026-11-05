// In-app alerts (docs/API.md §6). Alerts are in-app only in v1: they are
// stored in `alerts` and pushed on Socket.IO (alert:new / alert:ended) to
// users with alerts.receive on that device who have not muted it.
//
// Rules are checked on every live state (every 2 s while someone is present):
//   breath_low       present + in bed, 0 < br < low          for durationS
//   hr_out_of_range  present + in bed, hr > 0 and outside    for durationS
//   out_of_bed       out of bed inside [windowFrom, windowTo) for durationS
//                    (only after the person was in bed during this window)
//   no_movement      in bed with no movement (mv 0)          for durationS
//   device_offline   offline                                  for durationS
// An alert opens once the condition has lasted durationS and closes when it
// is no longer true. At most one open alert per device and type (DB index).
const { DateTime } = require('luxon');
const db = require('../db');
const log = require('../logger');
const live = require('./live');
const realtime = require('./realtime');

const SEVERITY = { breath_low: 'critical', hr_out_of_range: 'critical', out_of_bed: 'warning', no_movement: 'warning', device_offline: 'warning' };
const RULES_TTL_MS = 30_000;

const ruleCache = new Map();     // deviceId -> {at, rules: Map(type -> rule), tz, name}
const since = new Map();         // `${deviceId}:${type}` -> ms when the condition became true
const inBedSeen = new Map();     // deviceId -> ms of the last reading in bed
const offlineTimers = new Map(); // deviceId -> timeout

function forget(deviceId) { ruleCache.delete(deviceId); }

async function rulesFor(deviceId) {
  const hit = ruleCache.get(deviceId);
  if (hit && Date.now() - hit.at < RULES_TTL_MS) return hit;
  const d = await db.one('SELECT name, timezone, claim_stage FROM devices WHERE id = $1', [deviceId]);
  const { rows } = await db.query('SELECT * FROM alert_rules WHERE device_id = $1 AND is_enabled', [deviceId]);
  // Alerts only for sensors someone uses: owned, or in use by a vendor (not vendor stock, 009).
  const v = { at: Date.now(), tz: d?.timezone || 'Asia/Kolkata', name: d?.name, owned: d?.claim_stage === 'owned' || d?.claim_stage === 'vendor_use',
    rules: new Map(rows.map((r) => [r.type, r])) };
  ruleCache.set(deviceId, v);
  return v;
}

function inWindow(rule, tz) {
  if (!rule.window_from || !rule.window_to) return true;
  const t = DateTime.now().setZone(tz);
  const m = t.hour * 60 + t.minute;
  const [a, b] = [rule.window_from, rule.window_to].map((x) => { const [h, mm] = x.split(':').map(Number); return h * 60 + mm; });
  return a <= b ? m >= a && m < b : m >= a || m < b;
}

// Who gets alert:new for a device: alerts.receive, minus people who muted it.
async function recipients(deviceId) {
  const { rows } = await db.query(
    `SELECT p.user_id FROM device_user_permissions p
      WHERE p.device_id = $1 AND p.permission = 'alerts.receive'
        AND NOT EXISTS (SELECT 1 FROM user_device_alert_mutes m WHERE m.user_id = p.user_id AND m.device_id = $1)`, [deviceId]);
  return rows.map((r) => r.user_id);
}

function texts(type, rule, value) {
  switch (type) {
    case 'breath_low': return [`Breathing rate low: ${value} /min`, `Rule: breath rate below ${rule.low_value} /min for ${rule.duration_s} s`];
    case 'hr_out_of_range': return [`Heart rate ${value < rule.low_value ? 'low' : 'high'}: ${value} bpm`,
      `Rule: heart rate below ${rule.low_value} or above ${rule.high_value} bpm for ${rule.duration_s} s`];
    case 'out_of_bed': return [`Out of bed for ${Math.round(rule.duration_s / 60)} min`,
      `Rule: out of bed more than ${Math.round(rule.duration_s / 60)} min between ${rule.window_from?.slice(0, 5)} and ${rule.window_to?.slice(0, 5)}`];
    case 'no_movement': return [`No movement for ${Math.round(rule.duration_s / 3600)} h`, `Rule: in bed with no movement for ${Math.round(rule.duration_s / 60)} min`];
    default: return ['Device offline', `No data for more than ${Math.round(rule.duration_s / 60)} min. Check power and Wi-Fi.`];
  }
}

async function open(deviceId, serial, type, rule, value) {
  const [title, detail] = texts(type, rule, value);
  const { rows: [a] } = await db.query(
    `INSERT INTO alerts (device_id, type, severity, title, detail, value) VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (device_id, type) WHERE ended_at IS NULL DO NOTHING RETURNING id, started_at`,
    [deviceId, type, SEVERITY[type], title, detail, value ?? null]);
  if (!a) return; // already open
  const payload = { alertId: a.id, deviceId, serial, type, severity: SEVERITY[type], title, at: a.started_at };
  for (const u of await recipients(deviceId)) realtime.emitToUser(u, 'alert:new', payload);
}

async function close(deviceId, type) {
  const { rows } = await db.query(
    'UPDATE alerts SET ended_at = now() WHERE device_id = $1 AND type = $2 AND ended_at IS NULL RETURNING id, ended_at', [deviceId, type]);
  if (!rows[0]) return;
  for (const u of await recipients(deviceId)) {
    realtime.emitToUser(u, 'alert:ended', { alertId: rows[0].id, deviceId, endedAt: rows[0].ended_at });
  }
}

// condition true/false for one rule -> open after durationS, close at once
async function track(d, type, rule, cond, value) {
  const key = `${d.deviceId}:${type}`;
  if (!cond) {
    if (since.has(key)) since.delete(key);
    await close(d.deviceId, type);
    return;
  }
  if (!since.has(key)) since.set(key, Date.now());
  if (Date.now() - since.get(key) >= (rule.duration_s || 0) * 1000) await open(d.deviceId, d.serial, type, rule, value);
}

async function onLive(d, s) {
  const r = await rulesFor(d.deviceId);
  if (!r.owned || !r.rules.size) return;
  const present = s.pr === 1 && s.bed === 1;
  if (s.bed === 1) inBedSeen.set(d.deviceId, Date.now());
  const rule = (t) => r.rules.get(t);
  if (rule('breath_low')) {
    const ru = rule('breath_low');
    await track(d, 'breath_low', ru, present && s.br > 0 && s.br < Number(ru.low_value), s.br);
  }
  if (rule('hr_out_of_range')) {
    const ru = rule('hr_out_of_range');
    await track(d, 'hr_out_of_range', ru, present && s.hr > 0 && (s.hr < Number(ru.low_value) || s.hr > Number(ru.high_value)), s.hr);
  }
  if (rule('out_of_bed')) {
    const ru = rule('out_of_bed');
    const winMs = 24 * 3600_000;
    const wasInBed = Date.now() - (inBedSeen.get(d.deviceId) || 0) < winMs;
    await track(d, 'out_of_bed', ru, s.bed === 0 && wasInBed && inWindow(ru, r.tz), null);
  }
  if (rule('no_movement')) {
    await track(d, 'no_movement', rule('no_movement'), s.bed === 1 && s.mv === 0, null);
  }
}

// Offline: open after durationS unless the device comes back first.
async function onStatus(d, online) {
  clearTimeout(offlineTimers.get(d.deviceId));
  offlineTimers.delete(d.deviceId);
  if (online) {
    await close(d.deviceId, 'device_offline');
    return;
  }
  const r = await rulesFor(d.deviceId);
  const rule = r.rules.get('device_offline');
  if (!r.owned || !rule) return;
  offlineTimers.set(d.deviceId, setTimeout(() => {
    offlineTimers.delete(d.deviceId);
    if (live.getStatus(d.deviceId)?.online) return;
    open(d.deviceId, d.serial, 'device_offline', rule, null).catch((err) => log.error({ err }, 'offline alert failed'));
  }, (rule.duration_s || 900) * 1000).unref());
}

function start() {
  live.onLive((d, s) => onLive(d, s));
  live.onPresence((d, online) => onStatus(d, online));
}

module.exports = { start, forget, SEVERITY };
