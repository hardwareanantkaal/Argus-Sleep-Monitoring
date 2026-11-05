const db = require('../db');

const USER_COLS = `u.id, u.full_name, u.phone, u.country, u.password_hash, u.staff_role_id,
  u.is_disabled, u.token_version, u.last_active_at, u.created_at, u.deleted_at,
  r.name AS role_name`;

async function loadUser(id, q = db) {
  const { rows } = await q.query(
    `SELECT ${USER_COLS} FROM users u LEFT JOIN staff_roles r ON r.id = u.staff_role_id WHERE u.id = $1`, [id]);
  return rows[0] || null;
}

async function loadUserByPhone(phone, q = db) {
  const { rows } = await q.query(
    `SELECT ${USER_COLS} FROM users u LEFT JOIN staff_roles r ON r.id = u.staff_role_id
      WHERE u.phone = $1 AND u.deleted_at IS NULL`, [phone]);
  return rows[0] || null;
}

// Staff permission codes of a user (empty for customers). Owner role = all.
async function staffPermissions(userId, q = db) {
  const { rows } = await q.query(
    'SELECT permission FROM staff_user_permissions WHERE user_id = $1 ORDER BY permission', [userId]);
  return rows.map((r) => r.permission);
}

// The user's vendor membership (API.md §15), or null. Disabled vendors = null.
async function vendorOf(userId, q = db) {
  const { rows: [v] } = await q.query(
    `SELECT v.id, v.name, m.role FROM vendor_members m JOIN vendors v ON v.id = m.vendor_id
      WHERE m.user_id = $1 AND v.status = 'active'`, [userId]);
  return v ? { id: v.id, name: v.name, role: v.role } : null;
}

// The `user` object of API.md §1.
async function userView(u, q = db) {
  const isStaff = u.staff_role_id != null;
  return {
    id: u.id,
    fullName: u.full_name,
    phone: u.phone,
    country: u.country,
    kind: isStaff ? 'admin' : 'customer',
    role: isStaff ? { id: u.staff_role_id, name: u.role_name } : null,
    permissions: isStaff ? await staffPermissions(u.id, q) : [],
    createdAt: u.created_at,
    vendor: await vendorOf(u.id, q),
  };
}

// "Last active" in admin tables; written at most every 5 minutes per user.
function touchActive(u) {
  if (u.last_active_at && Date.now() - new Date(u.last_active_at).getTime() < 5 * 60_000) return;
  db.query('UPDATE users SET last_active_at = now() WHERE id = $1', [u.id]).catch(() => {});
}

module.exports = { vendorOf, loadUser, loadUserByPhone, staffPermissions, userView, touchActive };
