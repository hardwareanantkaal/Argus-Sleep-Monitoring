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

// 2.5 / 2.6 "How to reach me". No row yet = defaults.
const PREFS_DEFAULT = { pushEnabled: true, smsEnabled: false, quietEnabled: false, quietFrom: null, quietTo: null };
const prefsView = (r) => (r ? {
  pushEnabled: r.push_enabled, smsEnabled: r.sms_enabled, quietEnabled: r.quiet_enabled,
  quietFrom: r.quiet_from?.slice(0, 5) ?? null, quietTo: r.quiet_to?.slice(0, 5) ?? null,
} : PREFS_DEFAULT);

router.get('/notification-prefs', async (req, res) => {
  res.json(prefsView(await db.one('SELECT * FROM user_notification_prefs WHERE user_id = $1', [req.user.id])));
});

const hhmm = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Time must be HH:mm');
router.patch('/notification-prefs', async (req, res) => {
  const body = parse(z.object({
    pushEnabled: z.boolean().optional(), smsEnabled: z.boolean().optional(), quietEnabled: z.boolean().optional(),
    quietFrom: hhmm.nullable().optional(), quietTo: hhmm.nullable().optional(),
  }).strict(), req.body);
  if (body.smsEnabled) throw E.invalid('SMS_NOT_ENABLED', 'SMS alerts are not available yet', 'smsEnabled');
  const cur = prefsView(await db.one('SELECT * FROM user_notification_prefs WHERE user_id = $1', [req.user.id]));
  const next = { ...cur, ...body };
  if (next.quietEnabled && (!next.quietFrom || !next.quietTo)) {
    throw E.bad('VALIDATION', 'Quiet hours need a start and end time', 'quietFrom');
  }
  const row = await db.one(
    `INSERT INTO user_notification_prefs (user_id, push_enabled, sms_enabled, quiet_enabled, quiet_from, quiet_to)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id) DO UPDATE SET push_enabled = $2, sms_enabled = $3, quiet_enabled = $4,
       quiet_from = $5, quiet_to = $6
     RETURNING *`,
    [req.user.id, next.pushEnabled, next.smsEnabled, next.quietEnabled, next.quietFrom, next.quietTo]);
  res.json(prefsView(row));
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
