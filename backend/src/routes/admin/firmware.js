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
const { checkFactoryImage, guessFlashSize, FLASH_SIZES } = require('../../lib/espimage');
const { E, ApiError } = require('../../errors');

const router = express.Router();

// Kept in memory, then written to OTA_DIR. Two files at most: the OTA .bin ("file", max 4 MB) and,
// for the manufacturing station, the factory image ("factoryFile", Arduino's *.ino.merged.bin, max 16 MB).
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.factoryMaxBytes, files: 2, fields: 10, fieldSize: 2000, parts: 14 },
});
function receive(req, res, fields) {
  return new Promise((resolve, reject) => {
    upload.fields(fields.map((name) => ({ name, maxCount: 1 })))(req, res, (err) => {
      if (!err) {
        const f = req.files || {};
        req.file = f.file?.[0];
        req.factoryFile = f.factoryFile?.[0];
        if (req.file && req.file.size > config.otaMaxBytes) {
          return reject(new ApiError(413, 'FILE_TOO_LARGE', `Firmware must be at most ${config.otaMaxBytes / 1048576} MB`, 'file'));
        }
        return resolve();
      }
      if (err.code === 'LIMIT_FILE_SIZE') {
        return reject(new ApiError(413, 'FILE_TOO_LARGE', `A file is bigger than ${config.factoryMaxBytes / 1048576} MB`, err.field || 'file'));
      }
      reject(E.bad('VALIDATION', err.message, err.field || 'file'));
    });
  });
}

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function writeAtomic(filePath, buf) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.part-${process.pid}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, filePath);   // atomic: a download never sees half a file
}
const factoryPath = (version) => path.join(config.otaDir, 'factory', `argus_${version}_merged.bin`);

// Check a factory image against the release's OTA .bin (docs/MANUFACTURING.md §3).
function checkFactory(chip, merged, otaBin, flashSizeIn) {
  const flashSize = flashSizeIn || guessFlashSize(merged.length);
  if (!FLASH_SIZES[flashSize]) throw E.bad('VALIDATION', 'Flash size must be 2MB, 4MB, 8MB or 16MB', 'flashSize');
  const bad = checkFactoryImage(chip, merged, otaBin, flashSize);
  if (bad) throw E.invalid(bad.code, bad.message, 'factoryFile');
  return flashSize;
}

const releaseView = (r) => ({
  id: r.id, version: r.version, channel: r.channel, chipModel: r.chip_model, fileSize: r.file_size, sha256: r.sha256,
  notes: r.notes, uploadedBy: r.uploaded_by_name ?? null, createdAt: r.created_at, deviceCount: r.device_count ?? 0,
  // The image the manufacturing station writes at 0x0 (null = none uploaded yet)
  factory: r.factory_file_path ? {
    fileSize: r.factory_file_size, sha256: r.factory_sha256, flashSize: r.factory_flash_size,
    isDefault: r.factory_default, sameAsOta: r.factory_file_path === r.file_path,
  } : null,
});

// 9.1 Releases, newest first, with how many devices run each one.
router.get('/firmware', requireStaff('firmware.view'), async (req, res) => {
  const rows = await db.many(
    `SELECT f.*, u.full_name AS uploaded_by_name,
            (SELECT count(*)::int FROM device_state s WHERE s.fw_version = f.version) AS device_count
       FROM firmware_releases f LEFT JOIN users u ON u.id = f.uploaded_by ORDER BY f.created_at DESC, f.id DESC`);
  res.json({ items: rows.map(releaseView) });
});

// 9.2 Upload a build (multipart: file, version, channel, notes, chipModel?, factoryFile?, flashSize?).
// factoryFile = Arduino's *.ino.merged.bin for the manufacturing station. ESP8266 needs none: its .bin
// already holds the bootloader, so the same file is used as the factory image.
router.post('/firmware', requireStaff('firmware.upload'), async (req, res) => {
  await receive(req, res, ['file', 'factoryFile']);
  const body = parse(z.object({
    version: z.string().trim().regex(/^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/, 'Version like 1.4.3 or 1.4.3-beta'),
    channel: z.enum(['beta', 'stable']).default('beta'),
    notes: z.string().trim().max(500).optional(),
    chipModel: z.string().trim().min(2).max(40).optional(),
    flashSize: z.enum(Object.keys(FLASH_SIZES)).optional(),
  }), req.body);
  const chip = body.chipModel || 'ESP32-S3';
  const file = req.file;
  if (!file || !file.size) throw E.bad('VALIDATION', 'Attach the firmware .bin as "file"', 'file');
  if (file.buffer[0] !== 0xE9) throw E.invalid('NOT_ESP_IMAGE', 'This is not an ESP32 firmware image (first byte must be 0xE9)', 'file');
  const sha256 = sha(file.buffer);
  const merged = req.factoryFile;
  if (merged && chip === 'ESP8266') throw E.bad('VALIDATION', 'ESP8266 needs only the one .bin', 'factoryFile');
  const flashSize = merged ? checkFactory(chip, merged.buffer, file.buffer, body.flashSize) : null;

  if (await db.one('SELECT 1 AS x FROM firmware_releases WHERE version = $1', [body.version])) {
    throw E.conflict('VERSION_EXISTS', `Version ${body.version} already exists`, 'version');
  }
  const filePath = path.join(config.otaDir, `argus_${body.version}.bin`);
  writeAtomic(filePath, file.buffer);
  // ESP8266: the OTA .bin IS the factory image (bootloader included), written at 0x0.
  const fac = merged ? { path: factoryPath(body.version), size: merged.size, sha256: sha(merged.buffer), flashSize }
    : chip === 'ESP8266' ? { path: filePath, size: file.size, sha256, flashSize: body.flashSize || '4MB' } : null;
  if (merged) writeAtomic(fac.path, merged.buffer);

  let row;
  try {
    row = await db.tx(async (c) => {
      const { rows: [r] } = await c.query(
        `INSERT INTO firmware_releases (version, channel, chip_model, file_path, file_size, sha256, notes, uploaded_by,
                                        factory_file_path, factory_file_size, factory_sha256, factory_flash_size)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING *`,
        [body.version, body.channel, chip, filePath, file.size, sha256, body.notes || null, req.user.id,
          fac?.path || null, fac?.size || null, fac?.sha256 || null, fac?.flashSize || null]);
      await audit(req, { action: 'firmware.upload', targetType: 'firmware', targetId: r.id, targetLabel: body.version,
        detail: `${(file.size / 1048576).toFixed(2)} MB · sha256 ${sha256.slice(0, 4)}…${sha256.slice(-4)}`
          + (merged ? ` · factory image ${fac.flashSize}` : '') }, c);
      return r;
    });
  } catch (err) {
    fs.rmSync(filePath, { force: true });
    if (merged) fs.rmSync(fac.path, { force: true });
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

// 9.3 Change channel / notes, or make this the factory default for its chip
router.patch('/firmware/:id', requireStaff('firmware.upload'), async (req, res) => {
  const body = parse(z.object({
    channel: z.enum(['beta', 'stable']).optional(),
    notes: z.string().trim().max(500).nullable().optional(),
    factoryDefault: z.literal(true).optional(),
  }).strict(), req.body);
  const id = idParam(req.params.id);
  const r = await db.tx(async (c) => {
    const { rows: [cur] } = await c.query('SELECT * FROM firmware_releases WHERE id = $1 FOR UPDATE', [id]);
    if (!cur) throw E.notFound('Release not found');
    if (body.factoryDefault) {
      if (!cur.factory_file_path) throw E.invalid('NO_FACTORY_IMAGE', 'Add a factory image to this release first', 'factoryDefault');
      // One default per chip: clear the old one first (the unique index checks each row at once).
      await c.query('UPDATE firmware_releases SET factory_default = false WHERE chip_model = $1 AND factory_default', [cur.chip_model]);
    }
    const { rows: [u] } = await c.query(
      `UPDATE firmware_releases SET channel = COALESCE($2, channel), notes = CASE WHEN $4 THEN $3 ELSE notes END,
              factory_default = factory_default OR $5
        WHERE id = $1 RETURNING *`, [id, body.channel || null, body.notes ?? null, body.notes !== undefined, !!body.factoryDefault]);
    await audit(req, { action: body.factoryDefault ? 'firmware.factory_default' : 'firmware.update', targetType: 'firmware',
      targetId: id, targetLabel: u.version, data: body }, c);
    return u;
  });
  res.json(releaseView(r));
});

// 9.22 Add or replace the factory image of a release (multipart: factoryFile, flashSize?)
router.put('/firmware/:id/factory-image', requireStaff('firmware.upload'), async (req, res) => {
  await receive(req, res, ['factoryFile']);
  const body = parse(z.object({ flashSize: z.enum(Object.keys(FLASH_SIZES)).optional() }), req.body);
  const id = idParam(req.params.id);
  const cur = await db.one('SELECT * FROM firmware_releases WHERE id = $1', [id]);
  if (!cur) throw E.notFound('Release not found');
  if (cur.chip_model === 'ESP8266') throw E.invalid('NOT_NEEDED', 'ESP8266 uses its .bin as the factory image already', 'factoryFile');
  const merged = req.factoryFile;
  if (!merged || !merged.size) throw E.bad('VALIDATION', 'Attach the merged .bin as "factoryFile"', 'factoryFile');
  const flashSize = checkFactory(cur.chip_model, merged.buffer, fs.readFileSync(cur.file_path), body.flashSize);
  const fp = factoryPath(cur.version);
  writeAtomic(fp, merged.buffer);
  const r = await db.tx(async (c) => {
    const { rows: [u] } = await c.query(
      `UPDATE firmware_releases SET factory_file_path = $2, factory_file_size = $3, factory_sha256 = $4, factory_flash_size = $5
        WHERE id = $1 RETURNING *`, [id, fp, merged.size, sha(merged.buffer), flashSize]);
    await audit(req, { action: 'firmware.factory_image', targetType: 'firmware', targetId: id, targetLabel: u.version,
      detail: `${(merged.size / 1048576).toFixed(2)} MB · ${flashSize}` }, c);
    return u;
  });
  res.json(releaseView(r));
});

// 9.23 Remove the factory image (the OTA .bin stays)
router.delete('/firmware/:id/factory-image', requireStaff('firmware.upload'), async (req, res) => {
  const id = idParam(req.params.id);
  const cur = await db.one('SELECT * FROM firmware_releases WHERE id = $1', [id]);
  if (!cur || !cur.factory_file_path) throw E.notFound('No factory image on this release');
  if (cur.factory_file_path === cur.file_path) throw E.invalid('NOT_NEEDED', 'On ESP8266 the factory image is the OTA .bin itself');
  await db.tx(async (c) => {
    await c.query(`UPDATE firmware_releases SET factory_file_path = NULL, factory_file_size = NULL, factory_sha256 = NULL,
                          factory_flash_size = NULL, factory_default = false WHERE id = $1`, [id]);
    await audit(req, { action: 'firmware.factory_image.delete', targetType: 'firmware', targetId: id, targetLabel: cur.version }, c);
  });
  fs.rmSync(cur.factory_file_path, { force: true });
  res.status(204).end();
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
  if (r.factory_file_path) fs.rmSync(r.factory_file_path, { force: true });
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
