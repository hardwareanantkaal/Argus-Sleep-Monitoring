const db = require('../db');

// Add one audit_log row. Pass a transaction client as `q` to make the audit
// entry part of the same transaction as the change it describes.
//   audit(req, { action: 'device.claim', targetType: 'device', targetId, targetLabel, detail }, client)
async function audit(req, entry, q = db) {
  const actor = req?.user || entry.actor || null;
  await q.query(
    `INSERT INTO audit_log (actor_id, actor_name, action, target_type, target_id, target_label, detail, data, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [actor?.id || null, actor?.full_name || actor?.fullName || null, entry.action,
      entry.targetType || null, entry.targetId != null ? String(entry.targetId) : null,
      entry.targetLabel || null, entry.detail || null, entry.data ? JSON.stringify(entry.data) : null,
      req?.ip || null],
  );
}

module.exports = { audit };
