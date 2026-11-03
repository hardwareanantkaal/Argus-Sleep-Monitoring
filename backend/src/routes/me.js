// docs/API.md §2 My account: profile, password, delete account, notification
// prefs, push subscriptions.
const express = require('express');
const db = require('../db');
const config = require('../config');
const { parse, z, f } = require('../lib/validate');
const { hashPassword, checkPassword } = require('../lib/crypto');
const { audit } = require('../lib/audit');
const { requireUser } = require('../middleware/auth');
const tokens = require('../services/tokens');
const { loadUser, userView } = require('../services/users');
const { releaseDevice } = require('../services/devices');
const { E } = require('../errors');

const router = express.Router();
router.use(requireUser);

// 2.1
router.get('/', async (req, res) => {
  res.json(await userView(req.user));
});

// 2.2 Name and country. The phone is the login and can't be changed here.
router.patch('/', async (req, res) => {
  const body = parse(z.object({ fullName: f.fullName.optional(), country: f.country.optional() }).strict(), req.body);
  if (body.fullName !== undefined || body.country !== undefined) {
    await db.query(
      `UPDATE users SET full_name = COALESCE($2, full_name), country = COALESCE($3, country) WHERE id = $1`,
      [req.user.id, body.fullName ?? null, body.country ?? null]);
    await audit(req, { action: 'user.update', targetType: 'user', targetId: req.user.id, data: body });
  }
  res.json(await userView(await loadUser(req.user.id)));
});

// 2.3 Change password; every OTHER session is logged out.
router.post('/password', async (req, res) => {
  const body = parse(z.object({ currentPassword: z.string().min(1).max(128), newPassword: f.password }), req.body);
  if (!(await checkPassword(body.currentPassword, req.user.password_hash))) {
    throw E.unauth('BAD_CREDENTIALS', 'Current password is wrong');
  }
  const passwordHash = await hashPassword(body.newPassword);
  await db.tx(async (c) => {
    await c.query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.user.id, passwordHash]);
    await tokens.revokeAll(c, req.user.id);
    await audit(req, { action: 'user.password_change', targetType: 'user', targetId: req.user.id }, c);
    // revokeAll bumped token_version: start a fresh session for this browser.
    await tokens.startSession(res, req, await loadUser(req.user.id, c), c);
  });
  res.status(204).end();
});

// 2.4 Delete account (soft delete). Owned devices are released with their
// history (D5); shares on other people's devices are removed.
router.delete('/', async (req, res) => {
  const body = parse(z.object({ password: z.string().min(1).max(128) }), req.body);
  if (!(await checkPassword(body.password, req.user.password_hash))) {
    throw E.unauth('BAD_CREDENTIALS', 'Password is wrong');
  }
  await db.tx(async (c) => {
    const { rows: owned } = await c.query(
      'SELECT id, serial_no, owner_id FROM devices WHERE owner_id = $1 FOR UPDATE', [req.user.id]);
    for (const d of owned) await releaseDevice(c, d, req, 'owner deleted account');
    await c.query('DELETE FROM device_shares WHERE user_id = $1', [req.user.id]);
    await c.query('DELETE FROM push_tokens WHERE user_id = $1', [req.user.id]);
    await tokens.revokeAll(c, req.user.id);
    await c.query('UPDATE users SET deleted_at = now(), staff_role_id = NULL WHERE id = $1', [req.user.id]);
    await audit(req, { action: 'user.delete', targetType: 'user', targetId: req.user.id,
      targetLabel: req.user.phone, detail: `${owned.length} device(s) released` }, c);
  });
  tokens.clearAuthCookies(res);
  res.status(204).end();
});

// 2.5 / 2.6 In-app alert preferences: quiet hours + muted sensors
// ("Show me alerts from"). Alerts are in-app only in v1. No row = defaults.
async function prefsView(userId, q = db) {
  const r = await q.query('SELECT * FROM user_notification_prefs WHERE user_id = $1', [userId]);
  const m = await q.query('SELECT device_id FROM user_device_alert_mutes WHERE user_id = $1 ORDER BY created_at', [userId]);
  const p = r.rows[0];
  return {
    quietEnabled: p?.quiet_enabled ?? false,
    quietFrom: p?.quiet_from?.slice(0, 5) ?? null,
    quietTo: p?.quiet_to?.slice(0, 5) ?? null,
    mutedDeviceIds: m.rows.map((x) => x.device_id),
  };
}

router.get('/notification-prefs', async (req, res) => {
  res.json(await prefsView(req.user.id));
});

const hhmm = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Time must be HH:mm');
router.patch('/notification-prefs', async (req, res) => {
  const body = parse(z.object({
    quietEnabled: z.boolean().optional(),
    quietFrom: hhmm.nullable().optional(),
    quietTo: hhmm.nullable().optional(),
    mutedDeviceIds: z.array(z.uuid()).max(200).optional(),
  }).strict(), req.body);
  const result = await db.tx(async (c) => {
    const next = { ...(await prefsView(req.user.id, c)), ...body };
    if (next.quietEnabled && (!next.quietFrom || !next.quietTo)) {
      throw E.bad('VALIDATION', 'Quiet hours need a start and end time', 'quietFrom');
    }
    await c.query(
      `INSERT INTO user_notification_prefs (user_id, quiet_enabled, quiet_from, quiet_to)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO UPDATE SET quiet_enabled = $2, quiet_from = $3, quiet_to = $4`,
      [req.user.id, next.quietEnabled, next.quietFrom, next.quietTo]);
    if (body.mutedDeviceIds) {
      const ids = [...new Set(body.mutedDeviceIds)];
      // Only devices this user can access (same 404 as any other device route).
      const { rows } = await c.query(
        'SELECT DISTINCT device_id FROM device_user_permissions WHERE user_id = $1 AND device_id = ANY($2::uuid[])',
        [req.user.id, ids]);
      if (rows.length !== ids.length) throw E.notFound('Device not found');
      await c.query('DELETE FROM user_device_alert_mutes WHERE user_id = $1', [req.user.id]);
      if (ids.length) {
        await c.query(
          `INSERT INTO user_device_alert_mutes (user_id, device_id) SELECT $1, unnest($2::uuid[])`, [req.user.id, ids]);
      }
    }
    return prefsView(req.user.id, c);
  });
  res.json(result);
});

// 2.7 / 2.8 Web Push subscriptions. Alerts are in-app only in v1 (owner,
// 3 Nov), so these answer 501 until WEB_PUSH_ENABLED=true; the code is kept.
function pushEnabled() {
  if (!config.webPushEnabled) throw E.notEnabled('Push notifications are not enabled yet');
}

router.post('/push-subscriptions', async (req, res) => {
  pushEnabled();
  const body = parse(z.object({
    subscription: z.object({ endpoint: z.string().url().max(1000) }).passthrough(),
    platform: z.literal('web'),
  }), req.body);
  const token = JSON.stringify(body.subscription);
  if (token.length > 4000) throw E.bad('VALIDATION', 'Subscription is too large', 'subscription');
  await db.query(
    `INSERT INTO push_tokens (user_id, token, platform) VALUES ($1, $2, 'web')
     ON CONFLICT (token) DO UPDATE SET user_id = $1, last_seen_at = now()`, [req.user.id, token]);
  res.status(204).end();
});

router.delete('/push-subscriptions', async (req, res) => {
  pushEnabled();
  const body = parse(z.object({ endpoint: z.string().url().max(1000) }), req.body);
  await db.query(`DELETE FROM push_tokens WHERE user_id = $1 AND token::jsonb->>'endpoint' = $2`,
    [req.user.id, body.endpoint]);
  res.status(204).end();
});

module.exports = router;
