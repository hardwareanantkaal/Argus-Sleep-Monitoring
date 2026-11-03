// docs/API.md §1 Auth: register, login, refresh, logout, password reset.
const express = require('express');
const db = require('../db');
const { parse, z, f } = require('../lib/validate');
const { hashPassword, checkPassword } = require('../lib/crypto');
const { audit } = require('../lib/audit');
const { limits } = require('../middleware/rateLimit');
const { requireUser } = require('../middleware/auth');
const tokens = require('../services/tokens');
const { loadUser, loadUserByPhone, userView } = require('../services/users');
const { E } = require('../errors');

const router = express.Router();
const DUMMY_HASH = require('bcryptjs').hashSync('not-a-real-password', 11);

// 1.1 Register (no SMS step in v1, decision C3)
router.post('/register', async (req, res) => {
  const body = parse(z.object({ fullName: f.fullName, phone: f.phone, country: f.country, password: f.password }), req.body);
  const passwordHash = await hashPassword(body.password);
  const user = await db.tx(async (c) => {
    let row;
    try {
      ({ rows: [row] } = await c.query(
        `INSERT INTO users (full_name, phone, country, password_hash) VALUES ($1, $2, $3, $4) RETURNING id`,
        [body.fullName, body.phone, body.country, passwordHash]));
    } catch (err) {
      if (err.code === '23505') throw E.conflict('PHONE_TAKEN', 'An account with this phone number already exists', 'phone');
      throw err;
    }
    const u = await loadUser(row.id, c);
    await audit(req, { actor: u, action: 'user.register', targetType: 'user', targetId: u.id, targetLabel: u.phone }, c);
    await tokens.startSession(res, req, u, c);
    return u;
  });
  res.status(201).json({ user: await userView(user) });
});

// 1.2 Login. Rate limit: 5 failures per 10 min per phone + IP.
router.post('/login', async (req, res) => {
  const body = parse(z.object({ phone: f.phone, password: z.string().min(1).max(128) }), req.body);
  const key = `${body.phone}|${req.ip}`;
  limits.login.check(key);
  const user = await loadUserByPhone(body.phone);
  // Unknown phones still run one bcrypt compare, so the reply time doesn't
  // reveal which numbers have accounts.
  const ok = await checkPassword(body.password, user?.password_hash || DUMMY_HASH);
  if (!user || !ok) {
    limits.login.fail(key);
    throw E.unauth('BAD_CREDENTIALS', 'Wrong phone number or password');
  }
  if (user.is_disabled) throw E.forbidden('USER_DISABLED', 'This account is disabled');
  limits.login.reset(key);
  await tokens.startSession(res, req, user);
  await db.query('UPDATE users SET last_login_at = now(), last_active_at = now() WHERE id = $1', [user.id]);
  res.json({ user: await userView(user) });
});

// 1.3 Refresh: swaps the argus_rt cookie for a new pair of cookies.
router.post('/refresh', async (req, res) => {
  try {
    const r = await tokens.rotateRefresh(req.cookies?.[tokens.RT], req);
    tokens.setAuthCookies(res, tokens.signAccess(r.userId, r.tokenVersion, r.refresh.id), r.refresh.token);
    res.status(204).end();
  } catch (err) {
    tokens.clearAuthCookies(res);
    throw err;
  }
});

// 1.4 Logout (this browser only)
router.post('/logout', requireUser, async (req, res) => {
  await tokens.deleteRefresh(req.cookies?.[tokens.RT]);
  tokens.clearAuthCookies(res);
  res.status(204).end();
});

// 1.5 Logout everywhere
router.post('/logout-all', requireUser, async (req, res) => {
  await db.tx(async (c) => {
    await tokens.revokeAll(c, req.user.id);
    await audit(req, { action: 'user.logout_all', targetType: 'user', targetId: req.user.id }, c);
  });
  tokens.clearAuthCookies(res);
  res.status(204).end();
});

// 1.6 Password reset with a support-made one-time link (7.4)
router.post('/password/reset', async (req, res) => {
  const body = parse(z.object({ token: z.string().min(1).max(2000), newPassword: f.password }), req.body);
  const payload = tokens.verifyReset(body.token);
  const passwordHash = await hashPassword(body.newPassword);
  await db.tx(async (c) => {
    const u = await loadUser(payload.sub, c);
    if (!u || u.deleted_at || u.token_version !== payload.tv) {
      throw E.bad('RESET_TOKEN_INVALID', 'This reset link is invalid or has expired');
    }
    await c.query('UPDATE users SET password_hash = $2 WHERE id = $1', [u.id, passwordHash]);
    await tokens.revokeAll(c, u.id);   // also makes this link single-use
    await audit(req, { actor: u, action: 'user.password_reset', targetType: 'user', targetId: u.id }, c);
  });
  res.status(204).end();
});

// 1.7 SMS OTP is switched off in v1 (decision C3); the routes stay reserved.
router.all('/otp/{*rest}', () => { throw E.notEnabled('SMS codes are not enabled yet'); });

module.exports = router;
