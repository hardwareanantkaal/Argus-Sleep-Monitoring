// Web session tokens (docs/API.md §0 "Auth cookies").
//   argus_at  access JWT {sub, tv, sid}, 15 min, Path=/
//   argus_rt  random refresh token, 30 days, Path=/api/v1/auth, stored as sha256
// The refresh token rotates on every use. Presenting an already-rotated token
// again means it was copied: every session of that user is ended.
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../db');
const { sha256, randomToken } = require('../lib/crypto');
const { E } = require('../errors');
const log = require('../logger');

const AT = 'argus_at';
const RT = 'argus_rt';
const RT_PATH = '/api/v1/auth';

function signAccess(userId, tokenVersion, sid) {
  return jwt.sign({ sub: userId, tv: tokenVersion, sid }, config.jwtSecret,
    { algorithm: 'HS256', expiresIn: config.accessTokenTtlS, audience: 'access' });
}

// Returns the payload, or throws 401 TOKEN_EXPIRED / NOT_LOGGED_IN.
function verifyAccess(token) {
  try {
    return jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'], audience: 'access' });
  } catch (err) {
    if (err.name === 'TokenExpiredError') throw E.unauth('TOKEN_EXPIRED', 'Session expired, refresh needed');
    throw E.unauth('NOT_LOGGED_IN', 'Please log in');
  }
}

async function createRefresh(q, userId, req) {
  const token = randomToken();
  const row = await q.query(
    `INSERT INTO refresh_tokens (user_id, token_hash, user_agent, ip, expires_at)
     VALUES ($1, $2, $3, $4, now() + make_interval(days => $5)) RETURNING id`,
    [userId, sha256(token), (req.get('user-agent') || '').slice(0, 300) || null, req.ip || null,
      config.refreshTokenTtlDays],
  );
  return { token, id: row.rows[0].id };
}

// Ends every session of a user: refresh tokens deleted, token_version bumped
// (so access tokens already issued stop working on their next request).
async function revokeAll(q, userId) {
  await q.query('DELETE FROM refresh_tokens WHERE user_id = $1', [userId]);
  await q.query('UPDATE users SET token_version = token_version + 1 WHERE id = $1', [userId]);
}

// Swap a refresh token for a new pair. Returns {userId, tokenVersion, refresh}.
// Re-use of an already rotated token:
//   - its replacement was NEVER used -> the client just didn't get our reply
//     (two tabs at once, or a lost response on a phone): give a fresh pair.
//   - its replacement WAS used -> two parties hold the chain: theft, so every
//     session of the user ends.
// Every failure is logged with its reason.
async function rotateRefresh(token, req) {
  const fail = (reason, userId = null) => {
    // A visitor without cookies (the web probes once on load) is normal: debug only.
    log[userId || reason !== 'no refresh cookie sent' ? 'info' : 'debug']({ reason, userId, ip: req.ip }, 'refresh refused');
    return E.unauth('REFRESH_INVALID', 'Please log in again');
  };
  if (!token) throw fail('no refresh cookie sent');
  const hash = sha256(token);
  const result = await db.tx(async (c) => {
    const { rows } = await c.query(
      `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at, rt.replaced_by, u.token_version, u.is_disabled, u.deleted_at
         FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
        WHERE rt.token_hash = $1 FOR UPDATE OF rt`, [hash]);
    const rt = rows[0];
    if (!rt) return { error: 'unknown token (logged out, or all sessions ended)' };
    if (new Date(rt.expires_at) <= new Date() || rt.deleted_at) return { error: 'expired', userId: rt.user_id };
    if (rt.is_disabled) return { disabled: true };
    if (rt.revoked_at) {
      const next = rt.replaced_by
        ? (await c.query('SELECT id, revoked_at FROM refresh_tokens WHERE id = $1 FOR UPDATE', [rt.replaced_by])).rows[0]
        : null;
      if (next && !next.revoked_at) {
        // Lost reply / concurrent refresh: retire the unused replacement, issue a new one.
        await c.query('DELETE FROM refresh_tokens WHERE id = $1', [next.id]);
        const refresh = await createRefresh(c, rt.user_id, req);
        await c.query('UPDATE refresh_tokens SET replaced_by = $2 WHERE id = $1', [rt.id, refresh.id]);
        log.info({ userId: rt.user_id }, 'refresh retried with an already rotated token: new pair issued');
        return { userId: rt.user_id, tokenVersion: rt.token_version, refresh };
      }
      // Return instead of throwing: a throw here would roll back revokeAll.
      await revokeAll(c, rt.user_id);
      return { error: 'rotated token re-used after its replacement was used: all sessions ended', userId: rt.user_id };
    }
    const refresh = await createRefresh(c, rt.user_id, req);
    await c.query('UPDATE refresh_tokens SET revoked_at = now(), replaced_by = $2 WHERE id = $1', [rt.id, refresh.id]);
    return { userId: rt.user_id, tokenVersion: rt.token_version, refresh };
  });
  if (result.disabled) throw E.forbidden('USER_DISABLED', 'This account is disabled');
  if (result.error) throw fail(result.error, result.userId);
  return result;
}

// Logout deletes the row instead of revoking it, so a normal logout can never
// look like token reuse.
async function deleteRefresh(token) {
  if (token) await db.query('DELETE FROM refresh_tokens WHERE token_hash = $1', [sha256(token)]);
}

const baseCookie = () => ({ httpOnly: true, secure: config.cookieSecure, sameSite: 'lax' });

function setAuthCookies(res, accessToken, refreshToken) {
  res.cookie(AT, accessToken, { ...baseCookie(), path: '/', maxAge: config.accessTokenTtlS * 1000 });
  res.cookie(RT, refreshToken, { ...baseCookie(), path: RT_PATH, maxAge: config.refreshTokenTtlDays * 86_400_000 });
}

function clearAuthCookies(res) {
  res.clearCookie(AT, { ...baseCookie(), path: '/' });
  res.clearCookie(RT, { ...baseCookie(), path: RT_PATH });
}

// Start a session: new refresh row + both cookies. Used by register and login.
async function startSession(res, req, user, q = db) {
  const refresh = await createRefresh(q, user.id, req);
  setAuthCookies(res, signAccess(user.id, user.token_version, refresh.id), refresh.token);
}

// One-time password reset token (API.md 1.6 / 7.4), 24 h. Bound to token_version,
// so it stops working after one successful reset (the reset bumps it).
function signReset(userId, tokenVersion, ttlS = 24 * 3600) {
  return jwt.sign({ sub: userId, tv: tokenVersion }, config.jwtSecret,
    { algorithm: 'HS256', expiresIn: ttlS, audience: 'pwreset' });
}

function verifyReset(token) {
  try {
    return jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'], audience: 'pwreset' });
  } catch {
    throw E.bad('RESET_TOKEN_INVALID', 'This reset link is invalid or has expired');
  }
}

module.exports = {
  AT, RT, signAccess, verifyAccess, rotateRefresh, deleteRefresh, revokeAll,
  setAuthCookies, clearAuthCookies, startSession, signReset, verifyReset,
};
