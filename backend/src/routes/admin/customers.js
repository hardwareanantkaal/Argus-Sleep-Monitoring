// docs/API.md §7 Customers (non-staff accounts), §9.19 audit log,
// §9.20–9.21 Sleep rules (platform settings).
const express = require('express');
const config = require('../../config');
const db = require('../../db');
const { parse, z } = require('../../lib/validate');
const { audit } = require('../../lib/audit');
const { requireStaff } = require('../../middleware/auth');
const tokens = require('../../services/tokens');
const live = require('../../services/live');
const realtime = require('../../services/realtime');
const { E } = require('../../errors');

const router = express.Router();
const isUuid = (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');

const encCursor = (at, id) => Buffer.from(`${new Date(at).toISOString()}|${id}`).toString('base64url');
function decCursor(c) {
  if (!c) return null;
  const [at, id] = Buffer.from(c, 'base64url').toString().split('|');
  if (!at || !id || Number.isNaN(Date.parse(at))) throw E.bad('VALIDATION', 'Bad cursor', 'cursor');
  return { at, id };
}

// A customer = a live account without a staff role (staff are managed on the Team screen).
async function customer(id) {
  if (!isUuid(id)) throw E.notFound('Customer not found');
  const u = await db.one(
    'SELECT * FROM users WHERE id = $1 AND deleted_at IS NULL AND staff_role_id IS NULL', [id]);
  if (!u) throw E.notFound('Customer not found');
  return u;
}

const CUSTOMER_COLS = `u.id, u.full_name, u.phone, u.country, u.created_at, u.last_active_at, u.is_disabled, u.disabled_reason,
  (SELECT count(*)::int FROM devices d WHERE d.owner_id = u.id) AS device_count,
  (SELECT count(DISTINCT s.user_id)::int FROM device_shares s JOIN devices d ON d.id = s.device_id WHERE d.owner_id = u.id) AS family_count,
  COALESCE((SELECT array_agg(DISTINCT d.timezone) FROM devices d WHERE d.owner_id = u.id), '{}') AS tzs`;
const customerView = (r) => ({
  id: r.id, fullName: r.full_name, phone: r.phone, country: r.country, deviceTimeZones: r.tzs,
  deviceCount: r.device_count, familyCount: r.family_count, createdAt: r.created_at, lastActiveAt: r.last_active_at,
  status: r.is_disabled ? 'disabled' : 'active', disabledReason: r.disabled_reason || null,
});

// 7.1
router.get('/customers', requireStaff('customers.view'), async (req, res) => {
  const q = parse(z.object({
    q: z.string().trim().max(60).optional(), country: z.string().trim().toUpperCase().length(2).optional(),
    tz: z.string().max(60).optional(), status: z.enum(['active', 'disabled']).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20), cursor: z.string().max(200).optional(),
  }), req.query);
  const where = ['u.deleted_at IS NULL', 'u.staff_role_id IS NULL'];
  const vals = [];
  const add = (sql, v) => { vals.push(v); where.push(sql.replaceAll('?', `$${vals.length}`)); };
  if (q.q) add('(u.full_name ILIKE ? OR u.phone ILIKE ?)', `%${q.q}%`);
  if (q.country) add('u.country = ?', q.country);
  if (q.tz) add('EXISTS (SELECT 1 FROM devices d WHERE d.owner_id = u.id AND d.timezone = ?)', q.tz);
  if (q.status) where.push(q.status === 'disabled' ? 'u.is_disabled' : 'NOT u.is_disabled');
  const total = (await db.one(`SELECT count(*)::int AS n FROM users u WHERE ${where.join(' AND ')}`, vals)).n;
  const cur = decCursor(q.cursor);
  const pv = [...vals];
  let pw = where.join(' AND ');
  if (cur) { pv.push(cur.at, cur.id); pw += ` AND (u.created_at, u.id) < ($${pv.length - 1}::timestamptz, $${pv.length}::uuid)`; }
  pv.push(q.limit + 1);
  const rows = await db.many(`SELECT ${CUSTOMER_COLS} FROM users u WHERE ${pw} ORDER BY u.created_at DESC, u.id DESC LIMIT $${pv.length}`, pv);
  const more = rows.length > q.limit;
  const page = rows.slice(0, q.limit);
  res.json({ items: page.map(customerView), total, nextCursor: more ? encCursor(page.at(-1).created_at, page.at(-1).id) : null });
});

// 7.2
router.get('/customers/:id', requireStaff('customers.view'), async (req, res) => {
  const u = await customer(req.params.id);
  const row = await db.one(`SELECT ${CUSTOMER_COLS} FROM users u WHERE u.id = $1`, [u.id]);
  const devices = await db.many(
    `SELECT d.id, d.serial_no, d.name, d.timezone, s.is_online, s.fw_version, s.last_seen_at
       FROM devices d LEFT JOIN device_state s ON s.device_id = d.id WHERE d.owner_id = $1 ORDER BY d.claimed_at`, [u.id]);
  const family = await db.many(
    `SELECT f.full_name, f.phone, d.name AS device_name FROM device_shares s
       JOIN devices d ON d.id = s.device_id JOIN users f ON f.id = s.user_id
      WHERE d.owner_id = $1 AND f.deleted_at IS NULL ORDER BY d.name, f.full_name`, [u.id]);
  res.json({
    ...customerView(row),
    devices: devices.map((d) => ({ id: d.id, serial: d.serial_no, name: d.name, tz: d.timezone,
      online: live.getStatus(d.id)?.online ?? !!d.is_online, fw: d.fw_version, lastSeenAt: d.last_seen_at })),
    family: family.map((f) => ({ fullName: f.full_name, phone: f.phone, deviceName: f.device_name })),
  });
});

// 7.3 Disable / enable (disable logs them out everywhere at once)
router.post('/customers/:id/disable', requireStaff('customers.edit'), async (req, res) => {
  const body = parse(z.object({ reason: z.string().trim().min(1).max(200) }), req.body);
  const u = await customer(req.params.id);
  await db.tx(async (c) => {
    await c.query('UPDATE users SET is_disabled = true, disabled_at = now(), disabled_reason = $2 WHERE id = $1', [u.id, body.reason]);
    await tokens.revokeAll(c, u.id);
    await audit(req, { action: 'customer.disable', targetType: 'user', targetId: u.id, targetLabel: u.full_name, detail: `Reason: ${body.reason}` }, c);
  });
  realtime.disconnectUser(u.id);
  res.status(204).end();
});

router.post('/customers/:id/enable', requireStaff('customers.edit'), async (req, res) => {
  const u = await customer(req.params.id);
  await db.tx(async (c) => {
    await c.query('UPDATE users SET is_disabled = false, disabled_at = NULL, disabled_reason = NULL WHERE id = $1', [u.id]);
    await audit(req, { action: 'customer.enable', targetType: 'user', targetId: u.id, targetLabel: u.full_name }, c);
  });
  res.status(204).end();
});

// 7.4 One-time password reset link, 24 h, shown once. Support sends it (WhatsApp).
router.post('/customers/:id/reset-link', requireStaff('customers.edit'), async (req, res) => {
  const u = await customer(req.params.id);
  const ttlS = 24 * 3600;
  const token = tokens.signReset(u.id, u.token_version, ttlS);
  await audit(req, { action: 'customer.reset_link', targetType: 'user', targetId: u.id, targetLabel: u.full_name });
  res.json({ resetUrl: `${config.publicBaseUrl}/reset/${token}`, expiresAt: new Date(Date.now() + ttlS * 1000).toISOString() });
});

// 7.5
router.post('/customers/:id/logout-all', requireStaff('customers.edit'), async (req, res) => {
  const u = await customer(req.params.id);
  await db.tx(async (c) => {
    await tokens.revokeAll(c, u.id);
    await audit(req, { action: 'customer.logout_all', targetType: 'user', targetId: u.id, targetLabel: u.full_name }, c);
  });
  realtime.disconnectUser(u.id);
  res.status(204).end();
});

// 9.19 Audit log (read-only). from/to: YYYY-MM-DD inclusive, UTC.
router.get('/audit', requireStaff('audit.view'), async (req, res) => {
  const q = parse(z.object({
    q: z.string().trim().max(80).optional(), action: z.string().trim().max(40).optional(),
    actorId: z.uuid().optional(), targetType: z.string().max(20).optional(), targetId: z.string().max(80).optional(),
    from: ymd.optional(), to: ymd.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50), cursor: z.coerce.number().int().positive().optional(),
  }), req.query);
  const where = [];
  const vals = [];
  const add = (sql, v) => { vals.push(v); where.push(sql.replaceAll('?', `$${vals.length}`)); };
  if (q.q) add('(actor_name ILIKE ? OR action ILIKE ? OR target_label ILIKE ? OR detail ILIKE ?)', `%${q.q}%`);
  if (q.action) add('action LIKE ?', `${q.action.replace(/[%_]/g, '')}%`);
  if (q.actorId) add('actor_id = ?', q.actorId);
  if (q.targetType) add('target_type = ?', q.targetType);
  if (q.targetId) add('target_id = ?', q.targetId);
  if (q.from) add("created_at >= (?::date AT TIME ZONE 'UTC')", q.from);
  if (q.to) add("created_at < ((?::date + 1) AT TIME ZONE 'UTC')", q.to);
  if (q.cursor) add('id < ?', q.cursor);
  vals.push(q.limit + 1);
  const rows = await db.many(
    `SELECT id, created_at, actor_name, action, target_type, target_label, detail FROM audit_log
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT $${vals.length}`, vals);
  const more = rows.length > q.limit;
  res.json({
    items: rows.slice(0, q.limit).map((r) => ({ id: r.id, at: r.created_at, actorName: r.actor_name, action: r.action,
      targetType: r.target_type, targetLabel: r.target_label, detail: r.detail })),
    nextCursor: more ? String(rows[q.limit - 1].id) : null,
  });
});

// 9.20 / 9.21 Sleep rules
const settingsView = (s) => ({ mergeGapMin: s.merge_gap_min, minSessionMin: s.min_session_min,
  defaultSleepCutoff: s.default_sleep_cutoff.slice(0, 5), mainSleepMin: s.main_sleep_min });

router.get('/platform-settings', requireStaff('platform.settings'), async (req, res) => {
  res.json(settingsView(await db.one('SELECT * FROM app_settings WHERE id = 1')));
});

router.patch('/platform-settings', requireStaff('platform.settings'), async (req, res) => {
  const body = parse(z.object({
    mergeGapMin: z.number().int().min(0).max(240).optional(),
    minSessionMin: z.number().int().min(0).max(240).optional(),
    defaultSleepCutoff: z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Time must be HH:mm').optional(),
    mainSleepMin: z.number().int().min(60).max(600).optional(),
  }).strict(), req.body);
  const s = await db.tx(async (c) => {
    const { rows: [r] } = await c.query(
      `UPDATE app_settings SET merge_gap_min = COALESCE($1, merge_gap_min), min_session_min = COALESCE($2, min_session_min),
              default_sleep_cutoff = COALESCE($3::time, default_sleep_cutoff), main_sleep_min = COALESCE($4, main_sleep_min),
              updated_by = $5
        WHERE id = 1 RETURNING *`,
      [body.mergeGapMin ?? null, body.minSessionMin ?? null, body.defaultSleepCutoff ?? null, body.mainSleepMin ?? null, req.user.id]);
    await audit(req, { action: 'platform.sleep_rules', targetType: 'settings', targetLabel: 'Sleep rules', data: body,
      detail: Object.entries(body).map(([k, v]) => `${k}=${v}`).join(', ') }, c);
    return r;
  });
  res.json(settingsView(s));
});

module.exports = router;
