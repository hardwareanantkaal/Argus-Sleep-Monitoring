// docs/API.md §6 Alerts (in-app only in v1).
//   6.1 GET /alerts                       (mounted at /alerts)
//   6.2 GET / 6.3 PUT /devices/:id/alert-rules   (mounted under /devices)
const express = require('express');
const db = require('../db');
const { parse, z } = require('../lib/validate');
const { audit } = require('../lib/audit');
const { requireUser } = require('../middleware/auth');
const { device } = require('./devices');
const alerts = require('../services/alerts');
const { E } = require('../errors');

const TYPES = ['breath_low', 'hr_out_of_range', 'out_of_bed', 'no_movement', 'device_offline'];
const hhmm = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Time must be HH:mm');

// 6.1 Alerts from devices where I have alerts.receive and haven't muted them.
const list = express.Router();
list.use(requireUser);
list.get('/', async (req, res) => {
  const q = parse(z.object({
    deviceId: z.uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(30),
    cursor: z.coerce.number().int().positive().optional(),
  }), req.query);
  const rows = await db.many(
    `SELECT a.id, a.device_id, d.name AS device_name, d.serial_no, a.type, a.severity, a.title, a.detail, a.value, a.started_at, a.ended_at
       FROM alerts a JOIN devices d ON d.id = a.device_id
      WHERE a.device_id IN (SELECT device_id FROM device_user_permissions WHERE user_id = $1 AND permission = 'alerts.receive')
        AND a.device_id NOT IN (SELECT device_id FROM user_device_alert_mutes WHERE user_id = $1)
        AND ($2::uuid IS NULL OR a.device_id = $2)
        AND ($3::bigint IS NULL OR a.id < $3)
      ORDER BY a.id DESC LIMIT $4`, [req.user.id, q.deviceId ?? null, q.cursor ?? null, q.limit + 1]);
  const more = rows.length > q.limit;
  res.json({
    items: rows.slice(0, q.limit).map((a) => ({ id: a.id, deviceId: a.device_id, deviceName: a.device_name, serial: a.serial_no,
      type: a.type, severity: a.severity, title: a.title, detail: a.detail, value: a.value, startedAt: a.started_at, endedAt: a.ended_at })),
    nextCursor: more ? String(rows[q.limit - 1].id) : null,
  });
});

// 6.2 / 6.3 Rules belong to the device.
const rules = express.Router();
rules.use(requireUser);

const ruleView = (r) => ({
  type: r.type, enabled: r.is_enabled, low: r.low_value, high: r.high_value, durationS: r.duration_s,
  windowFrom: r.window_from?.slice(0, 5) ?? null, windowTo: r.window_to?.slice(0, 5) ?? null,
});
async function loadRules(deviceId) {
  const rows = await db.many('SELECT * FROM alert_rules WHERE device_id = $1', [deviceId]);
  const by = new Map(rows.map((r) => [r.type, r]));
  return TYPES.filter((t) => by.has(t)).map((t) => ruleView(by.get(t)));
}

rules.get('/:id/alert-rules', device(), async (req, res) => {
  const p = req.device.perms;
  if (!p.includes('alerts.receive') && !p.includes('settings.edit')) throw E.forbidden('FORBIDDEN', 'You do not have permission for this');
  res.json({ rules: await loadRules(req.device.id), canEdit: p.includes('settings.edit') });
});

const ruleBody = z.object({
  type: z.enum(TYPES),
  enabled: z.boolean(),
  low: z.number().min(0).max(300).nullable().optional(),
  high: z.number().min(0).max(300).nullable().optional(),
  durationS: z.number().int().min(10).max(86400),
  windowFrom: hhmm.nullable().optional(),
  windowTo: hhmm.nullable().optional(),
});

rules.put('/:id/alert-rules', device('settings.edit'), async (req, res) => {
  const body = parse(z.object({ rules: z.array(ruleBody).min(1).max(TYPES.length) }), req.body);
  for (const r of body.rules) {
    if (r.type === 'breath_low' && r.low == null) throw E.invalid('BAD_RULE', 'Breathing rule needs a low value', 'low');
    if (r.type === 'hr_out_of_range' && (r.low == null || r.high == null || r.low >= r.high)) {
      throw E.invalid('BAD_RULE', 'Heart rate rule needs low < high', 'low');
    }
    if ((r.windowFrom == null) !== (r.windowTo == null)) throw E.invalid('BAD_RULE', 'A time window needs both times', 'windowFrom');
  }
  await db.tx(async (c) => {
    for (const r of body.rules) {
      await c.query(
        `INSERT INTO alert_rules (device_id, type, is_enabled, low_value, high_value, duration_s, window_from, window_to, updated_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (device_id, type) DO UPDATE SET is_enabled = $3, low_value = $4, high_value = $5, duration_s = $6,
           window_from = $7, window_to = $8, updated_by = $9`,
        [req.device.id, r.type, r.enabled, r.low ?? null, r.high ?? null, r.durationS, r.windowFrom ?? null, r.windowTo ?? null, req.user.id]);
    }
    await audit(req, { action: 'device.alert_rules', targetType: 'device', targetId: req.device.id, targetLabel: req.device.serial_no,
      detail: body.rules.map((r) => `${r.type}:${r.enabled ? 'on' : 'off'}`).join(', ') }, c);
  });
  alerts.forget(req.device.id);
  res.json({ rules: await loadRules(req.device.id), canEdit: true });
});

module.exports = { list, rules };
