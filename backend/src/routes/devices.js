// docs/API.md §3 My devices: list, claim, detail, rename/backend settings,
// remove, leave. (Sensor settings and Wi-Fi setup, 3.6–3.8, come with the
// settings-sync step.)
const express = require('express');
const { IANAZone } = require('luxon');
const db = require('../db');
const { parse, z } = require('../lib/validate');
const { audit } = require('../lib/audit');
const claim = require('../lib/claim');
const { limits } = require('../middleware/rateLimit');
const { requireUser } = require('../middleware/auth');
const views = require('../services/deviceViews');
const { vendorOf } = require('../services/users');
const { releaseDevice } = require('../services/devices');
const realtime = require('../services/realtime');
const sleep = require('../services/sleep');
const settingsSync = require('../services/settingsSync');
const commands = require('../services/commands');
const alerts = require('../services/alerts');
const { DateTime } = require('luxon');
const { E, ApiError } = require('../errors');

const router = express.Router();
router.use(requireUser);

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// Loads req.device for /:id routes. No access at all = 404 (so nobody can
// probe which devices exist); access but not this permission = 403.
function device(permission) {
  return async (req, res, next) => {
    if (!isUuid(req.params.id)) throw E.notFound('Device not found');
    const row = await views.rowFor(req.user.id, req.params.id);
    if (!row) throw E.notFound('Device not found');
    if (permission === 'owner' ? row.owner_id !== req.user.id : permission && !row.perms.includes(permission)) {
      throw E.forbidden('FORBIDDEN', 'You do not have permission for this');
    }
    req.device = row;
    next();
  };
}

const tz = z.string().trim().min(1).max(60);
// API.md: an unknown IANA zone is 422 INVALID_TIMEZONE (not a plain 400).
function checkTz(v) {
  if (v !== undefined && !IANAZone.isValidZone(v)) throw E.invalid('INVALID_TIMEZONE', 'Unknown time zone', 'tz');
}
const place = z.string().trim().min(2, 'Place must be 2–60 characters').max(60, 'Place must be 2–60 characters');
const hhmm = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Time must be HH:mm');

// Accepts {qr} or {claimCode, serial?}; returns the normalized code.
function codeFrom(body) {
  const code = body.qr ? claim.codeFromQr(body.qr) : claim.normalizeCode(body.claimCode);
  if (!code) throw new ApiError(404, 'INVALID_CODE', 'That claim code is not valid', 'claimCode');
  return code;
}
const codeBody = { qr: z.string().max(100).optional(), claimCode: z.string().max(40).optional(), serial: z.string().max(20).optional() };

// Same rules for check and claim: rate limit per user, serial must match if given.
// The QR works twice (vendor v2, migration 008):
//   factory      → a vendor member (for the vendor) puts it in vendor stock; anyone else becomes the owner
//   vendor_stock → a customer becomes the owner; the device stays "sold by" that vendor
//   vendor_use   → locked: the vendor uses it itself (009); "back to stock" unlocks it
// Sets d.result: 'stock' | 'owner'.
async function findClaimable(req, code, serial, vendor, asVendor, q = db, lock = false) {
  const key = req.user.id;
  limits.claim.check(key);
  const { rows: [d] } = await q.query(
    `SELECT d.id, d.serial_no, d.hw_model, d.created_at, d.owner_id, d.vendor_id, d.claimed_at, d.claim_stage,
            d.is_disabled, d.mqtt_username, v.name AS vendor_name
       FROM devices d LEFT JOIN vendors v ON v.id = d.vendor_id
      WHERE d.claim_code_hash = $1 ${lock ? 'FOR UPDATE OF d' : ''}`, [claim.hashCode(code)]);
  if (!d || (serial && serial.trim().toUpperCase() !== d.serial_no)) {
    limits.claim.fail(key);
    throw new ApiError(404, 'INVALID_CODE', 'That claim code is not valid', 'claimCode');
  }
  if (d.claim_stage === 'owned') throw E.conflict('ALREADY_CLAIMED', 'This sensor already belongs to someone');
  if (d.is_disabled) throw E.forbidden('DEVICE_DISABLED', 'This sensor is disabled. Contact Argus support.');
  const forVendor = !!vendor && asVendor !== false;
  if (d.claim_stage === 'vendor_use') {
    if (vendor && d.vendor_id === vendor.id) throw E.conflict('ALREADY_IN_STOCK', 'This sensor is already yours (in use)');
    throw E.conflict('ALREADY_CLAIMED', 'This sensor already belongs to someone');
  }
  if (d.claim_stage === 'vendor_stock' && forVendor) {
    if (d.vendor_id === vendor.id) throw E.conflict('ALREADY_IN_STOCK', 'This sensor is already in your stock');
    throw E.conflict('ALREADY_CLAIMED', 'This sensor already belongs to someone');
  }
  d.result = d.claim_stage === 'factory' && forVendor ? 'stock' : 'owner';
  return d;
}

// 3.1
router.get('/', async (req, res) => {
  res.json({ items: await views.listFor(req.user.id) });
});

// 3.2
// stage: where the sticker is now ('factory' | 'vendor_stock'); result: what
// claiming will do ('stock' = into my vendor's stock, 'owner' = I own it);
// soldBy: the vendor selling it (vendor_stock only).
router.post('/claim/check', async (req, res) => {
  const body = parse(z.object({ ...codeBody, asVendor: z.boolean().optional() }), req.body);
  const vendor = await vendorOf(req.user.id);
  const d = await findClaimable(req, codeFrom(body), body.serial, vendor, body.asVendor);
  res.json({
    serial: d.serial_no, hwModel: d.hw_model, registeredAt: d.created_at,
    stage: d.claim_stage, result: d.result,
    soldBy: d.claim_stage === 'vendor_stock' ? { id: d.vendor_id, name: d.vendor_name } : null,
  });
});

// Default alert rules created at claim (API.md §6 table).
const DEFAULT_RULES = [
  ['breath_low', true, 8, null, 30, null, null],
  ['hr_out_of_range', true, 45, 110, 60, null, null],
  ['out_of_bed', true, null, null, 600, '23:00', '06:00'],
  ['no_movement', false, null, null, 10800, null, null],
  ['device_offline', true, null, null, 900, null, null],
];

// 3.3
router.post('/claim', async (req, res) => {
  const body = parse(z.object({
    ...codeBody,
    // Required when you become the owner; not asked when a vendor adds it to stock (009).
    name: z.string().trim().min(1, 'Name is required').max(60).optional(),
    room: z.string().trim().max(60).nullable().optional(),
    tz: tz.optional(),
    place: place.nullable().optional(),
    // API.md §15: vendor members claim for their vendor by default;
    // asVendor:false claims for themselves instead.
    asVendor: z.boolean().optional(),
  }), req.body);
  checkTz(body.tz);
  const code = codeFrom(body);
  const vendor = await vendorOf(req.user.id);
  if (body.asVendor === true && !vendor) throw E.forbidden('NOT_VENDOR_MEMBER', 'You are not on a vendor team');
  let vendorId = null;    // set when this claim puts the device into the vendor's stock
  let soldBy = null;      // set when a customer claims from a vendor's stock
  let vendorUsers = [];   // vendor team members who lose the device on a sale
  const deviceId = await db.tx(async (c) => {
    const d = await findClaimable(req, code, body.serial, vendor, body.asVendor, c, true);
    if (d.result === 'stock') {
      // Into the vendor's stock: scan and confirm only. The claim code is KEPT: the
      // customer scans the same sticker later. Name, room, time zone come with "Use here".
      vendorId = vendor.id;
      await c.query(`UPDATE devices SET claim_stage = 'vendor_stock', vendor_id = $2, owner_id = NULL, group_id = NULL,
                            claimed_at = now(), stocked_at = now(), name = NULL, room = NULL, place = NULL WHERE id = $1`,
      [d.id, vendor.id]);
    } else {
      if (!body.name) throw E.bad('VALIDATION', 'Name is required', 'name');
      if (!body.tz) throw E.bad('VALIDATION', 'Time zone is required', 'tz');
      // The claimer becomes the owner; a vendor_stock device keeps vendor_id as a record ("sold by").
      // The vendor team loses all access (009) and nothing from before the sale is kept.
      if (d.claim_stage === 'vendor_stock') {
        soldBy = { id: d.vendor_id, name: d.vendor_name };
        vendorUsers = (await c.query('SELECT DISTINCT user_id FROM device_user_permissions WHERE device_id = $1', [d.id]))
          .rows.map((r) => r.user_id);
        await c.query('DELETE FROM sleep_sessions WHERE device_id = $1', [d.id]);
        await c.query('DELETE FROM alerts WHERE device_id = $1', [d.id]);
        await c.query('DELETE FROM device_access_grants WHERE device_id = $1', [d.id]);
      }
      await c.query(`UPDATE devices SET claim_stage = 'owned', owner_id = $6, claimed_at = now(), group_id = NULL,
                            claim_code_hash = NULL, claim_code_enc = NULL, name = $2, room = $3, timezone = $4, place = $5,
                            sleep_cutoff = (SELECT default_sleep_cutoff FROM app_settings WHERE id = 1)
                      WHERE id = $1`, [d.id, body.name, body.room || null, body.tz, body.place || null, req.user.id]);
    }
    await c.query('INSERT INTO device_settings (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING', [d.id]);
    for (const [type, enabled, low, high, dur, from, to] of DEFAULT_RULES) {
      await c.query(
        `INSERT INTO alert_rules (device_id, type, is_enabled, low_value, high_value, duration_s, window_from, window_to)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`, [d.id, type, enabled, low, high, dur, from, to]);
    }
    await c.query(`INSERT INTO device_events (device_id, type, data) VALUES ($1, 'claimed', $2)`,
      [d.id, JSON.stringify(vendorId ? { vendorId, by: req.user.id, stage: 'vendor_stock' }
        : { ownerId: req.user.id, stage: 'owned', ...(soldBy ? { soldByVendorId: soldBy.id } : {}) })]);
    await audit(req, { action: 'device.claim', targetType: 'device', targetId: d.id, targetLabel: d.serial_no,
      detail: (body.qr ? 'Claimed by QR scan' : 'Claimed by typed code')
        + (vendorId ? ` into the stock of ${vendor.name}` : soldBy ? `, sold by ${soldBy.name}` : ''),
      data: vendorId ? { vendorId } : soldBy ? { vendorId: soldBy.id } : undefined }, c);
    return d.id;
  });
  limits.claim.reset(req.user.id);
  alerts.forget(deviceId);
  for (const u of vendorUsers) realtime.revokeDevice(u, deviceId, null);
  res.status(201).json(await views.detail(await views.rowFor(req.user.id, deviceId), req.user.id));
});

// 3.4
router.get('/:id', device(), async (req, res) => {
  res.json(await views.detail(req.device, req.user.id));
});

// 3.5 Backend-only settings (the sensor isn't contacted).
router.patch('/:id', device('settings.edit'), async (req, res) => {
  const body = parse(z.object({
    name: z.string().trim().min(1).max(60).optional(),
    room: z.string().trim().max(60).nullable().optional(),
    tz: tz.optional(),
    place: place.nullable().optional(),
    sleepCutoff: hhmm.optional(),
    autoUpdate: z.boolean().optional(),
  }).strict(), req.body);
  checkTz(body.tz);
  const cols = { name: 'name', room: 'room', tz: 'timezone', place: 'place', sleepCutoff: 'sleep_cutoff', autoUpdate: 'auto_update' };
  const sets = [];
  const vals = [req.device.id];
  for (const [k, col] of Object.entries(cols)) {
    if (body[k] === undefined) continue;
    vals.push(body[k] === '' ? null : body[k]);
    sets.push(`${col} = $${vals.length}`);
  }
  if (sets.length) {
    await db.query(`UPDATE devices SET ${sets.join(', ')} WHERE id = $1`, vals);
    await audit(req, { action: 'device.update', targetType: 'device', targetId: req.device.id,
      targetLabel: req.device.serial_no, data: body });
  }
  res.json(await views.detail(await views.rowFor(req.user.id, req.device.id), req.user.id));
});

// 3.6 / 3.7 Sensor settings (sent to the sensor, retained + versioned).
router.get('/:id/sensor-settings', device('settings.edit'), async (req, res) => {
  res.json(await settingsSync.get(req.device.id));
});

router.patch('/:id/sensor-settings', device('settings.edit'), async (req, res) => {
  const body = parse(z.object({
    exitS: z.number().int().min(30).max(3600).optional(),
    liveS: z.number().int().min(1).max(60).optional(),
    idleS: z.number().int().min(10).max(600).optional(),
    struggle: z.boolean().optional(),
    unattended: z.boolean().optional(),
    unattMin: z.number().int().min(1).max(180).optional(),
  }).strict(), req.body);
  const settings = await settingsSync.update(req.device.id, body, req.user.id);
  if (Object.keys(body).length) {
    await audit(req, { action: 'device.sensor_settings', targetType: 'device', targetId: req.device.id,
      targetLabel: req.device.serial_no, data: body });
  }
  res.json({ settings });
});

// 3.8 "Change Wi-Fi network" = config_mode command (expires after 30 s).
router.post('/:id/wifi-setup', device('settings.edit'), async (req, res) => {
  const c = await commands.createNow(req.device.id, 'config_mode', req.user.id);
  await audit(req, { action: 'device.command.config_mode', targetType: 'device', targetId: req.device.id,
    targetLabel: req.device.serial_no, detail: commands.apiStatus(c.status) });
  res.status(202).json({ commandId: c.id, status: commands.apiStatus(c.status) });
});

// 3.8b "Recalibrate" = recalibrate command (radar reset ~11 s; expires after 30 s offline).
router.post('/:id/recalibrate', device('settings.edit'), async (req, res) => {
  const c = await commands.createNow(req.device.id, 'recalibrate', req.user.id);
  await audit(req, { action: 'device.command.recalibrate', targetType: 'device', targetId: req.device.id,
    targetLabel: req.device.serial_no, detail: commands.apiStatus(c.status) });
  res.status(202).json({ commandId: c.id, status: commands.apiStatus(c.status) });
});

// 3.8c "End session" = end_session command (firmware 2.5.1): the sensor closes
// the running sleep session and sends it now. Expires after 30 s offline.
router.post('/:id/end-session', device('settings.edit'), async (req, res) => {
  const c = await commands.createNow(req.device.id, 'end_session', req.user.id);
  await audit(req, { action: 'device.command.end_session', targetType: 'device', targetId: req.device.id,
    targetLabel: req.device.serial_no, detail: commands.apiStatus(c.status) });
  res.status(202).json({ commandId: c.id, status: commands.apiStatus(c.status) });
});

// 4.1 Nights (main sleeps) for the last `days` sleep dates, or from..to.
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD')
  .refine((v) => DateTime.fromISO(v).isValid, 'Not a real date');
router.get('/:id/nights', device('history.view'), async (req, res) => {
  const q = parse(z.object({
    days: z.coerce.number().int().min(1).max(90).optional(),
    from: isoDate.optional(),
    to: isoDate.optional(),
  }), req.query);
  let to = q.to || await sleep.localToday(req.device.id);
  let from = q.from || DateTime.fromISO(to).minus({ days: (q.days || 14) - 1 }).toISODate();
  if (from > to) [from, to] = [to, from];
  if (DateTime.fromISO(to).diff(DateTime.fromISO(from), 'days').days > 92) {
    throw E.bad('VALIDATION', 'At most 92 days per request', 'from');
  }
  const list = await sleep.nights(req.device.id, from, to);
  res.json({
    device: { tz: req.device.timezone, place: req.device.place },
    nights: list.map(sleep.nightCard),
    averages: sleep.averages(list),
  });
});

// 4.2 One night in detail.
router.get('/:id/nights/:sleepDate', device('history.view'), async (req, res) => {
  const date = parse(z.object({ sleepDate: isoDate }), req.params).sleepDate;
  const [n] = await sleep.nights(req.device.id, date, date);
  if (!n) throw E.notFound('No sleep recorded for that night');
  res.json(sleep.nightDetail(n));
});

// 4.3 Delete one stored session (13 Nov, "session management" like the old
// site). Owner only; on a device without an owner (vendor in use), settings.edit.
router.delete('/:id/sessions/:sessionId', device(), async (req, res) => {
  const d = req.device;
  const may = d.owner_id ? d.owner_id === req.user.id : d.perms.includes('settings.edit');
  if (!may) throw E.forbidden('FORBIDDEN', 'Only the owner can delete sleep history');
  const sessionId = parse(z.object({ sessionId: z.string().regex(/^\d{1,18}$/, 'Bad session id') }), req.params).sessionId;
  const { rows: [s] } = await db.query(
    'DELETE FROM sleep_sessions WHERE id = $1 AND device_id = $2 RETURNING started_at, ended_at', [sessionId, d.id]);
  if (!s) throw E.notFound('Session not found');
  const min = Math.round((s.ended_at - s.started_at) / 60000);
  await audit(req, { action: 'device.session.delete', targetType: 'device', targetId: d.id,
    targetLabel: d.serial_no, detail: `${new Date(s.started_at).toISOString()} (${min} min)` });
  res.status(204).end();
});

// Everyone who can access a device (to update their sockets after a change).
async function accessUsers(deviceId, q = db) {
  const { rows } = await q.query('SELECT DISTINCT user_id FROM device_user_permissions WHERE device_id = $1', [deviceId]);
  return rows.map((r) => r.user_id);
}

// 3.9 Remove device (owner only): history goes too (D5).
router.delete('/:id', device('owner'), async (req, res) => {
  const body = parse(z.object({ confirmName: z.string().max(60) }), req.body);
  if (body.confirmName.trim() !== (req.device.name || '').trim()) {
    throw E.invalid('CONFIRM_MISMATCH', 'Type the device name exactly to confirm', 'confirmName');
  }
  const users = await accessUsers(req.device.id);
  await db.tx(async (c) => {
    const { rows: [d] } = await c.query('SELECT id, serial_no, owner_id FROM devices WHERE id = $1 FOR UPDATE', [req.device.id]);
    await releaseDevice(c, d, req, 'removed by owner');
  });
  for (const u of users) realtime.revokeDevice(u, req.device.id, null);
  res.status(204).end();
});

// 3.10 Leave a device someone shared with you.
router.delete('/:id/me', device(), async (req, res) => {
  if (req.device.owner_id === req.user.id) {
    throw E.invalid('OWNER_CANNOT_LEAVE', 'The owner removes the device instead (Device settings → Remove)');
  }
  if (req.device.via === 'vendor') throw E.invalid('VENDOR_DEVICE', 'Vendor devices stay with the vendor team');
  await db.tx(async (c) => {
    await c.query('DELETE FROM device_shares WHERE device_id = $1 AND user_id = $2', [req.device.id, req.user.id]);
    await c.query(`UPDATE device_access_grants SET revoked_at = now(), end_notified_at = now()
                    WHERE device_id = $1 AND user_id = $2 AND revoked_at IS NULL`, [req.device.id, req.user.id]);
    await c.query('DELETE FROM user_device_alert_mutes WHERE device_id = $1 AND user_id = $2', [req.device.id, req.user.id]);
    await audit(req, { action: 'share.leave', targetType: 'device', targetId: req.device.id, targetLabel: req.device.serial_no }, c);
  });
  realtime.revokeDevice(req.user.id, req.device.id, null);
  res.status(204).end();
});

module.exports = { router, device };
