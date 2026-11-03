// Who is calling? Reads the argus_at cookie, then reloads the user from the
// database on EVERY request, so disabling an account or "log out everywhere"
// (token_version bump) takes effect at once.
const { verifyAccess, AT } = require('../services/tokens');
const { loadUser, staffPermissions, touchActive } = require('../services/users');
const { E } = require('../errors');

// Shared with the Socket.IO handshake. Returns the user row or throws.
async function userFromAccessToken(token) {
  if (!token) throw E.unauth('NOT_LOGGED_IN', 'Please log in');
  const payload = verifyAccess(token);
  const user = await loadUser(payload.sub);
  if (!user || user.deleted_at || user.token_version !== payload.tv) {
    throw E.unauth('NOT_LOGGED_IN', 'Your session has ended, please log in again');
  }
  if (user.is_disabled) throw E.forbidden('USER_DISABLED', 'This account is disabled');
  user.sid = payload.sid;
  return user;
}

async function requireUser(req, res, next) {
  req.user = await userFromAccessToken(req.cookies?.[AT]);
  touchActive(req.user);
  next();
}

// Use after requireUser: requireStaff('devices.view'). Customers and staff
// without the permission get 403 FORBIDDEN.
function requireStaff(permission) {
  return async (req, res, next) => {
    if (req.user.staff_role_id == null) throw E.forbidden();
    req.staffPerms ??= new Set(await staffPermissions(req.user.id));
    if (permission && !req.staffPerms.has(permission)) throw E.forbidden('FORBIDDEN', `Needs permission ${permission}`);
    next();
  };
}

module.exports = { userFromAccessToken, requireUser, requireStaff };
