// Manufacturing station (docs/API.md §9b, docs/MANUFACTURING.md): factory image upload and checks,
// factory default, bench runs (flash + checks + result), the factory log, and register-after-pass.
// Runs against the dev stack like the other tests: docker compose up -d, then npm test.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { BASE, ORIGIN, db, staff, randomMac } = require('./helpers');

after(() => db.end());

const uniq = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const MB = 1024 * 1024;
const appBin = (n = 64 * 1024) => Buffer.concat([Buffer.from([0xE9]), crypto.randomBytes(n - 1)]);
// A full-flash image like Arduino's *.ino.merged.bin: bootloader at 0x1000 (ESP32) or 0x0 (S3/C3),
// the app at 0x10000, padded with 0xFF to the flash size.
function mergedBin(app, { chip = 'ESP32', size = 4 * MB } = {}) {
  const b = Buffer.alloc(size, 0xFF);
  b[chip === 'ESP32' ? 0x1000 : 0] = 0xE9;
  app.copy(b, 0x10000);
  return b;
}

async function send(client, method, path, fields) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Buffer.isBuffer(v)) form.append(k, new Blob([v]), `${k}.bin`);
    else form.append(k, v);
  }
  const res = await fetch(`${BASE}/api/v1${path}`, { method, body: form, headers: { origin: ORIGIN, cookie: client.cookieHeader('/api/v1/admin') } });
  return { status: res.status, body: res.status === 204 ? null : await res.json() };
}
const upload = (c, f) => send(c, 'POST', '/admin/firmware', { channel: 'beta', ...f });

test('upload with factory image: checks the image, ESP8266 reuses its .bin, make default', async () => {
  const { c } = await staff('Owner');
  const app = appBin();

  // The app inside the merged image must be the same build as the OTA .bin
  let r = await upload(c, { version: `7.${uniq()}`, chipModel: 'ESP32', file: app, factoryFile: mergedBin(appBin()) });
  assert.equal(r.status, 422); assert.equal(r.body.error.code, 'IMAGE_MISMATCH');
  // Bootloader at the wrong place for the chip (an S3 image uploaded as ESP32)
  r = await upload(c, { version: `7.${uniq()}`, chipModel: 'ESP32', file: app, factoryFile: mergedBin(app, { chip: 'ESP32-S3' }) });
  assert.equal(r.status, 422); assert.equal(r.body.error.code, 'NOT_FACTORY_IMAGE');

  const v = `7.${uniq()}`;
  r = await upload(c, { version: v, chipModel: 'ESP32', file: app, factoryFile: mergedBin(app) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.deepEqual({ ...r.body.factory, sha256: undefined }, { fileSize: 4 * MB, sha256: undefined, flashSize: '4MB', isDefault: false, sameAsOta: false });
  const id = r.body.id;

  // ESP8266: one file, it is its own factory image
  r = await upload(c, { version: `7.${uniq()}`, chipModel: 'ESP8266', file: app });
  assert.equal(r.status, 201);
  assert.equal(r.body.factory.sameAsOta, true);

  // Make default: only one per chip
  r = await c.patch(`/admin/firmware/${id}`, { factoryDefault: true });
  assert.equal(r.status, 200); assert.equal(r.body.factory.isDefault, true);
  const app2 = appBin();
  const r2 = await upload(c, { version: `7.${uniq()}`, chipModel: 'ESP32', file: app2, factoryFile: mergedBin(app2) });
  await c.patch(`/admin/firmware/${r2.body.id}`, { factoryDefault: true });
  const { rows } = await db.query("SELECT id FROM firmware_releases WHERE chip_model = 'ESP32' AND factory_default");
  assert.deepEqual(rows.map((x) => x.id), [r2.body.id]);

  // Add later / remove
  const app3 = appBin();
  const r3 = await upload(c, { version: `7.${uniq()}`, chipModel: 'ESP32', file: app3 });
  assert.equal(r3.body.factory, null);
  r = await c.patch(`/admin/firmware/${r3.body.id}`, { factoryDefault: true });
  assert.equal(r.body.error.code, 'NO_FACTORY_IMAGE');
  r = await send(c, 'PUT', `/admin/firmware/${r3.body.id}/factory-image`, { factoryFile: mergedBin(app3) });
  assert.equal(r.status, 200); assert.equal(r.body.factory.flashSize, '4MB');
  r = await c.del(`/admin/firmware/${r3.body.id}/factory-image`);
  assert.equal(r.status, 204);

  // Manufacturing can't upload
  const m = await staff('Manufacturing');
  r = await upload(m.c, { version: `7.${uniq()}`, chipModel: 'ESP32', file: app });
  assert.equal(r.status, 403);
});

test('station: download image, bench run, pass, register, factory log', async () => {
  const owner = await staff('Owner');
  const app = appBin();
  const v = `7.${uniq()}`;
  const up = await upload(owner.c, { version: v, chipModel: 'ESP32', file: app, factoryFile: mergedBin(app) });
  const relId = up.body.id;
  const { c, user } = await staff('Manufacturing');

  let r = await c.get('/admin/factory/releases?chip=ESP32');
  assert.equal(r.status, 200);
  assert.ok(r.body.items.some((x) => x.id === relId));

  const img = await fetch(`${BASE}/api/v1/admin/factory/releases/${relId}/image`, { headers: { cookie: c.cookieHeader('/api/v1/admin') } });
  assert.equal(img.status, 200);
  const buf = Buffer.from(await img.arrayBuffer());
  assert.equal(buf.length, 4 * MB);
  assert.equal(crypto.createHash('sha256').update(buf).digest('hex'), img.headers.get('x-sha256'));

  const mac = randomMac().match(/.{2}/g).join(':').toUpperCase();
  // Release for another chip is refused
  r = await c.post('/admin/factory/runs', { mac, chip: 'ESP32-S3', releaseId: relId, station: 'Bench 1' });
  assert.equal(r.status, 422); assert.equal(r.body.error.code, 'CHIP_MISMATCH');

  r = await c.post('/admin/factory/runs', { mac, chip: 'ESP32', releaseId: relId, station: 'Bench 1' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.history.previousRuns, 0);
  const runId = r.body.run.id;

  // Registering before the code is flashed and a check passed is refused
  r = await c.post('/admin/devices', { mac, chip: 'ESP32', hwModel: 'ARG-S1 rev B', factoryRunId: runId });
  assert.equal(r.body.error.code, 'RUN_NOT_READY');
  r = await c.patch(`/admin/factory/runs/${runId}`, { flashed: true, checks: [{ id: 'boot', ok: false }] });
  r = await c.post('/admin/devices', { mac, chip: 'ESP32', hwModel: 'ARG-S1 rev B', factoryRunId: runId });
  assert.equal(r.body.error.code, 'RUN_NOT_READY');

  const checks = [{ id: 'boot', ok: true, value: `v${v}`, ms: 2100 }, { id: 'radar', ok: false, value: 'no link' }];
  r = await c.patch(`/admin/factory/runs/${runId}`, { flashed: true, flashMs: 41000, checks, result: 'pass' });
  assert.equal(r.body.error.code, 'CHECKS_FAILED');
  checks[1].ok = true;
  r = await c.patch(`/admin/factory/runs/${runId}`, { flashed: true, flashMs: 41000, checks, result: 'pass', logTail: 'x'.repeat(20000) + 'END' });
  assert.equal(r.status, 200);
  assert.equal(r.body.result, 'pass');
  assert.ok(r.body.logTail.endsWith('END')); assert.equal(Buffer.byteLength(r.body.logTail), 16384);
  r = await c.patch(`/admin/factory/runs/${runId}`, { notes: 'late' });
  assert.equal(r.body.error.code, 'RUN_FINISHED');

  // Another board's run can't be used to register this MAC
  r = await c.post('/admin/devices', { mac: randomMac(), chip: 'ESP32', hwModel: 'ARG-S1 rev B', factoryRunId: runId });
  assert.equal(r.body.error.code, 'RUN_MAC_MISMATCH');
  r = await c.post('/admin/devices', { mac, chip: 'ESP32', hwModel: 'ARG-S1 rev B', fwOnBoard: v, factoryRunId: runId });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const serial = r.body.serial;

  // A re-test of the registered board is linked to it at once; abort without result reason
  r = await c.post('/admin/factory/runs', { mac, chip: 'ESP32' });
  assert.equal(r.body.history.previousRuns, 1);
  assert.equal(r.body.history.device.serial, serial);
  r = await c.patch(`/admin/factory/runs/${r.body.run.id}`, { result: 'aborted' });
  assert.equal(r.body.failReason, 'aborted');

  // Factory log: search by serial finds both runs; operator summary
  r = await c.get(`/admin/factory/runs?q=${serial}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 2);
  r = await c.get(`/admin/factory/runs?q=${encodeURIComponent(mac)}&result=pass`);
  assert.equal(r.body.items.length, 1);
  assert.equal(r.body.summary.pass, 1);
  assert.equal(r.body.summary.byOperator[0].operatorName, user.fullName);
  r = await c.get(`/admin/factory/runs/${runId}`);
  assert.equal(r.body.checks.length, 2);

  // Someone else can't change my run; Support can read the log but not start runs
  const sup = await staff('Support');
  r = await sup.c.post('/admin/factory/runs', { mac, chip: 'ESP32' });
  assert.equal(r.status, 403);
  r = await sup.c.get('/admin/factory/runs');
  assert.equal(r.status, 200);
});

test('register while the test still runs: flashed + one passed check is enough', async () => {
  const owner = await staff('Owner');
  const app = appBin();
  const up = await upload(owner.c, { version: `7.${uniq()}`, chipModel: 'ESP32', file: app, factoryFile: mergedBin(app) });
  const { c } = await staff('Manufacturing');
  const mac = randomMac();
  let r = await c.post('/admin/factory/runs', { mac, chip: 'ESP32', releaseId: up.body.id });
  const runId = r.body.run.id;
  await c.patch(`/admin/factory/runs/${runId}`, { flashed: true, checks: [{ id: 'boot', ok: true, value: '2.1 s' }, { id: 'radar', ok: null }] });
  r = await c.post('/admin/devices', { mac, chip: 'ESP32', hwModel: 'ARG-S1 rev B', factoryRunId: runId });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  // the run is still open and can be finished afterwards
  r = await c.patch(`/admin/factory/runs/${runId}`, { result: 'fail', checks: [{ id: 'boot', ok: true }, { id: 'radar', ok: false }] });
  assert.equal(r.status, 200);
  assert.equal(r.body.failReason, 'radar');
  assert.ok(r.body.serial);
});
