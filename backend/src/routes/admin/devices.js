// docs/API.md §8 Admin: dashboard, devices, factory registration.
// (Commands, logs and events, 8.8–8.11, come with the commands step.)
const express = require('express');
const db = require('../../db');
const { parse, z } = require('../../lib/validate');
const { audit } = require('../../lib/audit');
const claim = require('../../lib/claim');
const { requireStaff } = require('../../middleware/auth');
const { releaseDevice } = require('../../services/devices');
const live = require('../../services/live');
const realtime = require('../../services/realtime');
const mqttAuth = require('../mqttAuth');
const { E } = require('../../errors');

const router = express.Router();
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// "34:85:18:A1:0F:22", "34-85-18-a1-0f-22" or "348518a10f22" -> "348518a10f22"
const normMac = (s) => String(s || '').toLowerCase().replace(/[^0-9a-f]/g, '');
const macColons = (m) => m.match(/.{2}/g).join(':').toUpperCase();

// Pass a transaction client `c` to lock the row (FOR UPDATE).
async function loadDevice(id, c = null) {
  if (!isUuid(id)) throw E.notFound('Device not found');
  const { rows: [d] } = await (c || db).query(`SELECT * FROM devices WHERE id = $1${c ? ' FOR UPDATE' : ''}`, [id]);
  if (!d) throw E.notFound('Device not found');
  return d;
}

// Opaque list cursor = base64 of "<created_at ISO>|<id>" (newest first).
const encCursor = (r) => Buffer.from(`${new Date(r.created_at).toISOString()}|${r.id}`).toString('base64url');
function decCursor(c) {
  if (!c) return null;
  const [at, id] = Buffer.from(c, 'base64url').toString().split('|');
  if (!at || !isUuid(id) || Number.isNaN(Date.parse(at))) throw E.bad('VALIDATION', 'Bad cursor', 'cursor');
  return { at, id };
}

// 8.1 Dashboard (any staff)
router.get('/dashboard', requireStaff(), async (req, res) => {
  const c = await db.one(`
    SELECT (SELECT count(*) FROM devices)::int AS registered,
           (SELECT count(*) FROM device_state s JOIN devices d ON d.id = s.device_id WHERE s.is_online)::int AS online,
           (SELECT count(*) FROM devices WHERE owner_id IS NULL)::int AS unclaimed,
           (SELECT count(*) FROM devices WHERE is_disabled)::int AS disabled,
           (SELECT count(*) FROM users WHERE staff_role_id IS NULL AND deleted_at IS NULL)::int AS customers,
           (SELECT count(*) FROM devices WHERE created_at > now() - interval '7 days')::int AS registered_week,
           (SELECT count(*) FROM users WHERE staff_role_id IS NULL AND deleted_at IS NULL
                                       AND created_at > now() - interval '7 days')::int AS customers_week,
           (SELECT count(*) FROM ota_rollouts WHERE status = 'running')::int AS rollouts_running`);
  const hourly = await db.many(
    `SELECT hour, devices_online AS online FROM fleet_stats_hourly
      WHERE hour > now() - interval '24 hours' ORDER BY hour`);
  const fw = await db.many(
    `SELECT fw_version AS version, count(*)::int AS count FROM device_state
      WHERE fw_version IS NOT NULL GROUP BY fw_version ORDER BY count DESC, version DESC`);
  const recentAudit = req.staffPerms.has('audit.view')
    ? await db.many(`SELECT id, created_at AS at, actor_name AS "actorName", action, target_type AS "targetType",
                            target_label AS "targetLabel", detail FROM audit_log ORDER BY created_at DESC LIMIT 5`)
    : undefined;
  res.json({
    counts: {
      registered: c.registered, online: c.online,
      offline: c.registered - c.online - c.unclaimed > 0 ? c.registered - c.online - c.unclaimed : 0,
      unclaimed: c.unclaimed, disabled: c.disabled, customers: c.customers,
      registeredThisWeek: c.registered_week, customersThisWeek: c.customers_week, rolloutsRunning: c.rollouts_running,
    },
    onlineHourly: hourly,
    fwVersions: fw,
    recentAudit,
  });
});

// 8.2 Device list with search and filters
router.get('/devices', requireStaff('devices.view'), async (req, res) => {
  const q = parse(z.object({
    q: z.string().trim().max(60).optional(),
    status: z.enum(['online', 'offline', 'unclaimed', 'disabled']).optional(),
    fw: z.string().max(40).optional(),
    tz: z.string().max(60).optional(),
    registeredFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: z.string().max(200).optional(),
  }), req.query);
  const where = [];
  const vals = [];
  const add = (sql, v) => { vals.push(v); where.push(sql.replaceAll('?', `$${vals.length}`)); };
  if (q.q) {
    const mac = normMac(q.q);
    vals.push(`%${q.q}%`);
    const i = vals.length;
    let macSql = '';
    if (mac.length >= 4) { vals.push(`%${mac}%`); macSql = ` OR d.mqtt_username LIKE $${vals.length}`; }
    where.push(`(d.serial_no ILIKE $${i} OR d.name ILIKE $${i} OR o.full_name ILIKE $${i} OR o.phone ILIKE $${i}${macSql})`);
  }
  if (q.status === 'online') where.push('s.is_online AND d.owner_id IS NOT NULL');
  if (q.status === 'offline') where.push('NOT COALESCE(s.is_online, false) AND d.owner_id IS NOT NULL AND NOT d.is_disabled');
  if (q.status === 'unclaimed') where.push('d.owner_id IS NULL');
  if (q.status === 'disabled') where.push('d.is_disabled');
  if (q.fw) add('s.fw_version = ?', q.fw);
  if (q.tz) add('d.timezone = ?', q.tz);
  if (q.registeredFrom) add('d.created_at >= ?::date', q.registeredFrom);
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM devices d LEFT JOIN users o ON o.id = d.owner_id LEFT JOIN device_state s ON s.device_id = d.id`;
  const total = (await db.one(`SELECT count(*)::int AS n ${from} ${filter}`, vals)).n;

  const cur = decCursor(q.cursor);
  const pageVals = [...vals];
  let pageWhere = filter;
  if (cur) {
    pageVals.push(cur.at, cur.id);
    pageWhere += `${filter ? ' AND' : 'WHERE'} (d.created_at, d.id) < ($${pageVals.length - 1}::timestamptz, $${pageVals.length}::uuid)`;
  }
  pageVals.push(q.limit + 1);
  const rows = await db.many(
    `SELECT d.id, d.serial_no, d.mqtt_username, d.name, d.owner_id, o.full_name AS owner_name, d.timezone,
            d.chip_model, d.created_at, d.is_disabled, COALESCE(s.is_online, false) AS online, s.fw_version, s.last_seen_at
       ${from} ${pageWhere} ORDER BY d.created_at DESC, d.id DESC LIMIT $${pageVals.length}`, pageVals);
  const more = rows.length > q.limit;
  const items = rows.slice(0, q.limit).map((r) => ({
    id: r.id, serial: r.serial_no, mac: macColons(r.mqtt_username), name: r.name,
    owner: r.owner_id ? { id: r.owner_id, fullName: r.owner_name } : null,
    online: r.online, isDisabled: r.is_disabled, tz: r.timezone, fw: r.fw_version, chip: r.chip_model,
    lastSeenAt: r.last_seen_at, createdAt: r.created_at,
  }));
  res.json({ items, total, nextCursor: more ? encCursor(rows[q.limit - 1]) : null });
});

// 8.3 Device detail
router.get('/devices/:id', requireStaff('devices.view'), async (req, res) => {
  const d = await loadDevice(req.params.id);
  const s = await db.one('SELECT * FROM device_state WHERE device_id = $1', [d.id]);
  const set = await db.one('SELECT * FROM device_settings WHERE device_id = $1', [d.id]);
  const owner = d.owner_id ? await db.one('SELECT id, full_name, phone, country FROM users WHERE id = $1', [d.owner_id]) : null;
  const regBy = d.registered_by ? await db.one('SELECT full_name FROM users WHERE id = $1', [d.registered_by]) : null;
  const shares = await db.many(
    `SELECT u.id, u.full_name, u.phone, array_agg(p.permission ORDER BY p.permission) AS perms
       FROM device_shares sh JOIN users u ON u.id = sh.user_id
       LEFT JOIN device_share_permissions p ON p.device_id = sh.device_id AND p.user_id = sh.user_id
      WHERE sh.device_id = $1 GROUP BY u.id, u.full_name, u.phone ORDER BY u.full_name`, [d.id]);
  const mem = live.getStatus(d.id);
  res.json({
    id: d.id, serial: d.serial_no, name: d.name, room: d.room,
    hardware: { mac: macColons(d.mqtt_username), chip: d.chip_model, radar: 'DFRobot C1001', hwModel: d.hw_model,
      batch: d.batch, manufacturedAt: d.manufactured_at, fwAtRegister: d.fw_at_register,
      registeredAt: d.created_at, registeredBy: regBy?.full_name || null },
    connection: { online: mem ? mem.online : !!s?.is_online, lastSeenAt: mem?.lastSeenAt || s?.last_seen_at || null,
      ip: s?.ip || null, wifiSsid: s?.wifi_ssid || null, rssi: s?.wifi_rssi ?? null, uptimeS: s?.uptime_s ?? null,
      fw: s?.fw_version || null, radarOk: s?.radar_ok ?? null },
    tz: d.timezone, place: d.place, sleepCutoff: d.sleep_cutoff?.slice(0, 5), autoUpdate: d.auto_update,
    isDisabled: d.is_disabled, disabledReason: d.disabled_reason,
    owner: owner ? { id: owner.id, fullName: owner.full_name, phone: owner.phone, country: owner.country } : null,
    shares: shares.map((x) => ({ userId: x.id, fullName: x.full_name, phone: x.phone, permissions: x.perms.filter(Boolean) })),
    claimCodeActive: !!d.claim_code_hash,
    sensorSettings: set ? { exitS: set.exit_s, liveS: set.live_s, idleS: set.idle_s, struggle: set.struggle,
      unattended: set.unattended, unattMin: set.unatt_min, version: set.version, appliedVersion: set.applied_version } : null,
  });
});

// Shared by register (8.4) and new claim code (8.6). Only the HMAC is stored.
async function codeResponse(serial, code) {
  return { serial, claimCode: claim.formatCode(code), qrPayload: claim.qrPayload(code), qrPngBase64: await claim.qrPng(code) };
}

// 8.4 Register a board read over USB (Web Serial in the browser).
router.post('/devices', requireStaff('devices.register'), async (req, res) => {
  const body = parse(z.object({
    mac: z.string().transform(normMac).refine((m) => m.length === 12, 'MAC must be 6 bytes, e.g. 34:85:18:A1:0F:22'),
    chip: z.string().trim().min(2).max(40),
    hwModel: z.string().trim().min(1).max(60),
    batch: z.string().trim().max(40).nullable().optional(),
    manufacturedAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').nullable().optional(),
    fwOnBoard: z.string().trim().max(40).nullable().optional(),
  }), req.body);
  const code = claim.newCode();
  const device = await db.tx(async (c) => {
    // One registration at a time hands out serials, so two never collide.
    await c.query("SELECT pg_advisory_xact_lock(hashtext('argus.serial'))");
    if ((await c.query('SELECT 1 FROM devices WHERE mqtt_username = $1', [body.mac])).rowCount) {
      throw E.conflict('MAC_EXISTS', `A device with MAC ${macColons(body.mac)} is already registered`, 'mac');
    }
    const serial = await claim.nextSerial(c);
    const { rows: [d] } = await c.query(
      `INSERT INTO devices (serial_no, mac, mqtt_username, claim_code_hash, chip_model, hw_model, batch,
                            manufactured_at, fw_at_register, registered_by)
       VALUES ($1, $2::macaddr, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id, serial_no, created_at`,
      [serial, body.mac, body.mac, claim.hashCode(code), body.chip, body.hwModel, body.batch || null,
        body.manufacturedAt || null, body.fwOnBoard || null, req.user.id]);
    await c.query('INSERT INTO device_settings (device_id) VALUES ($1)', [d.id]);
    await audit(req, { action: 'device.register', targetType: 'device', targetId: d.id, targetLabel: serial,
      detail: `MAC ${macColons(body.mac)} · ${body.chip}` }, c);
    return d;
  });
  res.status(201).json({
    device: { id: device.id, serial: device.serial_no, mac: macColons(body.mac), chip: body.chip, registeredAt: device.created_at },
    ...(await codeResponse(device.serial_no, code)),
  });
});

// 8.5 Disable / enable (MQTT login refused while disabled)
router.patch('/devices/:id', requireStaff('devices.command'), async (req, res) => {
  const body = parse(z.object({ isDisabled: z.boolean(), disabledReason: z.string().trim().max(200).nullable().optional() }).strict(), req.body);
  const d = await loadDevice(req.params.id);
  if (body.isDisabled && !body.disabledReason) throw E.bad('VALIDATION', 'Give a reason for disabling', 'disabledReason');
  await db.tx(async (c) => {
    await c.query('UPDATE devices SET is_disabled = $2, disabled_reason = $3 WHERE id = $1',
      [d.id, body.isDisabled, body.isDisabled ? body.disabledReason : null]);
    if (body.isDisabled !== d.is_disabled) {
      await c.query('INSERT INTO device_events (device_id, type, severity, message) VALUES ($1, $2, $3, $4)',
        [d.id, body.isDisabled ? 'disabled' : 'enabled', body.isDisabled ? 'warning' : 'info', body.disabledReason || null]);
    }
    await audit(req, { action: body.isDisabled ? 'device.disable' : 'device.enable', targetType: 'device',
      targetId: d.id, targetLabel: d.serial_no, detail: body.disabledReason || null }, c);
  });
  mqttAuth.forget(d.mqtt_username);  // the broker's next login/ACL check sees the change
  res.json({ id: d.id, serial: d.serial_no, isDisabled: body.isDisabled, disabledReason: body.isDisabled ? body.disabledReason : null });
});

// 8.6 New claim code (lost sticker / resold device). The old code stops working.
router.post('/devices/:id/claim-code', requireStaff('devices.register'), async (req, res) => {
  const d = await loadDevice(req.params.id);
  const code = claim.newCode();
  await db.tx(async (c) => {
    await c.query('UPDATE devices SET claim_code_hash = $2 WHERE id = $1', [d.id, claim.hashCode(code)]);
    await audit(req, { action: 'device.claim_code', targetType: 'device', targetId: d.id, targetLabel: d.serial_no,
      detail: d.owner_id ? 'issued while claimed (works only after unclaim)' : null }, c);
  });
  res.json(await codeResponse(d.serial_no, code));
});

// 8.7 Unclaim (support): same effect as the owner removing it (history deleted).
router.post('/devices/:id/unclaim', requireStaff('customers.edit'), async (req, res) => {
  const body = parse(z.object({ reason: z.string().trim().min(1).max(200) }), req.body);
  const d = await loadDevice(req.params.id);
  if (!d.owner_id) throw E.conflict('NOT_CLAIMED', 'This device has no owner');
  const { rows } = await db.query('SELECT DISTINCT user_id FROM device_user_permissions WHERE device_id = $1', [d.id]);
  await db.tx(async (c) => {
    const locked = await loadDevice(d.id, c);
    await releaseDevice(c, locked, req, `support: ${body.reason}`);
  });
  for (const r of rows) realtime.revokeDevice(r.user_id, d.id, null);
  res.status(204).end();
});

// 8.12 Delete a device that was NEVER claimed (e.g. a mistyped MAC).
router.delete('/devices/:id', requireStaff('devices.register'), async (req, res) => {
  const d = await loadDevice(req.params.id);
  const everClaimed = d.owner_id
    || (await db.query("SELECT 1 FROM device_events WHERE device_id = $1 AND type = 'claimed' LIMIT 1", [d.id])).rowCount;
  if (everClaimed) throw E.conflict('DEVICE_IN_USE', 'This device has been claimed before and cannot be deleted');
  await db.tx(async (c) => {
    await c.query('DELETE FROM devices WHERE id = $1', [d.id]);
    await audit(req, { action: 'device.delete', targetType: 'device', targetId: d.id, targetLabel: d.serial_no,
      detail: `MAC ${macColons(d.mqtt_username)}` }, c);
  });
  mqttAuth.forget(d.mqtt_username);
  live.forget(d.mqtt_username);
  res.status(204).end();
});

module.exports = router;
