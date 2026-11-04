// docs/API.md §9.1–9.8 Firmware releases and OTA rollouts (admin).
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const config = require('../../config');
const db = require('../../db');
const { parse, z } = require('../../lib/validate');
const { audit } = require('../../lib/audit');
const { requireStaff } = require('../../middleware/auth');
const ota = require('../../services/ota');
const { E, ApiError } = require('../../errors');

const router = express.Router();

// One .bin per request, kept in memory (max 4 MB), then written to OTA_DIR.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.otaMaxBytes, files: 1, fields: 10, fieldSize: 2000, parts: 12 },
});
function receive(req, res) {
  return new Promise((resolve, reject) => {
    upload.single('file')(req, res, (err) => {
      if (!err) return resolve();
      if (err.code === 'LIMIT_FILE_SIZE') {
        return reject(new ApiError(413, 'FILE_TOO_LARGE', `Firmware must be at most ${config.otaMaxBytes / 1048576} MB`, 'file'));
      }
      reject(E.bad('VALIDATION', err.message, err.field || 'file'));
    });
  });
}

const releaseView = (r) => ({
  id: r.id, version: r.version, channel: r.channel, chipModel: r.chip_model, fileSize: r.file_size, sha256: r.sha256,
  notes: r.notes, uploadedBy: r.uploaded_by_name ?? null, createdAt: r.created_at, deviceCount: r.device_count ?? 0,
});

// 9.1 Releases, newest first, with how many devices run each one.
router.get('/firmware', requireStaff('firmware.view'), async (req, res) => {
  const rows = await db.many(
    `SELECT f.*, u.full_name AS uploaded_by_name,
            (SELECT count(*)::int FROM device_state s WHERE s.fw_version = f.version) AS device_count
       FROM firmware_releases f LEFT JOIN users u ON u.id = f.uploaded_by ORDER BY f.created_at DESC, f.id DESC`);
  res.json({ items: rows.map(releaseView) });
});

// 9.2 Upload a build (multipart: file, version, channel, notes, chipModel?).
router.post('/firmware', requireStaff('firmware.upload'), async (req, res) => {
  await receive(req, res);
  const body = parse(z.object({
    version: z.string().trim().regex(/^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/, 'Version like 1.4.3 or 1.4.3-beta'),
    channel: z.enum(['beta', 'stable']).default('beta'),
    notes: z.string().trim().max(500).optional(),
    chipModel: z.string().trim().min(2).max(40).optional(),
  }), req.body);
  const file = req.file;
  if (!file || !file.size) throw E.bad('VALIDATION', 'Attach the firmware .bin as "file"', 'file');
  if (file.buffer[0] !== 0xE9) throw E.invalid('NOT_ESP_IMAGE', 'This is not an ESP32 firmware image (first byte must be 0xE9)', 'file');
  const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');

  if (await db.one('SELECT 1 AS x FROM firmware_releases WHERE version = $1', [body.version])) {
    throw E.conflict('VERSION_EXISTS', `Version ${body.version} already exists`, 'version');
  }
  fs.mkdirSync(config.otaDir, { recursive: true });
  const filePath = path.join(config.otaDir, `argus_${body.version}.bin`);
  const tmp = `${filePath}.part-${process.pid}`;
  fs.writeFileSync(tmp, file.buffer);
  fs.renameSync(tmp, filePath);   // atomic: a download never sees half a file

  let row;
  try {
    row = await db.tx(async (c) => {
      const { rows: [r] } = await c.query(
        `INSERT INTO firmware_releases (version, channel, chip_model, file_path, file_size, sha256, notes, uploaded_by)
         VALUES ($1, $2, COALESCE($3, 'ESP32-S3'), $4, $5, $6, $7, $8) RETURNING *`,
        [body.version, body.channel, body.chipModel || null, filePath, file.size, sha256, body.notes || null, req.user.id]);
      await audit(req, { action: 'firmware.upload', targetType: 'firmware', targetId: r.id, targetLabel: body.version,
        detail: `${(file.size / 1048576).toFixed(2)} MB · sha256 ${sha256.slice(0, 4)}…${sha256.slice(-4)}` }, c);
      return r;
    });
  } catch (err) {
    fs.rmSync(filePath, { force: true });
    if (err.code === '23505') throw E.conflict('VERSION_EXISTS', `Version ${body.version} already exists`, 'version');
    throw err;
  }
  res.status(201).json(releaseView({ ...row, uploaded_by_name: req.user.full_name }));
});

const idParam = (v) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw E.notFound('Not found');
  return n;
};

// 9.3 Change channel / notes
router.patch('/firmware/:id', requireStaff('firmware.upload'), async (req, res) => {
  const body = parse(z.object({ channel: z.enum(['beta', 'stable']).optional(), notes: z.string().trim().max(500).nullable().optional() }).strict(), req.body);
  const id = idParam(req.params.id);
  const r = await db.one(
    `UPDATE firmware_releases SET channel = COALESCE($2, channel), notes = CASE WHEN $4 THEN $3 ELSE notes END
      WHERE id = $1 RETURNING *`, [id, body.channel || null, body.notes ?? null, body.notes !== undefined]);
  if (!r) throw E.notFound('Release not found');
  await audit(req, { action: 'firmware.update', targetType: 'firmware', targetId: id, targetLabel: r.version, data: body });
  res.json(releaseView(r));
});

// 9.4 Delete (not while a rollout uses it)
router.delete('/firmware/:id', requireStaff('firmware.upload'), async (req, res) => {
  const id = idParam(req.params.id);
  const r = await db.one('SELECT * FROM firmware_releases WHERE id = $1', [id]);
  if (!r) throw E.notFound('Release not found');
  if (await db.one('SELECT 1 AS x FROM ota_rollouts WHERE release_id = $1 LIMIT 1', [id])) {
    throw E.conflict('RELEASE_IN_USE', 'A rollout uses this release; it cannot be deleted');
  }
  await db.tx(async (c) => {
    await c.query('DELETE FROM firmware_releases WHERE id = $1', [id]);
    await audit(req, { action: 'firmware.delete', targetType: 'firmware', targetId: id, targetLabel: r.version }, c);
  });
  fs.rmSync(r.file_path, { force: true });
  res.status(204).end();
});

// ---- rollouts ------------------------------------------------------------
const hhmm = z.string().regex(/^([01][0-9]|2[0-3]):[0-5][0-9]$/, 'Time must be HH:mm');

// 9.5 Start a rollout
router.post('/ota/rollouts', requireStaff('firmware.rollout'), async (req, res) => {
  const body = parse(z.object({
    releaseId: z.number().int().positive(),
    target: z.enum(['all', 'percent', 'serials', 'from_version']),
    percent: z.number().int().min(1).max(100).optional(),
    serials: z.array(z.string().trim().toUpperCase().max(20)).min(1).max(1000).optional(),
    fromVersion: z.string().trim().max(40).optional(),
    installWindow: z.object({ from: hhmm, to: hhmm }).nullable().optional(),
    notes: z.string().trim().max(500).optional(),
  }), req.body);
  if (body.target === 'percent' && !body.percent) throw E.bad('VALIDATION', 'Give a percentage', 'percent');
  if (body.target === 'serials' && !body.serials) throw E.bad('VALIDATION', 'Give the serial numbers', 'serials');
  if (body.target === 'from_version' && !body.fromVersion) throw E.bad('VALIDATION', 'Give the version to update from', 'fromVersion');
  if (body.installWindow && body.installWindow.from === body.installWindow.to) {
    throw E.bad('VALIDATION', 'The install window needs two different times', 'installWindow');
  }
  const release = await db.one('SELECT id, version FROM firmware_releases WHERE id = $1', [body.releaseId]);
  if (!release) throw E.notFound('Release not found');
  if (body.target === 'serials') {
    const { rows } = await db.query('SELECT serial_no FROM devices WHERE serial_no = ANY($1::text[])', [body.serials]);
    const known = new Set(rows.map((r) => r.serial_no));
    const unknown = body.serials.filter((s) => !known.has(s));
    if (unknown.length) throw E.invalid('UNKNOWN_SERIAL', `Unknown serial(s): ${unknown.slice(0, 5).join(', ')}`, 'serials');
  }
  const result = await db.tx(async (c) => {
    const r = await ota.create(c, {
      release, target: body.target, percent: body.percent, serials: body.serials, fromVersion: body.fromVersion,
      windowFrom: body.installWindow?.from || null, windowTo: body.installWindow?.to || null, notes: body.notes, userId: req.user.id,
    });
    const what = body.target === 'percent' ? `${body.percent}% (${r.devices} devices)`
      : body.target === 'from_version' ? `devices on ${body.fromVersion} (${r.devices})` : `${body.target} (${r.devices} devices)`;
    await audit(req, { action: 'ota.rollout.start', targetType: 'rollout', targetId: r.rolloutId, targetLabel: release.version, detail: what }, c);
    return r;
  });
  ota.dispatch().catch(() => {});
  res.status(201).json(result);
});

const rolloutCols = `r.id, r.target, r.target_percent, r.target_from_version, r.window_from, r.window_to, r.status,
  r.notes, r.created_at, r.finished_at, f.version, f.id AS release_id, u.full_name AS created_by_name`;
const rolloutFrom = `FROM ota_rollouts r JOIN firmware_releases f ON f.id = r.release_id LEFT JOIN users u ON u.id = r.created_by`;
async function rolloutView(r) {
  return {
    id: r.id, releaseId: r.release_id, version: r.version, target: r.target, percent: r.target_percent,
    fromVersion: r.target_from_version,
    installWindow: r.window_from ? { from: r.window_from.slice(0, 5), to: r.window_to.slice(0, 5) } : null,
    createdBy: r.created_by_name, createdAt: r.created_at, finishedAt: r.finished_at, status: r.status, notes: r.notes,
    counts: await ota.counts(r.id),
  };
}

// 9.6 List
router.get('/ota/rollouts', requireStaff('firmware.view'), async (req, res) => {
  const rows = await db.many(`SELECT ${rolloutCols} ${rolloutFrom} ORDER BY r.id DESC LIMIT 100`);
  res.json({ items: await Promise.all(rows.map(rolloutView)) });
});

// 9.7 Detail with every device
router.get('/ota/rollouts/:id', requireStaff('firmware.view'), async (req, res) => {
  const id = idParam(req.params.id);
  const r = await db.one(`SELECT ${rolloutCols} ${rolloutFrom} WHERE r.id = $1`, [id]);
  if (!r) throw E.notFound('Rollout not found');
  const devices = await db.many(
    `SELECT rd.device_id, d.serial_no, rd.status, rd.from_version, rd.error, rd.updated_at
       FROM ota_rollout_devices rd JOIN devices d ON d.id = rd.device_id WHERE rd.rollout_id = $1 ORDER BY d.serial_no`, [id]);
  res.json({
    ...(await rolloutView(r)),
    devices: devices.map((x) => ({ deviceId: x.device_id, serial: x.serial_no, status: x.status, fromVersion: x.from_version,
      error: x.error, updatedAt: x.updated_at })),
  });
});

// 9.8 Pause / resume / cancel / retry failed
for (const action of ['pause', 'resume', 'cancel', 'retry']) {
  router.post(`/ota/rollouts/:id/${action}`, requireStaff('firmware.rollout'), async (req, res) => {
    const id = idParam(req.params.id);
    const r = await ota.control(id, action);
    if (!r) throw E.notFound('Rollout not found');
    if (r.error) throw E.conflict('ROLLOUT_STATE', r.error);
    await audit(req, { action: `ota.rollout.${action}`, targetType: 'rollout', targetId: id, detail: `now ${r.status}` });
    res.status(204).end();
  });
}

module.exports = router;
