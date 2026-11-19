// Fall Detection product (migration 013, DEVICE-DATA.md §8, API.md §4b).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  BASE, db, registered, insertDevice, mqttConnect, sleep, socketConnect, nextEvent, ask, staff, registerDevice,
} = require('./helpers');

const closers = [];
after(async () => {
  for (const c of closers) { try { c(); } catch { /* already closed */ } }
  await db.end();
  await require('../src/db').pool.end().catch(() => {}); // pool of the in-process tests
});
const keep = (x, close = (y) => (y.close ? y.close() : y.end(true))) => { closers.push(() => close(x)); return x; };

// The broker's ACL hook, called the way mosquitto-go-auth calls it.
async function acl(mac, topic, acc) {
  const r = await fetch(`${BASE}/mqtt/acl`, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: mac, clientid: mac, topic, acc }) });
  return r.status;
}

async function fallSensor(mac) {
  const c = keep(await mqttConnect(mac), (x) => x.end(true));
  await c.publishAsync(`fall/${mac}/status`, 'online', { qos: 1, retain: true });
  return c;
}

const now = () => Math.floor(Date.now() / 1000);
const FALL = (eid, extra = {}) => ({ eid, t: 'fall', ts: now() - 95, tid: 1, ema_now: 0.42, ema_peak: 1.68, drop_m: 1.26,
  drop_pct: 75, pos: [0.35, 2.8, 0.4], vel: [0.1, -0.2, -1.1], h: 0.42, pr: 1, preset: 'MED', ...extra });

test('ACL: fall devices use fall/<mac>/ topics; sleep devices cannot', async () => {
  const f = await insertDevice({ product: 'fall' });
  const s = await insertDevice();
  assert.equal(await acl(f.mac, `fall/${f.mac}/alive`, 2), 200);
  assert.equal(await acl(f.mac, `fall/${f.mac}/event`, 2), 200);
  assert.equal(await acl(f.mac, `fall/${f.mac}/status`, 2), 200);
  assert.equal(await acl(f.mac, `argus/${f.mac}/ota/status`, 2), 200, 'OTA stays on the shared topics');
  assert.equal(await acl(f.mac, `argus/${f.mac}/cmd`, 4), 200);
  assert.equal(await acl(f.mac, `argus/${f.mac}/state`, 2), 403, 'no sleep data from a fall device');
  assert.equal(await acl(f.mac, `argus/${f.mac}/session`, 2), 403);
  assert.equal(await acl(f.mac, `fall/${s.mac}/event`, 2), 403, 'not another device');
  assert.equal(await acl(s.mac, `fall/${s.mac}/event`, 2), 403, 'sleep device cannot send falls');
  assert.equal(await acl(s.mac, `argus/${s.mac}/state`, 2), 200);
});

test('alive is live only; FALL is stored once and opens an alert; RECOVERED closes it', async () => {
  const { c, user } = await registered();
  const d = await insertDevice({ ownerId: user.id, product: 'fall' });
  const s = keep(await socketConnect(c));
  await ask(s, 'devices:subscribe', { deviceIds: [d.id] });
  await ask(s, 'live:subscribe', { deviceId: d.id });
  const dev = await fallSensor(d.mac);

  const liveMsg = nextEvent(s, 'device:live', (p) => p.deviceId === d.id);
  await dev.publishAsync(`fall/${d.mac}/alive`, JSON.stringify({ fw: '0.1.0', up: 120, rssi: -61, radar: 1, pr: 1, preset: 'MED' }), { qos: 0 });
  const l = await liveMsg;
  assert.deepEqual([l.product, l.pr, l.radar, l.preset, l.rssi], ['fall', 1, 1, 'MED', -61]);
  await sleep(300);
  const { rows: [st] } = await db.query('SELECT is_online, fw_version, radar_ok FROM device_state WHERE device_id = $1', [d.id]);
  assert.deepEqual(st, { is_online: true, fw_version: '0.1.0', radar_ok: true });
  assert.equal((await db.query('SELECT count(*)::int AS n FROM fall_events WHERE device_id = $1', [d.id])).rows[0].n, 0,
    'alive is never stored');

  const alertNew = nextEvent(s, 'alert:new', (p) => p.deviceId === d.id);
  await dev.publishAsync(`fall/${d.mac}/event`, JSON.stringify(FALL(17)), { qos: 1 });
  const a = await alertNew;
  assert.deepEqual([a.type, a.severity, a.title], ['fall', 'critical', 'Fall detected: dropped 126 cm']);
  await dev.publishAsync(`fall/${d.mac}/event`, JSON.stringify(FALL(17)), { qos: 1 });   // resend
  await sleep(300);

  let r = await c.get(`/devices/${d.id}/falls`);
  assert.equal(r.status, 200);
  assert.equal(r.body.items.length, 1, 'a resend with the same eid is stored once');
  const f = r.body.items[0];
  assert.deepEqual([f.kind, f.eid, f.tid, f.preset, f.presence, f.recoveredAt], ['fall', 17, 1, 'MED', true, null]);
  assert.ok(Math.abs(f.dropM - 1.26) < 1e-6 && Math.abs(f.pos[1] - 2.8) < 1e-6 && Math.abs(f.heightM - 0.42) < 1e-6);

  const ended = nextEvent(s, 'alert:ended', (p) => p.deviceId === d.id);
  await dev.publishAsync(`fall/${d.mac}/event`, JSON.stringify({ eid: 18, t: 'recovered', ts: now(), tid: 1, fall_eid: 17 }), { qos: 1 });
  await ended;
  r = await c.get(`/devices/${d.id}/falls`);
  assert.deepEqual(r.body.items.map((x) => x.kind), ['recovered', 'fall']);
  assert.equal(r.body.items[0].fallEid, 17);
  assert.ok(r.body.items[1].recoveryS >= 94 && r.body.items[1].recoveryS <= 96, `recoveryS ${r.body.items[1].recoveryS}`);
  const { rows: alerts } = await db.query("SELECT type, ended_at FROM alerts WHERE device_id = $1", [d.id]);
  assert.equal(alerts.length, 1);
  assert.ok(alerts[0].ended_at);
});

test('RECOVERED without fall_eid closes the open fall of the same track; optional fields may be missing', async () => {
  const live = require('../src/services/live');
  const fall = require('../src/services/fall');
  const { user } = await registered();
  const d = await insertDevice({ ownerId: user.id, product: 'fall' });
  // Minimal FALL: no pos / vel / h / pr (the hardware may not give them)
  const row = await live.withLock(d.mac, () => fall._handlers.onFallEvent(d.mac,
    Buffer.from(JSON.stringify({ eid: 1, t: 'fall', ts: now() - 10, tid: 2, drop_m: 0.9 }))));
  assert.ok(row);
  assert.equal(await fall._handlers.onFallEvent(d.mac, Buffer.from('{"t":"fall","tid":2,"drop_m":1}')), null, 'eid is required');
  assert.equal(await fall._handlers.onFallEvent(d.mac, Buffer.from('{"eid":5,"t":"sat_down","tid":2}')), null);
  await fall._handlers.onFallEvent(d.mac, Buffer.from(JSON.stringify({ eid: 2, t: 'recovered', ts: now(), tid: 2 })));
  const list = await fall.list(d.id);
  assert.deepEqual(list.items.map((x) => [x.kind, x.eid]), [['recovered', 2], ['fall', 1]]);
  assert.equal(list.items[0].fallEid, 1);
  assert.equal(list.items[1].pos, null);
  assert.ok(list.items[1].recoveryS >= 9 && list.items[1].recoveryS <= 11);
});

test('fall detectors stay online between 60 s alive messages', async () => {
  const live = require('../src/services/live');
  const fall = require('../src/services/fall');
  const { user } = await registered();
  const d = await insertDevice({ ownerId: user.id, product: 'fall' });
  await live.withLock(d.mac, () => fall._handlers.onAlive(d.mac, Buffer.from('{"fw":"0.1.0","radar":1,"pr":0}')));
  const online = async () => (await db.query('SELECT is_online FROM device_state WHERE device_id = $1', [d.id])).rows[0].is_online;
  assert.equal(await online(), true);
  await live.sweep(Date.now() + 70_000);
  assert.equal(await online(), true, 'not offline after one alive interval');
  await live.sweep(Date.now() + 160_000);
  assert.equal(await online(), false);
});

test('falls endpoint: fall devices only, needs history.view', async () => {
  const { c, user } = await registered();
  const sleepDev = await insertDevice({ ownerId: user.id });
  assert.equal((await c.get(`/devices/${sleepDev.id}/falls`)).status, 404);
  const other = await registered();
  const f = await insertDevice({ ownerId: other.user.id, product: 'fall' });
  assert.equal((await c.get(`/devices/${f.id}/falls`)).status, 404, 'no access = not found');
  const mine = await c.get('/devices');
  assert.deepEqual(mine.body.items.map((x) => x.product), ['sleep']);
});

test('register a fall detector; claiming it creates only the offline alert rule', async () => {
  const admin = await staff('Owner');
  const reg = await registerDevice(admin.c, { product: 'fall' });
  assert.equal(reg.device.product, 'fall');
  const list = await admin.c.get('/admin/devices?product=fall&limit=100');
  assert.ok(list.body.items.some((x) => x.id === reg.device.id && x.product === 'fall'));
  assert.ok(!(await admin.c.get('/admin/devices?product=sleep&limit=100')).body.items.some((x) => x.id === reg.device.id));

  const cust = await registered();
  const chk = await cust.c.post('/devices/claim/check', { claimCode: reg.claimCode });
  assert.equal(chk.body.product, 'fall');
  const cl = await cust.c.post('/devices/claim', { claimCode: reg.claimCode, name: 'Bathroom', tz: 'Asia/Kolkata' });
  assert.equal(cl.status, 201, JSON.stringify(cl.body));
  assert.equal(cl.body.product, 'fall');
  assert.equal(cl.body.lastNight, null);
  const { rows } = await db.query('SELECT type FROM alert_rules WHERE device_id = $1', [reg.device.id]);
  assert.deepEqual(rows.map((x) => x.type), ['device_offline']);
  assert.equal((await admin.c.get(`/admin/devices/${reg.device.id}/falls`)).status, 200);
});

test('OTA: a fall detector release never reaches sleep monitors (and the other way round)', async () => {
  const admin = await staff('Owner');
  const ver = `0.9.${Date.now() % 100000}-fall`;
  const { rows: [rel] } = await db.query(
    `INSERT INTO firmware_releases (version, channel, chip_model, file_path, file_size, sha256, product)
     VALUES ($1, 'beta', 'ESP32-S3', '/tmp/none.bin', 1, $2, 'fall') RETURNING id`, [ver, 'a'.repeat(64)]);
  const sleepDev = await insertDevice();
  const fallDev = await insertDevice({ product: 'fall' });
  const bad = await admin.c.post('/admin/ota/rollouts', { releaseId: rel.id, target: 'serials', serials: [sleepDev.serial] });
  assert.equal(bad.status, 422);
  assert.equal(bad.body.error?.code ?? bad.body.code, 'WRONG_PRODUCT');
  const ok = await admin.c.post('/admin/ota/rollouts', { releaseId: rel.id, target: 'all', installWindow: null });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  const { rows } = await db.query(
    'SELECT d.product, rd.device_id FROM ota_rollout_devices rd JOIN devices d ON d.id = rd.device_id WHERE rd.rollout_id = $1', [ok.body.rolloutId]);
  assert.ok(rows.some((r) => r.device_id === fallDev.id));
  assert.ok(rows.every((r) => r.product === 'fall'), 'no sleep monitor in a fall rollout');
  await db.query("UPDATE ota_rollouts SET status = 'cancelled' WHERE id = $1", [ok.body.rolloutId]);
  await db.query("UPDATE ota_rollout_devices SET status = 'skipped' WHERE rollout_id = $1", [ok.body.rolloutId]);
});
