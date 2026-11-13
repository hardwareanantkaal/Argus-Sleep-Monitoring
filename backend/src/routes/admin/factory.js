// API.md §9b: the manufacturing station (9.24–9.29). Mounted under /api/v1/admin.
// Flashing and the serial monitor run in the browser (Web Serial + esptool-js);
// the backend hands out the factory image and records each board's result.
const express = require('express');
const fs = require('fs');
const db = require('../../db');
const { E } = require('../../errors');
const { z, parse } = require('../../lib/validate');
const { requireStaff } = require('../../middleware/auth');
const { staffPermissions } = require('../../services/users');
const { audit } = require('../../lib/audit');

const router = express.Router();
// "34:85:18:A1:0F:22" / "348518a10f22" -> "348518a10f22"
const normMac = (s) => String(s || '').toLowerCase().replace(/[^0-9a-f]/g, '');
const mac = z.string().transform(normMac).refine((m) => m.length === 12, 'MAC must be 6 bytes, e.g. 34:85:18:A1:0F:22');
const chip = z.string().trim().toUpperCase().min(2).max(40);

// Staff with ANY of these permissions (requireStaff takes one).
function requireAny(...perms) {
  return async (req, res, next) => {
    if (req.user.staff_role_id == null) throw E.forbidden();
    req.staffPerms ??= new Set(await staffPermissions(req.user.id));
    if (!perms.some((p) => req.staffPerms.has(p))) throw E.forbidden('FORBIDDEN', `Needs one of: ${perms.join(', ')}`);
    next();
  };
}
const has = (req, p) => req.staffPerms?.has(p);
const ANY_FACTORY = ['factory.flash', 'factory.monitor'];
const LOG_VIEW = ['factory.flash', 'factory.monitor', 'devices.view'];
const LOG_TAIL_MAX = 16384;

// 9.24
router.get('/factory/releases', requireStaff('factory.flash'), async (req, res) => {
  const q = parse(z.object({ chip: chip.optional() }), req.query);
  const rows = await db.many(
    `SELECT id, version, channel, chip_model, notes, factory_file_size, factory_sha256, factory_flash_size, factory_default,
            factory_file_path = file_path AS same_as_ota
       FROM firmware_releases
      WHERE factory_file_path IS NOT NULL AND ($1::text IS NULL OR chip_model = $1)
      ORDER BY factory_default DESC, created_at DESC`, [q.chip || null]);
  res.json({
    items: rows.map((r) => ({
      id: r.id, version: r.version, channel: r.channel, chipModel: r.chip_model, notes: r.notes, isDefault: r.factory_default,
      factory: { fileSize: r.factory_file_size, sha256: r.factory_sha256, flashSize: r.factory_flash_size,
        address: 0, sameAsOta: r.same_as_ota },
    })),
  });
});

// 9.25
router.get('/factory/releases/:id/image', requireStaff('factory.flash'), async (req, res) => {
  const id = parse(z.coerce.number().int(), req.params.id);
  const r = await db.one('SELECT version, factory_file_path, factory_file_size, factory_sha256 FROM firmware_releases WHERE id = $1', [id]);
  if (!r || !r.factory_file_path || !fs.existsSync(r.factory_file_path)) throw E.notFound('No factory image for this release');
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(r.factory_file_size),
    'Content-Disposition': `attachment; filename="argus_${r.version}_factory.bin"`,
    'x-sha256': r.factory_sha256,
    'Cache-Control': 'private, max-age=3600',
  });
  fs.createReadStream(r.factory_file_path).pipe(res);
});

const RUN_COLS = `r.id, r.mac::text AS mac, r.chip, r.release_id, r.fw_version, r.flashed, r.flash_ms, r.checks, r.result,
  r.fail_reason, r.notes, r.station, r.device_id, r.operator_id, r.operator_name, r.started_at, r.finished_at, d.serial_no`;
function outRun(r, full) {
  const o = {
    id: r.id, mac: r.mac, chip: r.chip, releaseId: r.release_id, fwVersion: r.fw_version, flashed: r.flashed,
    flashMs: r.flash_ms, result: r.result, failReason: r.fail_reason, station: r.station,
    operatorName: r.operator_name, serial: r.serial_no || null, deviceId: r.device_id,
    startedAt: r.started_at, finishedAt: r.finished_at,
  };
  if (full) Object.assign(o, { checks: r.checks, notes: r.notes, logTail: r.log_tail ?? null });
  return o;
}

// 9.26
router.post('/factory/runs', requireAny(...ANY_FACTORY), async (req, res) => {
  const b = parse(z.object({
    mac, chip,
    releaseId: z.number().int().optional(),
    station: z.string().trim().max(40).optional(),
  }), req.body);
  let rel = null;
  if (b.releaseId != null) {
    if (!has(req, 'factory.flash')) throw E.forbidden('FORBIDDEN', 'Flashing needs factory.flash');
    rel = await db.one('SELECT id, version, chip_model, factory_file_path FROM firmware_releases WHERE id = $1', [b.releaseId]);
    if (!rel || !rel.factory_file_path) throw E.notFound('No factory image for this release');
    if (rel.chip_model !== b.chip) {
      throw E.invalid('CHIP_MISMATCH', `This board is ${b.chip} but release ${rel.version} is for ${rel.chip_model}`, 'releaseId');
    }
  }
  const history = await db.one(
    `SELECT count(*)::int AS previous_runs,
            (SELECT result FROM factory_runs WHERE mac = $1 ORDER BY started_at DESC LIMIT 1) AS last_result,
            (SELECT fail_reason FROM factory_runs WHERE mac = $1 ORDER BY started_at DESC LIMIT 1) AS last_reason,
            max(started_at) AS last_at
       FROM factory_runs WHERE mac = $1`, [b.mac]);
  const dev = await db.one('SELECT id, serial_no FROM devices WHERE mac = $1', [b.mac]);
  const row = await db.one(
    `INSERT INTO factory_runs (mac, chip, release_id, fw_version, station, operator_id, operator_name, device_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [b.mac, b.chip, rel ? rel.id : null, rel ? rel.version : null, b.station || null, req.user.id, req.user.full_name,
      dev ? dev.id : null]); // a re-test of a registered board is linked to it straight away
  const run = await db.one(`SELECT ${RUN_COLS}, r.log_tail FROM factory_runs r LEFT JOIN devices d ON d.id = r.device_id WHERE r.id = $1`, [row.id]);
  res.status(201).json({
    run: outRun(run, true),
    history: {
      previousRuns: history.previous_runs, lastResult: history.last_result, lastReason: history.last_reason,
      lastAt: history.last_at, device: dev ? { id: dev.id, serial: dev.serial_no } : null,
    },
  });
});

const check = z.object({
  id: z.string().regex(/^[a-z_]{1,32}$/),
  ok: z.boolean().nullable(),
  value: z.string().max(200).optional(),
  ms: z.number().int().min(0).optional(),
});

// 9.27
router.patch('/factory/runs/:id', requireAny(...ANY_FACTORY), async (req, res) => {
  const id = parse(z.coerce.number().int(), req.params.id);
  const b = parse(z.object({
    flashed: z.boolean().optional(),
    flashMs: z.number().int().min(0).optional(),
    checks: z.array(check).max(30).optional(),
    result: z.enum(['pass', 'fail', 'aborted']).optional(),
    failReason: z.string().max(80).optional(),
    logTail: z.string().optional(),
    notes: z.string().max(500).optional(),
  }), req.body);
  const run = await db.one('SELECT * FROM factory_runs WHERE id = $1', [id]);
  if (!run) throw E.notFound('No such run');
  if (run.operator_id !== req.user.id) throw E.forbidden('FORBIDDEN', 'Only the person who started this run can change it');
  if (run.result !== 'running') throw E.conflict('RUN_FINISHED', 'This run is already finished');
  if (b.flashed && !run.fw_version) throw E.invalid('VALIDATION', 'This run was started without a release', 'flashed');
  if (b.result === 'pass' && b.checks && b.checks.some((c) => c.ok === false)) {
    throw E.invalid('CHECKS_FAILED', 'A failed check can\'t be marked as pass', 'result');
  }
  // Keep the END of the log: that's where the failure is.
  let tail = b.logTail;
  if (tail !== undefined) {
    let buf = Buffer.from(tail, 'utf8');
    if (buf.length > LOG_TAIL_MAX) buf = buf.subarray(buf.length - LOG_TAIL_MAX);
    tail = buf.toString('utf8').replace(/^�+/, '');
    while (Buffer.byteLength(tail) > LOG_TAIL_MAX) tail = tail.slice(1);
  }
  const failReason = b.result && b.result !== 'pass'
    ? (b.failReason || (b.checks || run.checks || []).find((c) => c.ok === false)?.id || (b.result === 'aborted' ? 'aborted' : 'manual'))
    : null;
  await db.tx(async (c) => {
    await c.query(
      `UPDATE factory_runs SET
         flashed     = COALESCE($2, flashed),
         flash_ms    = COALESCE($3, flash_ms),
         checks      = COALESCE($4::jsonb, checks),
         log_tail    = COALESCE($5, log_tail),
         notes       = COALESCE($6, notes),
         result      = COALESCE($7::factory_result, result),
         fail_reason = CASE WHEN $7 IS NULL THEN fail_reason ELSE $8 END,
         finished_at = CASE WHEN $7 IS NULL THEN finished_at ELSE now() END
       WHERE id = $1`,
      [id, b.flashed ?? null, b.flashMs ?? null, b.checks ? JSON.stringify(b.checks) : null, tail ?? null,
        b.notes ?? null, b.result ?? null, failReason]);
    if (b.result) {
      await audit(req, { action: 'factory.run', targetType: 'factory_run', targetId: id, targetLabel: run.mac,
        detail: `${b.result.toUpperCase()}${failReason && b.result !== 'pass' ? ` ${failReason}` : ''} · ${run.fw_version || 'not flashed'}${run.station ? ` · ${run.station}` : ''}` }, c);
    }
  });
  const r = await db.one(`SELECT ${RUN_COLS}, r.log_tail FROM factory_runs r LEFT JOIN devices d ON d.id = r.device_id WHERE r.id = $1`, [id]);
  res.json(outRun(r, true));
});

// 9.28
router.get('/factory/runs', requireAny(...LOG_VIEW), async (req, res) => {
  const q = parse(z.object({
    q: z.string().trim().max(40).optional(),
    result: z.enum(['running', 'pass', 'fail', 'aborted']).optional(),
    operatorId: z.uuid().optional(),
    station: z.string().max(40).optional(),
    releaseId: z.coerce.number().int().optional(),
    from: z.iso.datetime({ offset: true }).optional(),
    to: z.iso.datetime({ offset: true }).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.coerce.number().int().optional(),
  }), req.query);
  const where = [];
  const args = [];
  const add = (sql, v) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
  if (q.q) {
    const m = normMac(q.q);
    if (m.length === 12) add('r.mac = ?::macaddr', m);
    else {
      args.push(`%${q.q.replace(/:/g, '')}%`, `%${q.q}%`);
      where.push(`(replace(r.mac::text, ':', '') ILIKE $${args.length - 1} OR d.serial_no ILIKE $${args.length})`);
    }
  }
  if (q.result) add('r.result = ?::factory_result', q.result);
  if (q.operatorId) add('r.operator_id = ?', q.operatorId);
  if (q.station) add('r.station = ?', q.station);
  if (q.releaseId) add('r.release_id = ?', q.releaseId);
  if (q.from) add('r.started_at >= ?', q.from);
  if (q.to) add('r.started_at < ?', q.to);
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = 'FROM factory_runs r LEFT JOIN devices d ON d.id = r.device_id';

  const pageArgs = [...args];
  let pageWhere = filter;
  if (q.cursor) { pageArgs.push(q.cursor); pageWhere += `${filter ? ' AND' : 'WHERE'} r.id < $${pageArgs.length}`; }
  pageArgs.push(q.limit + 1);
  const rows = await db.many(`SELECT ${RUN_COLS} ${from} ${pageWhere} ORDER BY r.id DESC LIMIT $${pageArgs.length}`, pageArgs);
  const more = rows.length > q.limit;
  const items = rows.slice(0, q.limit);

  const sum = await db.one(
    `SELECT count(*) FILTER (WHERE r.result='pass')::int AS pass, count(*) FILTER (WHERE r.result='fail')::int AS fail,
            count(*) FILTER (WHERE r.result='aborted')::int AS aborted, count(*) FILTER (WHERE r.result='running')::int AS running
       ${from} ${filter}`, args);
  const byOp = await db.many(
    `SELECT r.operator_name, count(*) FILTER (WHERE r.result='pass')::int AS pass, count(*) FILTER (WHERE r.result='fail')::int AS fail
       ${from} ${filter} GROUP BY r.operator_name ORDER BY r.operator_name`, args);
  const byReason = await db.many(
    `SELECT r.fail_reason AS reason, count(*)::int AS n ${from} ${filter}${filter ? ' AND' : ' WHERE'} r.result='fail'
      GROUP BY r.fail_reason ORDER BY n DESC`, args);
  res.json({
    items: items.map((r) => outRun(r)),
    summary: { ...sum, byOperator: byOp.map((o) => ({ operatorName: o.operator_name, pass: o.pass, fail: o.fail })),
      byReason },
    nextCursor: more ? items[items.length - 1].id : null,
  });
});

// 9.29
router.get('/factory/runs/:id', requireAny(...LOG_VIEW), async (req, res) => {
  const id = parse(z.coerce.number().int(), req.params.id);
  const r = await db.one(`SELECT ${RUN_COLS}, r.log_tail FROM factory_runs r LEFT JOIN devices d ON d.id = r.device_id WHERE r.id = $1`, [id]);
  if (!r) throw E.notFound('No such run');
  res.json(outRun(r, true));
});

// Operators list for the Factory log filter (small helper, read-only).
router.get('/factory/operators', requireAny(...LOG_VIEW), async (req, res) => {
  const rows = await db.many(
    `SELECT DISTINCT operator_id AS id, operator_name AS name FROM factory_runs WHERE operator_id IS NOT NULL ORDER BY operator_name`);
  res.json({ items: rows });
});

module.exports = router;
