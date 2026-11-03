// "Who may see which device, with which permissions?" in one place.
// Reads the device_user_permissions view (owner = all 5, family = theirs).
const db = require('../db');

// Set of device permission codes this user has on this device (empty = none).
async function devicePerms(userId, deviceId, q = db) {
  const { rows } = await q.query(
    'SELECT permission FROM device_user_permissions WHERE user_id = $1 AND device_id = $2', [userId, deviceId]);
  return new Set(rows.map((r) => r.permission));
}

// Of `deviceIds`, the ones this user can access at all.
async function accessibleDevices(userId, deviceIds, q = db) {
  if (!deviceIds.length) return [];
  const { rows } = await q.query(
    `SELECT DISTINCT device_id FROM device_user_permissions
      WHERE user_id = $1 AND device_id = ANY($2::uuid[])`, [userId, deviceIds]);
  return rows.map((r) => r.device_id);
}

// Users who hold `permission` on a device (e.g. who gets alert:new).
async function usersWith(deviceId, permission, q = db) {
  const { rows } = await q.query(
    'SELECT user_id FROM device_user_permissions WHERE device_id = $1 AND permission = $2', [deviceId, permission]);
  return rows.map((r) => r.user_id);
}

module.exports = { devicePerms, accessibleDevices, usersWith };
