// OTA (step 9 part 1, moved up for the demo): firmware upload, signed
// download, rollouts with a fake device (docs/API.md §9.1–9.9, §11 ota).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { BASE, ORIGIN, db, registered, staff, insertDevice, mqttConnect, sleep, socketConnect, nextEvent, ask } = require('./helpers');

const open = [];
after(async () => {
  for (const c of open) { try { c.close ? c.close() : c.end(true); } catch { /* closed */ } }
  await db.end();
});

const uniq = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
// A fake ESP32 image: magic byte 0xE9 + random bytes.
const fakeBin = (n = 4096) => Buffer.concat([Buffer.from([0xE9]), crypto.randomBytes(n - 1)]);

async function uploadFw(client, { version = `9.${uniq()}`, bin = fakeBin(), channel = 'beta' } = {}) {
  const form = new FormData();
  form.append('version', version);
  form.append('channel', channel);
  form.append('notes', 'test build');
  form.append('file', new Blob([bin]), 'argus.bin');
  const res = await fetch(`${BASE}/api/v1/admin/firmware`, {
    method: 'POST', body: form, headers: { origin: ORIGIN, cookie: client.cookieHeader('/api/v1/admin') } });
  return { status: res.status, body: await res.json(), bin, version };
}

async function until(fn, ms = 4000) {
  for (let t = 0; t < ms; t += 50) {
    const v = await fn();
    if (v) return v;
    await sleep(50);
  }
  return fn();
}

// A fake sensor: subscribes to ota, announces online + its firmware version.
async function sensor(mac, fw) {
  const c = await mqttConnect(mac, { will: true });
  open.push(c);
  const ota = [];
  c.on('message', (t, p) => { if (t.endsWith('/ota')) ota.push(JSON.parse(p.toString())); });
  await c.subscribeAsync(`argus/${mac}/ota`, { qos: 1 });
  await c.publishAsync(`argus/${mac}/status`, 'online', { qos: 1, retain: true });
  await c.publishAsync(`argus/${mac}/info`, JSON.stringify({ fw }), { qos: 1 });
  const pub = (s, b) => c.publishAsync(`argus/${mac}/${s}`, JSON.stringify(b), { qos: 1 });
  return { c, ota, pub };
}

async function admin() {
  const a = await staff('Owner');
  const sock = await socketConnect(a.c);
  open.push(sock);
  await ask(sock, 'admin:subscribe', { topics: ['rollouts'] });
  return { ...a, sock };
}

const startRollout = (c, body) => c.post('/admin/ota/rollouts', body);

test('upload: ESP image check, sha256, size limit, duplicate, permissions', async () => {
  const { c } = await staff('Developer');
  const up = await uploadFw(c);
  assert.equal(up.status, 201);
  assert.equal(up.body.sha256, crypto.createHash('sha256').update(up.bin).digest('hex'));
  assert.deepEqual([up.body.fileSize, up.body.channel, up.body.uploadedBy], [4096, 'beta', 'Test User']);

  const notEsp = await uploadFw(c, { bin: Buffer.alloc(100, 0) });
  assert.deepEqual([notEsp.status, notEsp.body.error.code], [422, 'NOT_ESP_IMAGE']);
  const dup = await uploadFw(c, { version: up.version });
  assert.deepEqual([dup.status, dup.body.error.code], [409, 'VERSION_EXISTS']);
  const big = await uploadFw(c, { bin: Buffer.concat([Buffer.from([0xE9]), Buffer.alloc(4 * 1024 * 1024)]) });
  assert.deepEqual([big.status, big.body.error.code], [413, 'FILE_TOO_LARGE']);

  const list = await c.get('/admin/firmware');
  assert.ok(list.body.items.some((r) => r.version === up.version));
  const support = await staff('Support');   // no firmware.* permissions
  assert.equal((await support.c.get('/admin/firmware')).status, 403);
  assert.equal((await uploadFw(support.c)).status, 403);
});

test('rollout to an online device: ota message, signed download, progress to success', async () => {
  const a = await admin();
  const up = await uploadFw(a.c);
  const d = await insertDevice();
  const s = await sensor(d.mac, '1.0.0');
  await sleep(300);

  const progress = [];
  a.sock.on('rollout:progress', (p) => progress.push(p));
  const r = await startRollout(a.c, { releaseId: up.body.id, target: 'serials', serials: [d.serial] });
  assert.deepEqual([r.status, r.body.devices], [201, 1]);
  const msg = await until(() => s.ota[0]);
  assert.deepEqual([msg.rid, msg.ver, msg.sha256, msg.size], [r.body.rolloutId, up.version, up.body.sha256, 4096]);

  // the device downloads its firmware with the signed link
  const dl = await fetch(msg.url);
  assert.equal(dl.status, 200);
  const bytes = Buffer.from(await dl.arrayBuffer());
  assert.ok(bytes.equals(up.bin));
  assert.equal(dl.headers.get('content-length'), '4096');
  assert.equal(dl.headers.get('x-md5'), crypto.createHash('md5').update(up.bin).digest('hex'));
  assert.equal(dl.headers.get('cache-control'), 'no-store');
  const u = new URL(msg.url);
  assert.equal((await fetch(`${BASE}${u.pathname}?t=wrong`)).status, 403);
  assert.equal((await fetch(`${BASE}/fw/${up.body.id + 1000}.bin${u.search}`)).status, 403, 'token is for one release only');

  await s.pub('ota/status', { rid: msg.rid, s: 'downloading' });
  await nextEvent(a.sock, 'rollout:progress', (p) => p.rolloutId === msg.rid && p.deviceStatus === 'downloading');
  // after rebooting, the device reports the new version: that counts as success
  const finished = nextEvent(a.sock, 'rollout:progress', (p) => p.rolloutId === msg.rid && p.status === 'finished');
  await s.pub('info', { fw: up.version });
  const fin = await finished;
  assert.deepEqual(fin.counts, { done: 1, downloading: 0, waiting: 0, failed: 0, skipped: 0 });
  const det = await a.c.get(`/admin/ota/rollouts/${msg.rid}`);
  assert.deepEqual([det.body.status, det.body.devices[0].status, det.body.devices[0].fromVersion], ['finished', 'success', '1.0.0']);
  const ev = await db.query("SELECT type FROM device_events WHERE device_id = $1 AND type::text LIKE 'ota_%' ORDER BY id", [d.id]);
  assert.deepEqual(ev.rows.map((x) => x.type), ['ota_started', 'ota_success']);
});

test('failed update, then retry re-sends it', async () => {
  const a = await admin();
  const up = await uploadFw(a.c);
  const d = await insertDevice();
  const s = await sensor(d.mac, '1.0.0');
  await sleep(300);
  const r = await startRollout(a.c, { releaseId: up.body.id, target: 'serials', serials: [d.serial] });
  await until(() => s.ota[0]);
  await s.pub('ota/status', { rid: r.body.rolloutId, s: 'failed', err: 'sha256 mismatch' });
  const row = await until(async () => (await a.c.get(`/admin/ota/rollouts/${r.body.rolloutId}`)).body.devices.find((x) => x.status === 'failed'));
  assert.equal(row.error, 'sha256 mismatch');
  assert.equal((await a.c.get(`/admin/ota/rollouts/${r.body.rolloutId}`)).body.status, 'finished');
  assert.equal((await a.c.post(`/admin/ota/rollouts/${r.body.rolloutId}/retry`)).status, 204);
  await until(() => s.ota.length >= 2);
  assert.equal(s.ota.length, 2, 'sent again');
  assert.equal((await a.c.get(`/admin/ota/rollouts/${r.body.rolloutId}`)).body.status, 'running');
});

test('offline device: pause holds it back, resume sends it on; cancel skips the rest', async () => {
  const a = await admin();
  const up = await uploadFw(a.c);
  const d = await insertDevice();
  const r = await startRollout(a.c, { releaseId: up.body.id, target: 'serials', serials: [d.serial] });
  const rid = r.body.rolloutId;
  assert.deepEqual((await a.c.get(`/admin/ota/rollouts/${rid}`)).body.counts.waiting, 1);
  assert.equal((await a.c.post(`/admin/ota/rollouts/${rid}/pause`)).status, 204);
  assert.equal((await a.c.post(`/admin/ota/rollouts/${rid}/pause`)).body.error.code, 'ROLLOUT_STATE');
  const s = await sensor(d.mac, '1.0.0');
  await sleep(700);
  assert.equal(s.ota.length, 0, 'paused: nothing sent when the device came online');
  assert.equal((await a.c.post(`/admin/ota/rollouts/${rid}/resume`)).status, 204);
  await until(() => s.ota.length);
  assert.equal(s.ota[0].rid, rid);

  const d2 = await insertDevice();
  const r2 = await startRollout(a.c, { releaseId: up.body.id, target: 'serials', serials: [d2.serial] });
  assert.equal((await a.c.post(`/admin/ota/rollouts/${r2.body.rolloutId}/cancel`)).status, 204);
  const det = (await a.c.get(`/admin/ota/rollouts/${r2.body.rolloutId}`)).body;
  assert.deepEqual([det.status, det.devices[0].status], ['cancelled', 'skipped']);
});

test('install window: no update outside it (device local time)', async () => {
  const a = await admin();
  const up = await uploadFw(a.c);
  const d = await insertDevice();
  // a window that is 2–3 hours from now in Asia/Kolkata (the device's zone)
  const ist = new Date(Date.now() + 5.5 * 3600_000);
  const hh = (h) => String((ist.getUTCHours() + h) % 24).padStart(2, '0');
  const r = await startRollout(a.c, { releaseId: up.body.id, target: 'serials', serials: [d.serial],
    installWindow: { from: `${hh(2)}:00`, to: `${hh(3)}:00` } });
  const s = await sensor(d.mac, '1.0.0');
  await sleep(700);
  assert.equal(s.ota.length, 0);
  assert.deepEqual((await a.c.get(`/admin/ota/rollouts/${r.body.rolloutId}`)).body.installWindow, { from: `${hh(2)}:00`, to: `${hh(3)}:00` });
});

test('targets: from_version, auto-update off, already up to date, unknown serial', async () => {
  const a = await admin();
  const up = await uploadFw(a.c);
  const oldVer = `0.${uniq()}`;
  const [d1, d2, d3] = [await insertDevice(), await insertDevice(), await insertDevice()];
  for (const d of [d1, d2]) {
    await db.query(`INSERT INTO device_state (device_id, fw_version) VALUES ($1, $2)`, [d.id, oldVer]);
  }
  await db.query(`INSERT INTO device_state (device_id, fw_version) VALUES ($1, $2)`, [d3.id, up.version]);
  await db.query('UPDATE devices SET auto_update = false WHERE id = $1', [d2.id]);

  const r = await startRollout(a.c, { releaseId: up.body.id, target: 'from_version', fromVersion: oldVer });
  assert.equal(r.body.devices, 1, 'd2 has auto-update off');
  const bySerial = await startRollout(a.c, { releaseId: up.body.id, target: 'serials', serials: [d2.serial, d3.serial] });
  assert.equal(bySerial.body.devices, 1, 'listed by serial = included; d3 already runs it');
  const bad = await startRollout(a.c, { releaseId: up.body.id, target: 'serials', serials: ['ARG-NOPE001'] });
  assert.deepEqual([bad.status, bad.body.error.code], [422, 'UNKNOWN_SERIAL']);
  assert.equal((await startRollout(a.c, { releaseId: up.body.id, target: 'percent' })).body.error.field, 'percent');
  const mfg = await staff('Manufacturing');   // firmware.view only
  assert.equal((await startRollout(mfg.c, { releaseId: up.body.id, target: 'serials', serials: [d1.serial] })).status, 403);
  assert.equal((await a.c.del(`/admin/firmware/${up.body.id}`)).body.error.code, 'RELEASE_IN_USE');
});

test('a release nobody used can be deleted', async () => {
  const { c } = await staff('Owner');
  const up = await uploadFw(c);
  assert.equal((await c.del(`/admin/firmware/${up.body.id}`)).status, 204);
  assert.ok(!(await c.get('/admin/firmware')).body.items.some((r) => r.id === up.body.id));
});
