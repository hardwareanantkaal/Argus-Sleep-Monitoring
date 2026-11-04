// docs/API.md §5.6–5.7 The invite landing page: preview (public) and accept.
// Link-only: the token in /invite/<token> is the secret. No phone check.
// Works for family (device_invites) and team (staff_invites) invites.
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
  return st ? { kind: 'staff', ...st } : null;
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
    deviceName: inv.kind === 'device' ? inv.device_name : undefined,
    roleName: inv.kind === 'staff' ? inv.role_name : undefined,
    permissions: inv.kind === 'device' ? inv.permissions : await rolePermissions(inv),
    expiresAt: inv.expires_at,
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
  realtime.disconnectUser(req.user.id); // reconnect to pick up admin rooms
  res.json(result);
});

module.exports = router;
