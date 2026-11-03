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
const { releaseDevice } = require('../services/devices');
const realtime = require('../services/realtime');
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
async function findClaimable(req, code, serial, q = db, lock = '') {
  const key = req.user.id;
  limits.claim.check(key);
  const { rows: [d] } = await q.query(
    `SELECT id, serial_no, hw_model, created_at, owner_id, is_disabled, mqtt_username
       FROM devices WHERE claim_code_hash = $1 ${lock}`, [claim.hashCode(code)]);
  if (!d || (serial && serial.trim().toUpperCase() !== d.serial_no)) {
    limits.claim.fail(key);
    throw new ApiError(404, 'INVALID_CODE', 'That claim code is not valid', 'claimCode');
  }
  if (d.owner_id) throw E.conflict('ALREADY_CLAIMED', 'This sensor already belongs to someone');
  if (d.is_disabled) throw E.forbidden('DEVICE_DISABLED', 'This sensor is disabled. Contact Argus support.');
  return d;
}

// 3.1
router.get('/', async (req, res) => {
  res.json({ items: await views.listFor(req.user.id) });
});

// 3.2
router.post('/claim/check', async (req, res) => {
  const body = parse(z.object(codeBody), req.body);
  const d = await findClaimable(req, codeFrom(body), body.serial);
  res.json({ serial: d.serial_no, hwModel: d.hw_model, registeredAt: d.created_at });
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
    name: z.string().trim().min(1, 'Name is required').max(60),
    room: z.string().trim().max(60).nullable().optional(),
    tz,
    place: place.nullable().optional(),
  }), req.body);
  checkTz(body.tz);
  const code = codeFrom(body);
  const deviceId = await db.tx(async (c) => {
    const d = await findClaimable(req, code, body.serial, c, 'FOR UPDATE');
    await c.query(
      `UPDATE devices SET owner_id = $2, claimed_at = now(), claim_code_hash = NULL,
              name = $3, room = $4, timezone = $5, place = $6,
              sleep_cutoff = (SELECT default_sleep_cutoff FROM app_settings WHERE id = 1)
        WHERE id = $1`,
      [d.id, req.user.id, body.name, body.room || null, body.tz, body.place || null]);
    await c.query('INSERT INTO device_settings (device_id) VALUES ($1) ON CONFLICT (device_id) DO NOTHING', [d.id]);
    for (const [type, enabled, low, high, dur, from, to] of DEFAULT_RULES) {
      await c.query(
        `INSERT INTO alert_rules (device_id, type, is_enabled, low_value, high_value, duration_s, window_from, window_to)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT DO NOTHING`, [d.id, type, enabled, low, high, dur, from, to]);
    }
    await c.query(`INSERT INTO device_events (device_id, type, data) VALUES ($1, 'claimed', $2)`,
      [d.id, JSON.stringify({ ownerId: req.user.id })]);
    await audit(req, { action: 'device.claim', targetType: 'device', targetId: d.id, targetLabel: d.serial_no,
      detail: body.qr ? 'Claimed by QR scan' : 'Claimed by typed code' }, c);
    return d.id;
  });
  limits.claim.reset(req.user.id);
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
  await db.tx(async (c) => {
    await c.query('DELETE FROM device_shares WHERE device_id = $1 AND user_id = $2', [req.device.id, req.user.id]);
    await c.query('DELETE FROM user_device_alert_mutes WHERE device_id = $1 AND user_id = $2', [req.device.id, req.user.id]);
    await audit(req, { action: 'share.leave', targetType: 'device', targetId: req.device.id, targetLabel: req.device.serial_no }, c);
  });
  realtime.revokeDevice(req.user.id, req.device.id, null);
  res.status(204).end();
});

module.exports = { router, device };
