// docs/API.md §9.9 Firmware download for OTA: GET /fw/<releaseId>.bin?t=<token>
// Outside /api/v1 (the gateway proxies /fw/ here). The token comes from the
// MQTT ota message and works for 10 minutes. Headers for the ESP32 updater:
// Content-Length, x-MD5 (hex), Cache-Control: no-store.
const crypto = require('crypto');
const fs = require('fs');
const express = require('express');
const db = require('../db');
const log = require('../logger');
const { verifyDownload } = require('../services/ota');

const router = express.Router();
const md5Cache = new Map(); // releaseId -> md5 hex (files never change once uploaded)

function md5Of(id, filePath) {
  if (!md5Cache.has(id)) md5Cache.set(id, crypto.createHash('md5').update(fs.readFileSync(filePath)).digest('hex'));
  return md5Cache.get(id);
}

router.get('/:file', async (req, res) => {
  const m = /^(\d+)\.bin$/.exec(req.params.file);
  const id = m ? Number(m[1]) : null;
  const token = typeof req.query.t === 'string' ? req.query.t : '';
  if (!id || !verifyDownload(token, id)) return res.status(403).type('text').send('invalid or expired link');
  const r = await db.one('SELECT file_path, file_size FROM firmware_releases WHERE id = $1', [id]);
  if (!r || !fs.existsSync(r.file_path)) return res.status(404).type('text').send('not found');
  res.set({
    'Content-Type': 'application/octet-stream',
    'Content-Length': String(r.file_size),
    'x-MD5': md5Of(id, r.file_path),
    'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="argus_${id}.bin"`,
  });
  fs.createReadStream(r.file_path).on('error', (err) => {
    log.error({ err, id }, 'firmware stream failed');
    res.destroy(err);
  }).pipe(res);
});

module.exports = router;
