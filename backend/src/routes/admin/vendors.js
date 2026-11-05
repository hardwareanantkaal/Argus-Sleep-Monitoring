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
         (SELECT count(*)::int FROM devices d WHERE d.vendor_id = v.id AND d.claim_stage = 'vendor_stock') AS stock_count,
         (SELECT count(*)::int FROM devices d WHERE d.vendor_id = v.id AND d.claim_stage = 'owned') AS sold_count,
         (SELECT count(DISTINCT d.owner_id)::int FROM devices d WHERE d.vendor_id = v.id) AS customer_count,
         (SELECT count(*)::int FROM vendor_members m WHERE m.vendor_id = v.id) AS member_count,
         (SELECT count(*)::int FROM vendor_groups g WHERE g.vendor_id = v.id) AS group_count
    FROM vendors v`;
const vendorView = (v) => ({
  id: v.id, name: v.name, contactName: v.contact_name, phone: v.phone, email: v.email, status: v.status,
  deviceCount: v.device_count, stockCount: v.stock_count, soldCount: v.sold_count, customerCount: v.customer_count,
  memberCount: v.member_count, groupCount: v.group_count, createdAt: v.created_at,
});

// The vendor-owner invite link (shown once). Used by the one-step create and the re-invite.
async function ownerInvite(req, c, v, label) {
  const token = randomToken();
  const { rows: [i] } = await c.query(
    `INSERT INTO vendor_invites (vendor_id, role, label, token_hash, invited_by, expires_at)
     VALUES ($1, 'owner', $2, $3, $4, now() + make_interval(days => $5)) RETURNING id, expires_at`,
    [v.id, label, hmac('invite', token), req.user.id, INVITE_DAYS]);
  await audit(req, { action: 'vendor.owner_invite', targetType: 'vendor', targetId: v.id, targetLabel: v.name, detail: `"${label}"` }, c);
  return {
    invite: { id: i.id, label, role: 'owner', expiresAt: i.expires_at },
    inviteUrl: `${config.publicBaseUrl}/invite/${token}`,
    expiresAt: i.expires_at,
  };
}

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
// v2: ONE step. Creates the vendor (the owner's name / phone / email are its
// contact) AND the owner invite link, returned once: {vendor, inviteUrl, expiresAt}.
router.post('/vendors', need, async (req, res) => {
  const body = parse(z.object({
    name: z.string().trim().min(1, 'Company name is required').max(80),
    ownerName: z.string().trim().min(1, "Owner's name is required").max(60),
    ownerPhone: z.string().trim().min(6, "Owner's phone is required").max(20),
    ownerEmail: z.email().max(120).nullable().optional().or(z.literal('')),
  }), req.body);
  const out = await db.tx(async (c) => {
    const { rows: [v] } = await c.query(
      `INSERT INTO vendors (name, contact_name, phone, email, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, name`,
      [body.name, body.ownerName, body.ownerPhone, body.ownerEmail || null, req.user.id]);
    await audit(req, { action: 'vendor.create', targetType: 'vendor', targetId: v.id, targetLabel: body.name }, c);
    return { id: v.id, ...(await ownerInvite(req, c, v, body.ownerName)) };
  });
  res.status(201).json({ vendor: vendorView(await loadVendor(out.id)), inviteUrl: out.inviteUrl, expiresAt: out.expiresAt });
});

// Edit the company name or the contact (owner) details.
router.patch('/vendors/:id', need, async (req, res) => {
  const body = parse(z.object({
    name: z.string().trim().min(1).max(80).optional(),
    contactName: optText(80), phone: optText(20), email: z.email().max(120).nullable().optional().or(z.literal('')),
  }).strict(), req.body);
  const v = await loadVendor(req.params.id);
  const cols = { name: 'name', contactName: 'contact_name', phone: 'phone', email: 'email' };
  const sets = [];
  const vals = [v.id];
  for (const [k, col] of Object.entries(cols)) {
    if (body[k] === undefined) continue;
    vals.push(body[k] === '' ? null : body[k]);
    sets.push(`${col} = $${vals.length}`);
  }
  if (sets.length) {
    await db.tx(async (c) => {
      await c.query(`UPDATE vendors SET ${sets.join(', ')} WHERE id = $1`, vals);
      await audit(req, { action: 'vendor.update', targetType: 'vendor', targetId: v.id, targetLabel: body.name || v.name, data: body }, c);
    });
  }
  res.json(vendorView(await loadVendor(v.id)));
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
    `SELECT d.id, d.serial_no, d.name, d.group_id, d.claim_stage, d.stocked_at, d.claimed_at, d.owner_id, o.full_name AS owner_name,
            COALESCE(s.is_online, false) AS online, s.fw_version, s.last_seen_at,
            (SELECT count(*)::int FROM device_access_grants g WHERE g.device_id = d.id AND g.user_id IS NOT NULL
               AND g.revoked_at IS NULL AND now() >= g.starts_at AND now() < g.ends_at) AS active_grants
       FROM devices d LEFT JOIN device_state s ON s.device_id = d.id LEFT JOIN users o ON o.id = d.owner_id
      WHERE d.vendor_id = $1 ORDER BY COALESCE(d.stocked_at, d.claimed_at)`, [v.id]);
  res.json({
    ...vendorView(v),
    summary: await vendors.summary(v.id),
    customers: await vendors.customers(v.id),
    members: members.map((m) => ({ userId: m.id, fullName: m.full_name, phone: m.phone, role: m.role })),
    invites: invites.map((i) => ({ id: i.id, label: i.label, role: i.role, expiresAt: i.expires_at })),
    groups: groups.map((g) => ({ id: g.id, name: g.name })),
    devices: devices.map((d) => ({
      id: d.id, serial: d.serial_no, name: d.name, groupId: d.group_id,
      stage: d.claim_stage === 'owned' ? 'sold' : 'stock',
      customer: d.owner_id ? { id: d.owner_id, fullName: d.owner_name } : null,
      stockedAt: d.stocked_at, soldAt: d.claim_stage === 'owned' ? d.claimed_at : null,
      online: live.getStatus(d.id)?.online ?? d.online, fw: d.fw_version, lastSeenAt: d.last_seen_at, activeGrants: d.active_grants,
    })),
  });
});

// A new vendor-owner link (lost / expired link, or a second owner). Shown once.
router.post('/vendors/:id/invites', need, async (req, res) => {
  const body = parse(z.object({ label: z.string().trim().min(1, 'Label is required').max(60) }), req.body);
  const v = await loadVendor(req.params.id);
  if (v.status !== 'active') throw E.conflict('VENDOR_DISABLED', 'This vendor is disabled');
  res.status(201).json(await db.tx((c) => ownerInvite(req, c, v, body.label)));
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
