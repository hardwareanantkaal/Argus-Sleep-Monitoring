// docs/API.md §15.2–15.5 The vendor's own side: devices, groups, team, and
// temporary access grants. Any member (owner or staff) may use it; only the
// vendor owner manages the team. Every write is audited.
const express = require('express');
const { IANAZone } = require('luxon');
const config = require('../config');
const db = require('../db');
const { parse, z } = require('../lib/validate');
const { audit } = require('../lib/audit');
const { randomToken, hmac } = require('../lib/crypto');
const { requireUser } = require('../middleware/auth');
const views = require('../services/deviceViews');
const alerts = require('../services/alerts');
const realtime = require('../services/realtime');
const vendors = require('../services/vendors');
const { E } = require('../errors');

const router = express.Router();
router.use(requireUser);

const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const INVITE_DAYS = 7;
const GRANT_PERMS = ['live.view', 'history.view', 'alerts.receive', 'settings.edit'];
const DEFAULT_GRANT_PERMS = ['alerts.receive', 'history.view', 'live.view'];

// Loads req.vendor ({id, name, role}). Not a member (or vendor disabled) = 403.
async function requireMember(req, res, next) {
  const { rows: [v] } = await db.query(
    `SELECT v.id, v.name, m.role FROM vendor_members m JOIN vendors v ON v.id = m.vendor_id
      WHERE m.user_id = $1 AND v.status = 'active'`, [req.user.id]);
  if (!v) throw E.forbidden('NOT_VENDOR_MEMBER', 'You are not on a vendor team');
  req.vendor = v;
  next();
}
function requireOwner(req, res, next) {
  if (req.vendor.role !== 'owner') throw E.forbidden('FORBIDDEN', 'Only the vendor owner can do this');
  next();
}
router.use(requireMember);

const vAudit = (req, entry, c) => audit(req, { ...entry, data: { vendorId: req.vendor.id, ...(entry.data || {}) } }, c);

// A device in this vendor's stock or in use (sold devices are records only, 009).
// Pass a tx client `c` to lock the row.
async function vendorDevice(req, id, c = null) {
  if (!isUuid(id)) throw E.notFound('Device not found');
  const { rows: [d] } = await (c || db).query(
    `SELECT id, serial_no, name, claim_stage FROM devices
      WHERE id = $1 AND vendor_id = $2 AND claim_stage IN ('vendor_stock', 'vendor_use')${c ? ' FOR UPDATE' : ''}`,
    [id, req.vendor.id]);
  if (!d) throw E.notFound('Device not found');
  return d;
}
const needInUse = (d) => {
  if (d.claim_stage !== 'vendor_use') throw E.conflict('NOT_IN_USE', 'Use this sensor first ("Use here"). Sensors in stock have no data.');
};

// 15.2 The vendor and its devices
router.get('/', async (req, res) => {
  res.json({ vendor: req.vendor });
});

// items: stock + in-use devices as cards (stage 'stock' | 'in_use').
// sold: records only, no access (009): {id, serial, customer, soldAt}.
router.get('/devices', async (req, res) => {
  const sold = await db.many(
    `SELECT d.id, d.serial_no, d.claimed_at, u.id AS user_id, u.full_name, u.phone, u.country
       FROM devices d JOIN users u ON u.id = d.owner_id
      WHERE d.vendor_id = $1 AND d.claim_stage = 'owned' ORDER BY d.claimed_at DESC`, [req.vendor.id]);
  res.json({
    items: await views.listFor(req.user.id, req.vendor.id),
    sold: sold.map((s) => ({ id: s.id, serial: s.serial_no, soldAt: s.claimed_at,
      customer: { id: s.user_id, fullName: s.full_name, phone: s.phone, country: s.country } })),
  });
});

// 009 "Use here": the vendor uses a stock sensor itself. Asks what a customer
// claim asks (name, room, time zone, town) and an optional group. The QR is locked.
const tzName = z.string().trim().min(1).max(60);
router.post('/devices/:id/use', async (req, res) => {
  const body = parse(z.object({
    name: z.string().trim().min(1, 'Name is required').max(60),
    room: z.string().trim().max(60).nullable().optional(),
    tz: tzName,
    place: z.string().trim().min(2, 'Place must be 2–60 characters').max(60).nullable().optional(),
    groupId: z.uuid().nullable().optional(),
  }), req.body);
  if (!IANAZone.isValidZone(body.tz)) throw E.invalid('INVALID_TIMEZONE', 'Unknown time zone', 'tz');
  const g = body.groupId ? await loadGroup(req, body.groupId) : null;
  await db.tx(async (c) => {
    const d = await vendorDevice(req, req.params.id, c);
    if (d.claim_stage !== 'vendor_stock') throw E.conflict('ALREADY_IN_USE', 'This sensor is already in use');
    await c.query(
      `UPDATE devices SET claim_stage = 'vendor_use', name = $2, room = $3, timezone = $4, place = $5, group_id = $6,
              sleep_cutoff = (SELECT default_sleep_cutoff FROM app_settings WHERE id = 1) WHERE id = $1`,
      [d.id, body.name, body.room || null, body.tz, body.place || null, g?.id || null]);
    await vAudit(req, { action: 'vendor.device.use', targetType: 'device', targetId: d.id, targetLabel: d.serial_no,
      detail: `"${body.name}"${g ? ` in ${g.name}` : ''}` }, c);
  });
  await notifyTeam(req, req.params.id);
  res.json(await views.detail(await views.rowFor(req.user.id, req.params.id), req.user.id));
});

// 009 Back to stock: the QR works again. Clean start for the next user: its
// sleep history, alerts and temporary access are deleted, name and group cleared.
router.post('/devices/:id/stock', async (req, res) => {
  let users = [];
  await db.tx(async (c) => {
    const d = await vendorDevice(req, req.params.id, c);
    if (d.claim_stage !== 'vendor_use') throw E.conflict('ALREADY_IN_STOCK', 'This sensor is already in stock');
    users = (await c.query('SELECT DISTINCT user_id FROM device_user_permissions WHERE device_id = $1', [d.id])).rows.map((r) => r.user_id);
    await c.query('DELETE FROM sleep_sessions WHERE device_id = $1', [d.id]);
    await c.query('DELETE FROM alerts WHERE device_id = $1', [d.id]);
    await c.query('DELETE FROM device_access_grants WHERE device_id = $1', [d.id]);
    await c.query(`UPDATE devices SET claim_stage = 'vendor_stock', group_id = NULL, name = NULL, room = NULL, place = NULL
                    WHERE id = $1`, [d.id]);
    await vAudit(req, { action: 'vendor.device.stock', targetType: 'device', targetId: d.id, targetLabel: d.serial_no,
      detail: d.name ? `was "${d.name}"; history deleted` : 'history deleted' }, c);
  });
  alerts.forget(req.params.id);
  for (const u of users) await vendors.notifyUser(u, req.params.id);
  res.json(await views.detail(await views.rowFor(req.user.id, req.params.id), req.user.id));
});

// Tell every team member's open browser that this device's permissions changed.
async function notifyTeam(req, deviceId) {
  alerts.forget(deviceId);   // stage changed: alert rules cache re-reads it
  const { rows } = await db.query('SELECT user_id FROM vendor_members WHERE vendor_id = $1', [req.vendor.id]);
  for (const r of rows) await vendors.notifyUser(r.user_id, deviceId);
}

// v2 Stock counts: { total, stock, sold, customers, online }
router.get('/summary', async (req, res) => {
  res.json(await vendors.summary(req.vendor.id));
});

// v2 The vendor's customers, each with the devices they bought.
router.get('/customers', async (req, res) => {
  res.json({ items: await vendors.customers(req.vendor.id) });
});

// ---- 15.3 Groups ------------------------------------------------------
const groupName = z.string().trim().min(1, 'Name is required').max(60);

async function loadGroup(req, id) {
  if (!isUuid(id)) throw E.notFound('Group not found');
  const g = await db.one('SELECT id, name FROM vendor_groups WHERE id = $1 AND vendor_id = $2', [id, req.vendor.id]);
  if (!g) throw E.notFound('Group not found');
  return g;
}
const dupName = (err) => {
  if (err.code === '23505') throw E.conflict('GROUP_EXISTS', 'A group with this name already exists', 'name');
  throw err;
};

router.get('/groups', async (req, res) => {
  const rows = await db.many(
    `SELECT g.id, g.name, (SELECT count(*)::int FROM devices d WHERE d.group_id = g.id AND d.claim_stage = 'vendor_use') AS device_count
       FROM vendor_groups g WHERE g.vendor_id = $1 ORDER BY lower(g.name)`, [req.vendor.id]);
  res.json({ items: rows.map((g) => ({ id: g.id, name: g.name, deviceCount: g.device_count })) });
});

router.post('/groups', async (req, res) => {
  const body = parse(z.object({ name: groupName }), req.body);
  const g = await db.tx(async (c) => {
    const { rows: [row] } = await c.query(
      'INSERT INTO vendor_groups (vendor_id, name) VALUES ($1, $2) RETURNING id, name', [req.vendor.id, body.name]).catch(dupName);
    await vAudit(req, { action: 'vendor.group.create', targetType: 'group', targetId: row.id, targetLabel: row.name }, c);
    return row;
  });
  res.status(201).json({ id: g.id, name: g.name, deviceCount: 0 });
});

router.patch('/groups/:id', async (req, res) => {
  const body = parse(z.object({ name: groupName }), req.body);
  const g = await loadGroup(req, req.params.id);
  await db.tx(async (c) => {
    await c.query('UPDATE vendor_groups SET name = $2 WHERE id = $1', [g.id, body.name]).catch(dupName);
    await vAudit(req, { action: 'vendor.group.rename', targetType: 'group', targetId: g.id, targetLabel: body.name,
      detail: `${g.name} → ${body.name}` }, c);
  });
  res.json({ id: g.id, name: body.name });
});

// Devices in it become "no group"; nothing else changes.
router.delete('/groups/:id', async (req, res) => {
  const g = await loadGroup(req, req.params.id);
  await db.tx(async (c) => {
    await c.query('DELETE FROM vendor_groups WHERE id = $1', [g.id]);
    await vAudit(req, { action: 'vendor.group.delete', targetType: 'group', targetId: g.id, targetLabel: g.name }, c);
  });
  res.status(204).end();
});

// Put a device in a group (groupId null = no group). 009: groups hold in-use
// devices only, so putting a STOCK device in a group puts it in use (QR locked,
// named after its serial until renamed). "No group" keeps an in-use device in use;
// "Back to stock" is its own action (POST /devices/:id/stock).
router.put('/devices/:id/group', async (req, res) => {
  const body = parse(z.object({ groupId: z.uuid().nullable() }), req.body);
  const g = body.groupId ? await loadGroup(req, body.groupId) : null;
  let nowInUse = false;
  const d = await db.tx(async (c) => {
    const row = await vendorDevice(req, req.params.id, c);
    if (row.claim_stage === 'vendor_stock' && !g) return row;
    nowInUse = row.claim_stage === 'vendor_stock';
    await c.query(
      `UPDATE devices SET group_id = $2, claim_stage = 'vendor_use', name = COALESCE(name, serial_no),
              sleep_cutoff = CASE WHEN $3 THEN (SELECT default_sleep_cutoff FROM app_settings WHERE id = 1) ELSE sleep_cutoff END
        WHERE id = $1`, [row.id, g?.id || null, nowInUse]);
    await vAudit(req, { action: 'vendor.device.group', targetType: 'device', targetId: row.id, targetLabel: row.serial_no,
      detail: (g ? g.name : 'no group') + (nowInUse ? ' (now in use)' : '') }, c);
    return row;
  });
  if (nowInUse) await notifyTeam(req, d.id);
  res.json({ deviceId: d.id, group: g ? { id: g.id, name: g.name } : null, stage: nowInUse || d.claim_stage === 'vendor_use' ? 'in_use' : 'stock' });
});

// ---- 15.4 Team ----------------------------------------------------------
router.get('/team', async (req, res) => {
  const members = await db.many(
    `SELECT u.id, u.full_name, u.phone, m.role, m.created_at FROM vendor_members m JOIN users u ON u.id = m.user_id
      WHERE m.vendor_id = $1 AND u.deleted_at IS NULL ORDER BY (m.role = 'owner') DESC, u.full_name`, [req.vendor.id]);
  const invites = req.vendor.role === 'owner' ? await db.many(
    `SELECT id, label, role, expires_at FROM vendor_invites
      WHERE vendor_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at`,
    [req.vendor.id]) : [];
  res.json({
    members: members.map((m) => ({ userId: m.id, fullName: m.full_name, phone: m.phone, role: m.role, joinedAt: m.created_at })),
    invites: invites.map((i) => ({ id: i.id, label: i.label, role: i.role, expiresAt: i.expires_at })),
  });
});

router.post('/team/invites', requireOwner, async (req, res) => {
  const body = parse(z.object({ label: z.string().trim().min(1, 'Label is required').max(60) }), req.body);
  const token = randomToken();
  const inv = await db.tx(async (c) => {
    const { rows: [i] } = await c.query(
      `INSERT INTO vendor_invites (vendor_id, role, label, token_hash, invited_by, expires_at)
       VALUES ($1, 'staff', $2, $3, $4, now() + make_interval(days => $5)) RETURNING id, expires_at`,
      [req.vendor.id, body.label, hmac('invite', token), req.user.id, INVITE_DAYS]);
    await vAudit(req, { action: 'vendor.team.invite', targetType: 'vendor', targetId: req.vendor.id,
      targetLabel: req.vendor.name, detail: `"${body.label}"` }, c);
    return i;
  });
  res.status(201).json({
    invite: { id: inv.id, label: body.label, role: 'staff', expiresAt: inv.expires_at },
    inviteUrl: `${config.publicBaseUrl}/invite/${token}`,
    expiresAt: inv.expires_at,
  });
});

router.delete('/team/invites/:id', requireOwner, async (req, res) => {
  if (!isUuid(req.params.id)) throw E.notFound('Invite not found');
  const r = await db.query(
    `UPDATE vendor_invites SET revoked_at = now()
      WHERE id = $1 AND vendor_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING label`,
    [req.params.id, req.vendor.id]);
  if (!r.rowCount) throw E.notFound('Invite not found');
  await vAudit(req, { action: 'vendor.team.invite_cancel', targetType: 'invite', targetId: req.params.id, detail: r.rows[0].label });
  res.status(204).end();
});

// Remove a member (staff, or another owner). You can't remove yourself.
router.delete('/team/:userId', requireOwner, async (req, res) => {
  if (!isUuid(req.params.userId)) throw E.notFound('Team member not found');
  if (req.params.userId === req.user.id) throw E.invalid('OWN_MEMBERSHIP', 'You cannot remove yourself');
  const m = await db.tx(async (c) => {
    const { rows: [row] } = await c.query(
      `DELETE FROM vendor_members m USING users u WHERE m.vendor_id = $1 AND m.user_id = $2 AND u.id = m.user_id
       RETURNING u.id, u.full_name, m.role`, [req.vendor.id, req.params.userId]);
    if (!row) throw E.notFound('Team member not found');
    await vAudit(req, { action: 'vendor.team.remove', targetType: 'user', targetId: row.id, targetLabel: row.full_name,
      detail: row.role }, c);
    return row;
  });
  realtime.disconnectUser(m.id);
  res.status(204).end();
});

// ---- 15.5 Temporary access grants ---------------------------------------
function grantStatus(g) {
  const now = Date.now();
  if (g.revoked_at) return 'ended';
  if (new Date(g.ends_at) <= now) return 'expired';
  if (!g.user_id) return new Date(g.invite_expires_at) <= now ? 'invite_expired' : 'invite_sent';
  return new Date(g.starts_at) > now ? 'scheduled' : 'active';
}
const grantView = (g) => ({
  id: g.id,
  device: { id: g.device_id, serial: g.serial_no, name: g.device_name },
  label: g.label,
  user: g.user_id ? { id: g.user_id, fullName: g.full_name, phone: g.phone } : null,
  permissions: g.permissions,
  startsAt: g.starts_at,
  endsAt: g.ends_at,
  status: grantStatus(g),
  inviteExpiresAt: g.user_id ? null : g.invite_expires_at,
  endedAt: g.revoked_at,
  createdAt: g.created_at,
});
const GRANT_SQL = `
  SELECT g.*, d.serial_no, d.name AS device_name, u.full_name, u.phone
    FROM device_access_grants g JOIN devices d ON d.id = g.device_id LEFT JOIN users u ON u.id = g.user_id`;

async function loadGrant(req, id, c = db) {
  if (!isUuid(id)) throw E.notFound('Grant not found');
  const { rows: [g] } = await c.query(`${GRANT_SQL} WHERE g.id = $1 AND g.vendor_id = $2`, [id, req.vendor.id]);
  if (!g) throw E.notFound('Grant not found');
  return g;
}

// ?deviceId= to filter; ?status=current (default: not ended/expired) | all
router.get('/grants', async (req, res) => {
  const q = parse(z.object({ deviceId: z.uuid().optional(), status: z.enum(['current', 'all']).optional() }), req.query);
  const vals = [req.vendor.id];
  let where = 'g.vendor_id = $1';
  if (q.deviceId) { vals.push(q.deviceId); where += ` AND g.device_id = $${vals.length}`; }
  if (q.status !== 'all') where += ' AND g.revoked_at IS NULL AND g.ends_at > now()';
  const rows = await db.many(`${GRANT_SQL} WHERE ${where} ORDER BY g.ends_at DESC LIMIT 500`, vals);
  res.json({ items: rows.map(grantView) });
});

const isoTime = z.iso.datetime({ offset: true });

function checkGrantPerms(list) {
  const uniq = [...new Set(list)];
  if (!uniq.length || uniq.some((p) => !GRANT_PERMS.includes(p))) {
    throw E.invalid('BAD_PERMISSION', 'Choose one or more of: ' + GRANT_PERMS.join(', '), 'permissions');
  }
  return uniq.sort();
}

// Create a grant + its login link (shown once). The link works for 7 days or
// until endsAt, whichever is first; access itself runs startsAt..endsAt.
router.post('/grants', async (req, res) => {
  const body = parse(z.object({
    deviceId: z.uuid(),
    label: z.string().trim().min(1, 'Label is required').max(60),
    permissions: z.array(z.string().max(40)).max(10).optional(),
    startsAt: isoTime.optional(),
    endsAt: isoTime,
  }), req.body);
  const d = await vendorDevice(req, body.deviceId);
  needInUse(d);   // 009: temporary access only on sensors the vendor uses
  const perms = checkGrantPerms(body.permissions || DEFAULT_GRANT_PERMS);
  const starts = body.startsAt ? new Date(body.startsAt) : new Date();
  const ends = new Date(body.endsAt);
  if (ends <= starts) throw E.invalid('BAD_PERIOD', 'The end must be after the start', 'endsAt');
  if (ends <= new Date()) throw E.invalid('BAD_PERIOD', 'The end must be in the future', 'endsAt');
  const token = randomToken();
  const g = await db.tx(async (c) => {
    const { rows: [row] } = await c.query(
      `INSERT INTO device_access_grants (device_id, vendor_id, label, permissions, starts_at, ends_at, granted_by,
                                         token_hash, invite_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, LEAST(now() + make_interval(days => $9), $6)) RETURNING id`,
      [d.id, req.vendor.id, body.label, perms, starts, ends, req.user.id, hmac('invite', token), INVITE_DAYS]);
    await vAudit(req, { action: 'vendor.grant.create', targetType: 'device', targetId: d.id, targetLabel: d.serial_no,
      detail: `"${body.label}": ${perms.join(', ')} until ${ends.toISOString()}`, data: { grantId: row.id } }, c);
    return loadGrant(req, row.id, c);
  });
  res.status(201).json({ grant: grantView(g), inviteUrl: `${config.publicBaseUrl}/invite/${token}`, expiresAt: g.invite_expires_at });
});

// Extend (or shorten) a grant: new endsAt (and optionally startsAt).
router.patch('/grants/:id', async (req, res) => {
  const body = parse(z.object({ startsAt: isoTime.optional(), endsAt: isoTime }).strict(), req.body);
  const g = await loadGrant(req, req.params.id);
  if (g.revoked_at) throw E.conflict('GRANT_ENDED', 'This access was ended; create a new one');
  const starts = body.startsAt ? new Date(body.startsAt) : new Date(g.starts_at);
  const ends = new Date(body.endsAt);
  if (ends <= starts) throw E.invalid('BAD_PERIOD', 'The end must be after the start', 'endsAt');
  if (ends <= new Date()) throw E.invalid('BAD_PERIOD', 'Use "End now" to stop access', 'endsAt');
  const out = await db.tx(async (c) => {
    // end_notified_at reset: the watcher notifies again when the new end passes.
    await c.query(
      `UPDATE device_access_grants SET starts_at = $2, ends_at = $3, end_notified_at = NULL,
              invite_expires_at = CASE WHEN user_id IS NULL THEN LEAST(invite_expires_at, $3) ELSE invite_expires_at END
        WHERE id = $1`, [g.id, starts, ends]);
    await vAudit(req, { action: 'vendor.grant.extend', targetType: 'device', targetId: g.device_id, targetLabel: g.serial_no,
      detail: `"${g.label}": ${new Date(g.ends_at).toISOString()} → ${ends.toISOString()}`, data: { grantId: g.id } }, c);
    return loadGrant(req, g.id, c);
  });
  if (g.user_id) await vendors.notifyUser(g.user_id, g.device_id);
  res.json({ grant: grantView(out) });
});

// End early (also cancels an unused link).
router.post('/grants/:id/end', async (req, res) => {
  const g = await loadGrant(req, req.params.id);
  if (g.revoked_at) return res.json({ grant: grantView(g) });
  const out = await db.tx(async (c) => {
    await c.query('UPDATE device_access_grants SET revoked_at = now(), end_notified_at = now() WHERE id = $1', [g.id]);
    await vAudit(req, { action: 'vendor.grant.end', targetType: 'device', targetId: g.device_id, targetLabel: g.serial_no,
      detail: `"${g.label}"`, data: { grantId: g.id } }, c);
    return loadGrant(req, g.id, c);
  });
  if (g.user_id) await vendors.notifyUser(g.user_id, g.device_id);
  res.json({ grant: grantView(out) });
});

module.exports = { router, GRANT_PERMS };
