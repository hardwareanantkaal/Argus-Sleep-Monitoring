// docs/API.md §15.1 Admin: vendors (staff permission vendors.manage).
// Create / list / get, invite the vendor owner by link, disable / enable.
const express = require('express');
const config = require('../../config');
const db = require('../../db');
const { parse, z } = require('../../lib/validate');
const { audit } = require('../../lib/audit');
const { randomToken, hmac } = require('../../lib/crypto');
const { requireStaff } = require('../../middleware/auth');
const live = require('../../services/live');
const vendors = require('../../services/vendors');
const { E } = require('../../errors');

const router = express.Router();
const need = requireStaff('vendors.manage');
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const INVITE_DAYS = 7;

const LIST_SQL = `
  SELECT v.*, (SELECT count(*)::int FROM devices d WHERE d.vendor_id = v.id) AS device_count,
         (SELECT count(*)::int FROM vendor_members m WHERE m.vendor_id = v.id) AS member_count,
         (SELECT count(*)::int FROM vendor_groups g WHERE g.vendor_id = v.id) AS group_count
    FROM vendors v`;
const vendorView = (v) => ({
  id: v.id, name: v.name, contactName: v.contact_name, phone: v.phone, email: v.email, status: v.status,
  deviceCount: v.device_count, memberCount: v.member_count, groupCount: v.group_count, createdAt: v.created_at,
});

async function loadVendor(id) {
  if (!isUuid(id)) throw E.notFound('Vendor not found');
  const v = await db.one(`${LIST_SQL} WHERE v.id = $1`, [id]);
  if (!v) throw E.notFound('Vendor not found');
  return v;
}

router.get('/vendors', need, async (req, res) => {
  const q = parse(z.object({ q: z.string().trim().max(80).optional(), status: z.enum(['active', 'disabled']).optional() }), req.query);
  const where = [];
  const vals = [];
  if (q.q) { vals.push(`%${q.q}%`); where.push(`(v.name ILIKE $${vals.length} OR v.contact_name ILIKE $${vals.length} OR v.phone ILIKE $${vals.length})`); }
  if (q.status) { vals.push(q.status); where.push(`v.status = $${vals.length}`); }
  const rows = await db.many(`${LIST_SQL} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY lower(v.name)`, vals);
  res.json({ items: rows.map(vendorView) });
});

const optText = (max) => z.string().trim().max(max).nullable().optional();
router.post('/vendors', need, async (req, res) => {
  const body = parse(z.object({
    name: z.string().trim().min(1, 'Name is required').max(80),
    contactName: optText(80), phone: optText(20), email: z.email().max(120).nullable().optional(),
  }), req.body);
  const id = await db.tx(async (c) => {
    const { rows: [v] } = await c.query(
      `INSERT INTO vendors (name, contact_name, phone, email, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [body.name, body.contactName || null, body.phone || null, body.email || null, req.user.id]);
    await audit(req, { action: 'vendor.create', targetType: 'vendor', targetId: v.id, targetLabel: body.name }, c);
    return v.id;
  });
  res.status(201).json(vendorView(await loadVendor(id)));
});

// One vendor with its members, open invites, groups and devices.
router.get('/vendors/:id', need, async (req, res) => {
  const v = await loadVendor(req.params.id);
  const members = await db.many(
    `SELECT u.id, u.full_name, u.phone, m.role FROM vendor_members m JOIN users u ON u.id = m.user_id
      WHERE m.vendor_id = $1 ORDER BY (m.role = 'owner') DESC, u.full_name`, [v.id]);
  const invites = await db.many(
    `SELECT id, label, role, expires_at FROM vendor_invites
      WHERE vendor_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at`, [v.id]);
  const groups = await db.many('SELECT id, name FROM vendor_groups WHERE vendor_id = $1 ORDER BY lower(name)', [v.id]);
  const devices = await db.many(
    `SELECT d.id, d.serial_no, d.name, d.group_id, COALESCE(s.is_online, false) AS online, s.fw_version, s.last_seen_at,
            (SELECT count(*)::int FROM device_access_grants g WHERE g.device_id = d.id AND g.user_id IS NOT NULL
               AND g.revoked_at IS NULL AND now() >= g.starts_at AND now() < g.ends_at) AS active_grants
       FROM devices d LEFT JOIN device_state s ON s.device_id = d.id WHERE d.vendor_id = $1 ORDER BY d.claimed_at`, [v.id]);
  res.json({
    ...vendorView(v),
    members: members.map((m) => ({ userId: m.id, fullName: m.full_name, phone: m.phone, role: m.role })),
    invites: invites.map((i) => ({ id: i.id, label: i.label, role: i.role, expiresAt: i.expires_at })),
    groups: groups.map((g) => ({ id: g.id, name: g.name })),
    devices: devices.map((d) => ({
      id: d.id, serial: d.serial_no, name: d.name, groupId: d.group_id,
      online: live.getStatus(d.id)?.online ?? d.online, fw: d.fw_version, lastSeenAt: d.last_seen_at, activeGrants: d.active_grants,
    })),
  });
});

// Invite the vendor owner by link (shown once).
router.post('/vendors/:id/invites', need, async (req, res) => {
  const body = parse(z.object({ label: z.string().trim().min(1, 'Label is required').max(60) }), req.body);
  const v = await loadVendor(req.params.id);
  if (v.status !== 'active') throw E.conflict('VENDOR_DISABLED', 'This vendor is disabled');
  const token = randomToken();
  const inv = await db.tx(async (c) => {
    const { rows: [i] } = await c.query(
      `INSERT INTO vendor_invites (vendor_id, role, label, token_hash, invited_by, expires_at)
       VALUES ($1, 'owner', $2, $3, $4, now() + make_interval(days => $5)) RETURNING id, expires_at`,
      [v.id, body.label, hmac('invite', token), req.user.id, INVITE_DAYS]);
    await audit(req, { action: 'vendor.owner_invite', targetType: 'vendor', targetId: v.id, targetLabel: v.name, detail: `"${body.label}"` }, c);
    return i;
  });
  res.status(201).json({
    invite: { id: inv.id, label: body.label, role: 'owner', expiresAt: inv.expires_at },
    inviteUrl: `${config.publicBaseUrl}/invite/${token}`,
    expiresAt: inv.expires_at,
  });
});

router.delete('/vendors/:id/invites/:inviteId', need, async (req, res) => {
  const v = await loadVendor(req.params.id);
  if (!isUuid(req.params.inviteId)) throw E.notFound('Invite not found');
  const r = await db.query(
    `UPDATE vendor_invites SET revoked_at = now()
      WHERE id = $1 AND vendor_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING label`, [req.params.inviteId, v.id]);
  if (!r.rowCount) throw E.notFound('Invite not found');
  await audit(req, { action: 'vendor.invite_cancel', targetType: 'vendor', targetId: v.id, targetLabel: v.name, detail: r.rows[0].label });
  res.status(204).end();
});

// Disable: the vendor team and every grant holder lose access at once (the
// permission view ignores disabled vendors). Devices and history are kept.
async function setStatus(req, res, status) {
  const v = await loadVendor(req.params.id);
  if (v.status !== status) {
    await db.tx(async (c) => {
      await c.query('UPDATE vendors SET status = $2 WHERE id = $1', [v.id, status]);
      await audit(req, { action: status === 'disabled' ? 'vendor.disable' : 'vendor.enable', targetType: 'vendor',
        targetId: v.id, targetLabel: v.name }, c);
    });
    await vendors.disconnectVendorUsers(v.id);
  }
  res.json(vendorView(await loadVendor(v.id)));
}
router.post('/vendors/:id/disable', need, (req, res) => setStatus(req, res, 'disabled'));
router.post('/vendors/:id/enable', need, (req, res) => setStatus(req, res, 'active'));

module.exports = router;
