// Vendors (docs/VENDOR.md, API.md §15): helpers + the grant-end watcher.
// Access itself is decided by the device_user_permissions view (every REST
// request and every socket subscribe reads it), so a grant stops working the
// moment now() passes ends_at. This watcher only TELLS open browsers
// (access:changed) and takes their sockets out of the device rooms.
const db = require('../db');
const log = require('../logger');
const realtime = require('./realtime');
const live = require('./live');

const CHECK_MS = 30_000;

// v2: stock counts of one vendor (vendor dashboard + admin vendor detail).
async function summary(vendorId) {
  return db.one(
    `SELECT count(*)::int AS total,
            count(*) FILTER (WHERE d.claim_stage = 'vendor_stock')::int AS stock,
            count(*) FILTER (WHERE d.claim_stage = 'owned')::int AS sold,
            count(DISTINCT d.owner_id)::int AS customers,
            count(*) FILTER (WHERE s.is_online)::int AS online
       FROM devices d LEFT JOIN device_state s ON s.device_id = d.id WHERE d.vendor_id = $1`, [vendorId]);
}

// v2: the vendor's customers = everyone who owns one of its devices, each
// with the devices they bought (one customer can have many).
async function customers(vendorId) {
  const rows = await db.many(
    `SELECT u.id AS user_id, u.full_name, u.phone, u.country, d.id, d.serial_no, d.name, d.claimed_at,
            COALESCE(s.is_online, false) AS online, s.fw_version, s.last_seen_at
       FROM devices d JOIN users u ON u.id = d.owner_id LEFT JOIN device_state s ON s.device_id = d.id
      WHERE d.vendor_id = $1 AND d.claim_stage = 'owned'
      ORDER BY lower(u.full_name), u.id, d.claimed_at`, [vendorId]);
  const out = [];
  for (const r of rows) {
    let c = out[out.length - 1];
    if (!c || c.id !== r.user_id) {
      c = { id: r.user_id, fullName: r.full_name, phone: r.phone, country: r.country, firstClaimedAt: r.claimed_at, devices: [] };
      out.push(c);
    }
    c.devices.push({ id: r.id, serial: r.serial_no, name: r.name, claimedAt: r.claimed_at,
      online: live.getStatus(r.id)?.online ?? r.online, fw: r.fw_version, lastSeenAt: r.last_seen_at });
  }
  return out;
}
let timer = null;

async function sweepEndedGrants() {
  const { rows } = await db.query(
    `UPDATE device_access_grants SET end_notified_at = now()
      WHERE user_id IS NOT NULL AND end_notified_at IS NULL AND (ends_at <= now() OR revoked_at IS NOT NULL)
      RETURNING device_id, user_id`);
  for (const r of rows) await notifyUser(r.user_id, r.device_id);
}

// Re-read what this user may still do on the device and push access:changed
// (null = no access left). They may still have access another way.
async function notifyUser(userId, deviceId) {
  const { rows } = await db.query(
    'SELECT DISTINCT permission FROM device_user_permissions WHERE user_id = $1 AND device_id = $2 ORDER BY permission',
    [userId, deviceId]);
  await realtime.revokeDevice(userId, deviceId, rows.length ? rows.map((x) => x.permission) : null);
}

// Everyone with vendor-team access to the vendor's devices loses/gains it at
// once (vendor disabled, member removed): simplest is to drop their sockets.
async function disconnectVendorUsers(vendorId) {
  const { rows } = await db.query(
    `SELECT user_id FROM vendor_members WHERE vendor_id = $1
     UNION SELECT user_id FROM device_access_grants WHERE vendor_id = $1 AND user_id IS NOT NULL`, [vendorId]);
  for (const r of rows) realtime.disconnectUser(r.user_id);
}

function start() {
  timer = setInterval(() => sweepEndedGrants().catch((err) => log.error({ err }, 'grant sweep failed')), CHECK_MS);
  timer.unref();
}

module.exports = { start, sweepEndedGrants, notifyUser, disconnectVendorUsers, summary, customers };
