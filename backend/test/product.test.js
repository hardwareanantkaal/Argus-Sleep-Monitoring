// Product separation (migration 014): firmware, the manufacturing station, registration and the
// sleep-only device endpoints all check the product (sleep monitor / fall detector).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { BASE, ORIGIN, db, staff, registered, randomMac, insertDevice, registerDevice } = require('./helpers');

after(() => db.end());

const uniq = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
const MB = 1024 * 1024;
const BANNER = { sleep: 'Argus Sleep Monitoring', fall: 'Argus Fall Detection' };
// An app .bin whose boot banner names the product (docs/MANUFACTURING.md §2a)
const appBin = (product, n = 64 * 1024) => {
  const b = Buffer.concat([Buffer.from([0xE9]), crypto.randomBytes(n - 1)]);
  if (product) b.write(`===== ${BANNER[product]} v`, 1024, 'latin1');
  return b;
};
function mergedBin(app, { chip = 'ESP32-S3', size = 4 * MB } = {}) {
  const b = Buffer.alloc(size, 0xFF);
  b[chip === 'ESP32' ? 0x1000 : 0] = 0xE9;
  app.copy(b, 0x10000);
  return b;
}
async function upload(client, fields) {
  const form = new FormData();
  for (const [k, v] of Object.entries({ channel: 'beta', ...fields })) {
    if (Buffer.isBuffer(v)) form.append(k, new Blob([v]), `${k}.bin`);
    else form.append(k, v);
  }
  const res = await fetch(`${BASE}/api/v1/admin/firmware`, { method: 'POST', body: form, headers: { origin: ORIGIN, cookie: client.cookieHeader('/api/v1/admin') } });
  return { status: res.status, body: await res.json() };
}
const colonMac = () => randomMac().match(/.{2}/g).join(':').toUpperCase();

test('firmware upload: the .bin must match the product; fall firmware is ESP32-S3 only; lists filter by product', async () => {
  const { c } = await staff('Owner');
  let r = await upload(c, { version: `8.${uniq()}`, chipModel: 'ESP32-S3', product: 'fall', file: appBin('sleep') });
  assert.equal(r.status, 422); assert.equal(r.body.error.code, 'WRONG_PRODUCT_IMAGE');
  r = await upload(c, { version: `8.${uniq()}`, chipModel: 'ESP32-S3', product: 'sleep', file: appBin('fall') });
  assert.equal(r.status, 422); assert.equal(r.body.error.code, 'WRONG_PRODUCT_IMAGE');
  r = await upload(c, { version: `8.${uniq()}`, chipModel: 'ESP32', product: 'fall', file: appBin('fall') });
  assert.equal(r.status, 422); assert.equal(r.body.error.code, 'WRONG_CHIP');
  const app = appBin('fall');
  r = await upload(c, { version: `8.${uniq()}-fall`, chipModel: 'ESP32-S3', product: 'fall', file: app, factoryFile: mergedBin(app) });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.product, 'fall');
  const id = r.body.id;
  // An old build without a banner still uploads as sleep firmware
  r = await upload(c, { version: `8.${uniq()}`, chipModel: 'ESP32-S3', file: appBin(null) });
  assert.equal(r.status, 201);

  const fall = await c.get('/admin/firmware?product=fall');
  assert.ok(fall.body.items.some((x) => x.id === id) && fall.body.items.every((x) => x.product === 'fall'));
  assert.ok(!(await c.get('/admin/firmware?product=sleep')).body.items.some((x) => x.id === id));
  const ro = await c.get('/admin/ota/rollouts?product=fall');
  assert.equal(ro.status, 200);
  assert.ok(ro.body.items.every((x) => x.product === 'fall'));
});

test('station: runs carry the product; chip, release and registered product are checked', async () => {
  const owner = await staff('Owner');
  const app = appBin('fall');
  const up = await upload(owner.c, { version: `8.${uniq()}-fall`, chipModel: 'ESP32-S3', product: 'fall', file: app, factoryFile: mergedBin(app) });
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const relId = up.body.id;
  const { c } = await staff('Manufacturing');

  assert.ok((await c.get('/admin/factory/releases?product=fall')).body.items.some((x) => x.id === relId && x.product === 'fall'));
  assert.ok(!(await c.get('/admin/factory/releases?product=sleep')).body.items.some((x) => x.id === relId));

  const mac = colonMac();
  let r = await c.post('/admin/factory/runs', { mac, chip: 'ESP32', product: 'fall' });
  assert.equal(r.status, 422); assert.equal(r.body.error.code, 'WRONG_CHIP');
  r = await c.post('/admin/factory/runs', { mac, chip: 'ESP32-S3', product: 'sleep', releaseId: relId });
  assert.equal(r.status, 422); assert.equal(r.body.error.code, 'WRONG_PRODUCT', 'fall firmware on a sleep run');
  r = await c.post('/admin/factory/runs', { mac, chip: 'ESP32-S3', product: 'fall', releaseId: relId });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.run.product, 'fall');
  const run = r.body.run;
  await c.patch(`/admin/factory/runs/${run.id}`, { flashed: true, flashMs: 30000, checks: [{ id: 'boot', ok: true }, { id: 'product', ok: true }] });
  const runs = await c.get(`/admin/factory/runs?product=fall&q=${encodeURIComponent(mac)}`);
  assert.ok(runs.body.items.some((x) => x.id === run.id));
  assert.ok(!(await c.get(`/admin/factory/runs?product=sleep&q=${encodeURIComponent(mac)}`)).body.items.length);

  // Register: the run's product, the chip and the hardware model must agree
  r = await c.post('/admin/devices', { mac, chip: 'ESP32-S3', hwModel: 'ARG-S1 rev B', product: 'sleep', factoryRunId: run.id });
  assert.equal(r.status, 422); assert.equal(r.body.error.code, 'WRONG_PRODUCT');
  r = await c.post('/admin/devices', { mac, chip: 'ESP32-S3', hwModel: 'ARG-S1 rev B', product: 'fall', factoryRunId: run.id });
  assert.equal(r.status, 422); assert.equal(r.body.error.code, 'WRONG_PRODUCT', 'ARG-S model is a sleep monitor');
  r = await c.post('/admin/devices', { mac: colonMac(), chip: 'ESP32', hwModel: 'ARG-F1 rev A', product: 'fall' });
  assert.equal(r.status, 422); assert.equal(r.body.error.code, 'WRONG_CHIP');
  r = await c.post('/admin/devices', { mac, chip: 'ESP32-S3', hwModel: 'ARG-F1 rev A', product: 'fall', factoryRunId: run.id });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.device.product, 'fall');

  // A registered fall detector is re-tested as a fall detector only
  r = await c.post('/admin/factory/runs', { mac, chip: 'ESP32-S3', product: 'sleep' });
  assert.equal(r.status, 422); assert.equal(r.body.error.code, 'WRONG_PRODUCT');
  r = await c.post('/admin/factory/runs', { mac, chip: 'ESP32-S3', product: 'fall' });
  assert.equal(r.status, 201);
  await db.query("UPDATE factory_runs SET result = 'aborted', finished_at = now() WHERE mac = $1 AND result = 'running'", [mac]);
});

test('sleep-only settings, commands, history and alert rules are refused for a fall detector', async () => {
  const { c, user } = await registered();
  const f = await insertDevice({ ownerId: user.id, product: 'fall' });
  const s = await insertDevice({ ownerId: user.id });
  for (const [m, p] of [['get', 'sensor-settings'], ['post', 'recalibrate'], ['post', 'end-session'], ['get', 'nights'], ['get', 'nights/2026-11-18']]) {
    const r = await c[m](`/devices/${f.id}/${p}`);
    assert.equal(r.status, 409, `${p}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error.code, 'NOT_FOR_PRODUCT');
  }
  assert.equal((await c.get(`/devices/${s.id}/sensor-settings`)).status, 200, 'sleep monitor still works');

  let r = await c.put(`/devices/${f.id}/alert-rules`, { rules: [{ type: 'hr_out_of_range', enabled: true, low: 40, high: 120, durationS: 60 }] });
  assert.equal(r.status, 422); assert.equal(r.body.error.code, 'BAD_RULE');
  r = await c.put(`/devices/${f.id}/alert-rules`, { rules: [{ type: 'device_offline', enabled: true, durationS: 600 }] });
  assert.ok(r.status < 300, JSON.stringify(r.body));

  const admin = await staff('Owner');
  r = await admin.c.post(`/admin/devices/${f.id}/commands`, { type: 'recalibrate' });
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'NOT_FOR_PRODUCT');
  r = await admin.c.post(`/admin/devices/${f.id}/commands`, { type: 'reboot' });
  assert.ok(r.status < 300, JSON.stringify(r.body));
});

test('dashboard counts devices per product', async () => {
  const admin = await staff('Owner');
  await registerDevice(admin.c, { product: 'fall', hwModel: 'ARG-F1 rev A' });
  const r = await admin.c.get('/admin/dashboard');
  assert.equal(r.status, 200);
  assert.ok(r.body.byProduct.fall.registered >= 1 && r.body.byProduct.sleep.registered >= 1);
  assert.ok(r.body.fwVersions.every((x) => ['sleep', 'fall'].includes(x.product)));
});
