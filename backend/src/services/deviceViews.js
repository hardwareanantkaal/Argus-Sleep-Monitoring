// deviceCard / deviceDetail of docs/API.md §3. What a viewer sees depends on
// their permissions on that device:
//   live (in-memory latest values)  needs live.view
//   lastNight                        needs history.view
//   connection.fw                    needs live.view
//   rest of connection + sensorSync  needs settings.edit
const db = require('../db');
const live = require('./live');

const BASE_SQL = `
  SELECT d.id, d.serial_no, d.name, d.room, d.timezone, d.place, d.sleep_cutoff, d.auto_update,
         d.hw_model, d.owner_id, d.mqtt_username,
         o.full_name AS owner_name,
         s.is_online, s.last_seen_at, s.fw_version, s.wifi_rssi, s.wifi_ssid, s.uptime_s,
         ds.version AS settings_version, ds.applied_version,
         (SELECT array_agg(p.permission ORDER BY p.permission) FROM device_user_permissions p
           WHERE p.device_id = d.id AND p.user_id = $1) AS perms
    FROM devices d
    LEFT JOIN users o ON o.id = d.owner_id
    LEFT JOIN device_state s ON s.device_id = d.id
    LEFT JOIN device_settings ds ON ds.device_id = d.id`;

function syncState(version, applied, online) {
  if (version == null) return null;
  if (applied >= version) return 'applied';
  return online ? 'sending' : 'queued_offline';
}

// lastNight is filled in by the sleep step (6); until then it is null.
let lastNightFn = async () => null;
const setLastNight = (fn) => { lastNightFn = fn; };

async function card(r, userId) {
  const perms = r.perms || [];
  const has = (p) => perms.includes(p);
  const isOwner = r.owner_id === userId;
  const mem = live.getStatus(r.id);
  const online = mem ? mem.online : !!r.is_online;
  return {
    id: r.id,
    serial: r.serial_no,
    name: r.name,
    room: r.room,
    tz: r.timezone,
    place: r.place,
    isOwner,
    sharedBy: isOwner ? null : { fullName: r.owner_name },
    myPermissions: perms,
    status: { online, lastSeenAt: mem?.lastSeenAt || r.last_seen_at },
    live: has('live.view') && online ? live.getLive(r.id) : null,
    lastNight: has('history.view') ? await lastNightFn(r.id) : null,
  };
}

async function detail(r, userId) {
  const c = await card(r, userId);
  const has = (p) => c.myPermissions.includes(p);
  const out = { ...c, sleepCutoff: r.sleep_cutoff?.slice(0, 5), autoUpdate: r.auto_update, hwModel: r.hw_model };
  if (has('settings.edit')) {
    out.connection = { fw: r.fw_version, rssi: r.wifi_rssi, wifiSsid: r.wifi_ssid, uptimeS: r.uptime_s };
    out.sensorSync = { version: r.settings_version, appliedVersion: r.applied_version,
      sync: syncState(r.settings_version, r.applied_version, c.status.online) };
  } else if (has('live.view')) {
    out.connection = { fw: r.fw_version };
  }
  return out;
}

// All devices the user can access (owned + shared), as cards.
async function listFor(userId) {
  const { rows } = await db.query(
    `${BASE_SQL} WHERE d.id IN (SELECT device_id FROM device_user_permissions WHERE user_id = $1)
      ORDER BY (d.owner_id = $1) DESC, d.claimed_at, d.serial_no`, [userId]);
  return Promise.all(rows.map((r) => card(r, userId)));
}

// One device row for this user, or null when they have no access.
async function rowFor(userId, deviceId, q = db) {
  const { rows } = await q.query(`${BASE_SQL} WHERE d.id = $2`, [userId, deviceId]);
  const r = rows[0];
  return r && r.perms ? r : null;
}

module.exports = { card, detail, listFor, rowFor, setLastNight, syncState };
