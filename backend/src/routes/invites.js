// docs/API.md §5.6–5.7 The invite landing page: preview (public) and accept.
// Link-only: the token in /invite/<token> is the secret. No phone check.
// Works for family (device_invites), team (staff_invites), vendor team
// (vendor_invites) and temporary access (device_access_grants) invites (§15).
const express = require('express');
const db = require('../db');
const { hmac } = require('../lib/crypto');
const { audit } = require('../lib/audit');
const { limits } = require('../middleware/rateLimit');
const { requireUser } = require('../middleware/auth');
const views = require('../services/deviceViews');
const realtime = require('../services/realtime');
const { ApiError, E } = require('../errors');

const router = express.Router();
const invalid = () => new ApiError(404, 'INVITE_INVALID', 'This invite link is not valid any more');

const OPEN = 'accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()';

// Find an open invite by token. `c` + lock = FOR UPDATE inside a transaction.
async function findInvite(token, q = db, lock = '') {
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token)) return null;
  const h = hmac('invite', token);
  const { rows: [dev] } = await q.query(
    `SELECT i.*, d.name AS device_name, d.serial_no, u.full_name AS inviter_name
       FROM device_invites i JOIN devices d ON d.id = i.device_id LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.token_hash = $1 AND i.${OPEN.replaceAll(' AND ', ' AND i.')} ${lock ? 'FOR UPDATE OF i' : ''}`, [h]);
  if (dev) return { kind: 'device', ...dev };
  const { rows: [st] } = await q.query(
    `SELECT i.*, r.name AS role_name, r.is_owner, u.full_name AS inviter_name
       FROM staff_invites i JOIN staff_roles r ON r.id = i.role_id LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.token_hash = $1 AND i.${OPEN.replaceAll(' AND ', ' AND i.')} ${lock ? 'FOR UPDATE OF i' : ''}`, [h]);
  if (st) return { kind: 'staff', ...st };
  const { rows: [vi] } = await q.query(
    `SELECT i.*, v.name AS vendor_name, u.full_name AS inviter_name
       FROM vendor_invites i JOIN vendors v ON v.id = i.vendor_id AND v.status = 'active'
       LEFT JOIN users u ON u.id = i.invited_by
      WHERE i.token_hash = $1 AND i.${OPEN.replaceAll(' AND ', ' AND i.')} ${lock ? 'FOR UPDATE OF i' : ''}`, [h]);
  if (vi) return { kind: 'vendor', ...vi };
  const { rows: [gr] } = await q.query(
    `SELECT g.*, d.name AS device_name, d.serial_no, v.name AS vendor_name, u.full_name AS inviter_name
       FROM device_access_grants g JOIN devices d ON d.id = g.device_id AND d.vendor_id = g.vendor_id
       JOIN vendors v ON v.id = g.vendor_id AND v.status = 'active'
       LEFT JOIN users u ON u.id = g.granted_by
      WHERE g.token_hash = $1 AND g.user_id IS NULL AND g.revoked_at IS NULL
        AND g.invite_expires_at > now() AND g.ends_at > now() ${lock ? 'FOR UPDATE OF g' : ''}`, [h]);
  return gr ? { kind: 'grant', ...gr } : null;
}

async function rolePermissions(inv, q = db) {
  const { rows } = await q.query(
    inv.is_owner
      ? "SELECT code AS permission FROM permissions WHERE scope = 'staff' ORDER BY sort_order"
      : 'SELECT permission FROM staff_role_permissions WHERE role_id = $1 ORDER BY permission',
    inv.is_owner ? [] : [inv.role_id]);
  return rows.map((r) => r.permission);
}

// Rate limit: 10 failed lookups per 10 min per IP.
function guard(req) {
  limits.invite.check(req.ip);
}

// 5.6 Preview (public).
router.get('/:token', async (req, res) => {
  guard(req);
  const inv = await findInvite(req.params.token);
  if (!inv) { limits.invite.fail(req.ip); throw invalid(); }
  res.json({
    kind: inv.kind,
    inviterName: inv.inviter_name || null,
    label: inv.label,
    deviceName: ['device', 'grant'].includes(inv.kind) ? inv.device_name : undefined,
    roleName: inv.kind === 'staff' ? inv.role_name : undefined,
    vendorName: ['vendor', 'grant'].includes(inv.kind) ? inv.vendor_name : undefined,
    vendorRole: inv.kind === 'vendor' ? inv.role : undefined,
    startsAt: inv.kind === 'grant' ? inv.starts_at : undefined,
    endsAt: inv.kind === 'grant' ? inv.ends_at : undefined,
    permissions: ['device', 'grant'].includes(inv.kind) ? inv.permissions : inv.kind === 'vendor' ? [] : await rolePermissions(inv),
    expiresAt: inv.kind === 'grant' ? inv.invite_expires_at : inv.expires_at,
  });
});

// 5.7 Accept (needs a session and a valid token; single use).
router.post('/:token/accept', requireUser, async (req, res) => {
  guard(req);
  const result = await db.tx(async (c) => {
    const inv = await findInvite(req.params.token, c, 'lock');
    if (!inv) { limits.invite.fail(req.ip); throw invalid(); }
    if (inv.kind === 'device') {
      const has = await c.query('SELECT 1 FROM device_user_permissions WHERE device_id = $1 AND user_id = $2 LIMIT 1',
        [inv.device_id, req.user.id]);
      if (has.rowCount) throw E.conflict('ALREADY_SHARED', 'You already have access to this sensor');
      await c.query('INSERT INTO device_shares (device_id, user_id, invited_by) VALUES ($1, $2, $3)',
        [inv.device_id, req.user.id, inv.invited_by]);
      await c.query('INSERT INTO device_share_permissions (device_id, user_id, permission) SELECT $1, $2, unnest($3::text[])',
        [inv.device_id, req.user.id, inv.permissions]);
      await c.query('UPDATE device_invites SET accepted_at = now(), accepted_by = $2 WHERE id = $1', [inv.id, req.user.id]);
      await audit(req, { action: 'share.accept', targetType: 'device', targetId: inv.device_id, targetLabel: inv.serial_no,
        detail: `"${inv.label}"` }, c);
      return { device: inv.device_id };
    }
    if (inv.kind === 'vendor') {
      const mem = await c.query('SELECT 1 FROM vendor_members WHERE user_id = $1', [req.user.id]);
      if (mem.rowCount) throw E.conflict('ALREADY_VENDOR_MEMBER', 'You are already on a vendor team');
      await c.query('INSERT INTO vendor_members (vendor_id, user_id, role) VALUES ($1, $2, $3)', [inv.vendor_id, req.user.id, inv.role]);
      await c.query('UPDATE vendor_invites SET accepted_at = now(), accepted_by = $2 WHERE id = $1', [inv.id, req.user.id]);
      await audit(req, { action: 'vendor.team.join', targetType: 'vendor', targetId: inv.vendor_id, targetLabel: inv.vendor_name,
        detail: `"${inv.label}" as ${inv.role}` }, c);
      return { vendor: { id: inv.vendor_id, name: inv.vendor_name, role: inv.role } };
    }
    if (inv.kind === 'grant') {
      const has = await c.query('SELECT 1 FROM device_user_permissions WHERE device_id = $1 AND user_id = $2 LIMIT 1',
        [inv.device_id, req.user.id]);
      if (has.rowCount) throw E.conflict('ALREADY_SHARED', 'You already have access to this sensor');
      await c.query('UPDATE device_access_grants SET user_id = $2, accepted_at = now(), token_hash = NULL WHERE id = $1',
        [inv.id, req.user.id]);
      await audit(req, { action: 'vendor.grant.accept', targetType: 'device', targetId: inv.device_id, targetLabel: inv.serial_no,
        detail: `"${inv.label}"`, data: { grantId: inv.id, vendorId: inv.vendor_id } }, c);
      return { grantDevice: inv.device_id, grant: { id: inv.id, startsAt: inv.starts_at, endsAt: inv.ends_at } };
    }
    if (req.user.staff_role_id != null) throw E.conflict('ALREADY_STAFF', 'You are already on the Argus team');
    await c.query('UPDATE users SET staff_role_id = $2 WHERE id = $1', [req.user.id, inv.role_id]);
    await c.query('UPDATE staff_invites SET accepted_at = now(), accepted_by = $2 WHERE id = $1', [inv.id, req.user.id]);
    await audit(req, { action: 'team.join', targetType: 'role', targetId: inv.role_id, targetLabel: inv.role_name,
      detail: `"${inv.label}"` }, c);
    return { role: { id: inv.role_id, name: inv.role_name } };
  });
  if (result.device) {
    const row = await views.rowFor(req.user.id, result.device);
    return res.json({ device: await views.card(row, req.user.id) });
  }
  if (result.grant) {
    // Before startsAt the device isn't visible yet: device is null until then.
    const row = await views.rowFor(req.user.id, result.grantDevice);
    return res.json({ grant: result.grant, device: row ? await views.card(row, req.user.id) : null });
  }
  if (result.vendor) return res.json(result);
  realtime.disconnectUser(req.user.id); // reconnect to pick up admin rooms
  res.json(result);
});

module.exports = router;
