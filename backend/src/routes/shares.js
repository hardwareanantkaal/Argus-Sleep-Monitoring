// docs/API.md §5.1–5.5 Sharing a sensor with family (link-only invites).
// Mounted under /devices; uses the same device() access check as routes/devices.js.
const express = require('express');
const config = require('../config');
const db = require('../db');
const { parse, z } = require('../lib/validate');
const { audit } = require('../lib/audit');
const { randomToken, hmac } = require('../lib/crypto');
const { requireUser } = require('../middleware/auth');
const { device } = require('./devices');
const realtime = require('../services/realtime');
const { E } = require('../errors');

const router = express.Router();
router.use(requireUser);

const DEVICE_PERMS = ['live.view', 'history.view', 'alerts.receive', 'settings.edit', 'sharing.manage'];
const INVITE_DAYS = 7;
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

// Device permissions only, at least one. Only the owner may hand out
// sharing.manage (so a family member can't create co-managers who then
// lock the owner's other family out).
function checkPerms(perms, req) {
  const list = [...new Set(perms)];
  if (!list.length || list.some((p) => !DEVICE_PERMS.includes(p))) {
    throw E.invalid('BAD_PERMISSION', 'Choose one or more of: ' + DEVICE_PERMS.join(', '), 'permissions');
  }
  if (list.includes('sharing.manage') && req.device.owner_id !== req.user.id) {
    throw E.invalid('BAD_PERMISSION', 'Only the owner can let someone manage sharing', 'permissions');
  }
  return list.sort();
}

const permsBody = z.object({ permissions: z.array(z.string().max(40)).max(10) });

// 5.1 Owner, people with access, open invites (never a URL: only the hash is stored).
router.get('/:id/shares', device('sharing.manage'), async (req, res) => {
  const d = req.device;
  const owner = await db.one('SELECT full_name, phone FROM users WHERE id = $1', [d.owner_id]);
  const shares = await db.many(
    `SELECT u.id, u.full_name, u.phone, array_agg(p.permission ORDER BY p.permission) FILTER (WHERE p.permission IS NOT NULL) AS perms
       FROM device_shares s JOIN users u ON u.id = s.user_id
       LEFT JOIN device_share_permissions p ON p.device_id = s.device_id AND p.user_id = s.user_id
      WHERE s.device_id = $1 AND u.deleted_at IS NULL
      GROUP BY u.id, u.full_name, u.phone, s.created_at ORDER BY s.created_at`, [d.id]);
  const invites = await db.many(
    `SELECT id, label, permissions, expires_at FROM device_invites
      WHERE device_id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()
      ORDER BY created_at`, [d.id]);
  res.json({
    owner: owner ? { fullName: owner.full_name, phone: owner.phone } : null,
    shares: shares.map((s) => ({ userId: s.id, fullName: s.full_name, phone: s.phone, permissions: s.perms || [], status: 'joined' })),
    invites: invites.map((i) => ({ id: i.id, label: i.label, permissions: i.permissions, status: 'invite_sent', expiresAt: i.expires_at })),
  });
});

// 5.2 Create an invite link (shown once).
router.post('/:id/invites', device('sharing.manage'), async (req, res) => {
  const body = parse(permsBody.extend({ label: z.string().trim().min(1, 'Label is required').max(60) }), req.body);
  const permissions = checkPerms(body.permissions, req);
  const token = randomToken();
  const inv = await db.tx(async (c) => {
    const { rows: [i] } = await c.query(
      `INSERT INTO device_invites (device_id, label, permissions, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6)) RETURNING id, label, permissions, expires_at`,
      [req.device.id, body.label, permissions, hmac('invite', token), req.user.id, INVITE_DAYS]);
    await audit(req, { action: 'share.invite', targetType: 'device', targetId: req.device.id, targetLabel: req.device.serial_no,
      detail: `"${body.label}": ${permissions.join(', ')}` }, c);
    return i;
  });
  res.status(201).json({
    invite: { id: inv.id, label: inv.label, permissions: inv.permissions, expiresAt: inv.expires_at },
    inviteUrl: `${config.publicBaseUrl}/invite/${token}`,
    expiresAt: inv.expires_at,
  });
});

// 5.3 Cancel an invite (its link stops working).
router.delete('/:id/invites/:inviteId', device('sharing.manage'), async (req, res) => {
  if (!isUuid(req.params.inviteId)) throw E.notFound('Invite not found');
  const r = await db.query(
    `UPDATE device_invites SET revoked_at = now()
      WHERE id = $1 AND device_id = $2 AND accepted_at IS NULL AND revoked_at IS NULL RETURNING label`,
    [req.params.inviteId, req.device.id]);
  if (!r.rowCount) throw E.notFound('Invite not found');
  await audit(req, { action: 'share.invite_cancel', targetType: 'device', targetId: req.device.id,
    targetLabel: req.device.serial_no, detail: r.rows[0].label });
  res.status(204).end();
});

async function loadShare(req) {
  if (!isUuid(req.params.userId)) throw E.notFound('Not shared with that person');
  const s = await db.one('SELECT user_id FROM device_shares WHERE device_id = $1 AND user_id = $2', [req.device.id, req.params.userId]);
  if (!s) throw E.notFound('Not shared with that person');
  return s;
}

// 5.4 Change someone's permissions.
router.patch('/:id/shares/:userId', device('sharing.manage'), async (req, res) => {
  const body = parse(permsBody, req.body);
  await loadShare(req);
  const permissions = checkPerms(body.permissions, req);
  await db.tx(async (c) => {
    await c.query('DELETE FROM device_share_permissions WHERE device_id = $1 AND user_id = $2', [req.device.id, req.params.userId]);
    await c.query(
      'INSERT INTO device_share_permissions (device_id, user_id, permission) SELECT $1, $2, unnest($3::text[])',
      [req.device.id, req.params.userId, permissions]);
    await audit(req, { action: 'share.update', targetType: 'device', targetId: req.device.id, targetLabel: req.device.serial_no,
      detail: permissions.join(', '), data: { userId: req.params.userId } }, c);
  });
  realtime.revokeDevice(req.params.userId, req.device.id, permissions);
  res.json({ userId: req.params.userId, permissions });
});

// 5.5 Remove someone's access (at once, including their open sockets).
router.delete('/:id/shares/:userId', device('sharing.manage'), async (req, res) => {
  await loadShare(req);
  await db.tx(async (c) => {
    await c.query('DELETE FROM device_shares WHERE device_id = $1 AND user_id = $2', [req.device.id, req.params.userId]);
    await c.query('DELETE FROM user_device_alert_mutes WHERE device_id = $1 AND user_id = $2', [req.device.id, req.params.userId]);
    await audit(req, { action: 'share.remove', targetType: 'device', targetId: req.device.id, targetLabel: req.device.serial_no,
      data: { userId: req.params.userId } }, c);
  });
  realtime.revokeDevice(req.params.userId, req.device.id, null);
  res.status(204).end();
});

module.exports = { router, DEVICE_PERMS };
