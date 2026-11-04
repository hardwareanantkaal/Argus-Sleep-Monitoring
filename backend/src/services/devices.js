const { audit } = require('../lib/audit');

// Take a device away from its owner (API.md 2.4 delete account, 3.9 remove
// device, 8.7 admin unclaim). Run inside a transaction (`c` = tx client).
// Health data goes with it (decision D5): sleep sessions, alerts, rules.
// The claim code is cleared too, so support must issue a new sticker code
// (8.6) before anyone can claim it again: a resold sensor can't be
// re-claimed by its old owner.
async function releaseDevice(c, device, req, reason) {
  await c.query('DELETE FROM sleep_sessions WHERE device_id = $1', [device.id]);
  await c.query('DELETE FROM alerts WHERE device_id = $1', [device.id]);
  await c.query('DELETE FROM alert_rules WHERE device_id = $1', [device.id]);
  await c.query('DELETE FROM device_invites WHERE device_id = $1', [device.id]);
  await c.query('DELETE FROM device_shares WHERE device_id = $1', [device.id]);
  // Back to factory defaults; the settings trigger bumps the version so the
  // sensor receives them on its next sync.
  await c.query(
    `UPDATE device_settings SET exit_s = DEFAULT, live_s = DEFAULT, idle_s = DEFAULT, struggle = DEFAULT,
            unattended = DEFAULT, unatt_min = DEFAULT, updated_by = NULL
      WHERE device_id = $1`, [device.id]);
  await c.query(
    `UPDATE devices SET owner_id = NULL, claimed_at = NULL, claim_code_hash = NULL, claim_code_enc = NULL,
            name = NULL, room = NULL, place = NULL
      WHERE id = $1`, [device.id]);
  await c.query(
    `INSERT INTO device_events (device_id, type, message, data) VALUES ($1, 'unclaimed', $2, $3)`,
    [device.id, reason, JSON.stringify({ ownerId: device.owner_id })]);
  await audit(req, { action: 'device.unclaim', targetType: 'device', targetId: device.id,
    targetLabel: device.serial_no, detail: reason }, c);
}

module.exports = { releaseDevice };
