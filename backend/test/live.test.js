// Step 4: live state + Socket.IO (docs/API.md §10, §11 status/info/state).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const {
  db, Client, registered, insertDevice, mqttConnect, sleep, socketConnect, nextEvent, ask,
} = require('./helpers');

const closers = [];
after(async () => {
  for (const c of closers) { try { c(); } catch { /* already closed */ } }
  await db.end();
  await require('../src/db').pool.end().catch(() => {}); // pool of the in-process sweep test
});
const keep = (x, close = (y) => (y.close ? y.close() : y.end(true))) => { closers.push(() => close(x)); return x; };

async function sensor(mac) {
  const c = keep(await mqttConnect(mac, { will: true }), (x) => x.end(true));
  await c.publishAsync(`argus/${mac}/status`, 'online', { qos: 1, retain: true });
  return c;
}

async function share(deviceId, userId, perms) {
  await db.query('INSERT INTO device_shares (device_id, user_id) VALUES ($1, $2)', [deviceId, userId]);
  for (const p of perms) {
    await db.query('INSERT INTO device_share_permissions (device_id, user_id, permission) VALUES ($1, $2, $3)', [deviceId, userId, p]);
  }
}

test('socket handshake needs the login cookie and our Origin', async () => {
  await assert.rejects(socketConnect(new Client()), (err) => err.data?.code === 'NOT_LOGGED_IN');
  const { c } = await registered();
  await assert.rejects(socketConnect(c, { origin: 'https://evil.example' }));
  const s = keep(await socketConnect(c));
  assert.ok(s.connected);
});

test('devices:subscribe only joins devices you can access', async () => {
  const { c, user } = await registered();
  const mine = await insertDevice({ ownerId: user.id });
  const other = await insertDevice();
  const s = keep(await socketConnect(c));
  const r = await ask(s, 'devices:subscribe', { deviceIds: [mine.id, other.id, 'not-a-uuid'] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.deviceIds, [mine.id]);
  assert.deepEqual(r.status.map((x) => [x.deviceId, x.online]), [[mine.id, false]]);
});

test('sensor online / live values / last-will offline reach the browser', async () => {
  const { c, user } = await registered();
  const d = await insertDevice({ ownerId: user.id });
  const s = keep(await socketConnect(c));
  await ask(s, 'devices:subscribe', { deviceIds: [d.id] });
  const sub = await ask(s, 'live:subscribe', { deviceId: d.id });
  assert.deepEqual(sub, { ok: true, live: null });

  const online = nextEvent(s, 'device:status', (p) => p.deviceId === d.id && p.online);
  const dev = await sensor(d.mac);
  assert.equal((await online).serial, d.serial);
  const st = await db.query('SELECT is_online, online_since FROM device_state WHERE device_id = $1', [d.id]);
  assert.equal(st.rows[0].is_online, true);

  const liveMsg = nextEvent(s, 'device:live', (p) => p.deviceId === d.id);
  await dev.publishAsync(`argus/${d.mac}/state`,
    JSON.stringify({ pr: 1, bed: 1, ss: 1, hr: 62, br: 14, bs: 1, mv: 1, mr: 12, dist: 85, rssi: -61, up: 3600, fw: '1.0.0' }), { qos: 0 });
  const l = await liveMsg;
  assert.deepEqual([l.hr, l.br, l.bed, l.rssi, l.serial], [62, 14, 1, -61, d.serial]);
  assert.ok(l.at);
  // a fresh live:subscribe gets the latest value straight away
  assert.equal((await ask(s, 'live:subscribe', { deviceId: d.id })).live.hr, 62);

  const offline = nextEvent(s, 'device:status', (p) => p.deviceId === d.id && !p.online);
  dev.stream.destroy();                       // connection lost -> broker sends the last will
  await offline;
  const ev = await db.query("SELECT type FROM device_events WHERE device_id = $1 AND type IN ('online','offline') ORDER BY id", [d.id]);
  assert.deepEqual(ev.rows.map((r) => r.type), ['online', 'offline']);
});

test('live values need live.view; a family member with history only is refused', async () => {
  const owner = await registered();
  const fam = await registered();
  const d = await insertDevice({ ownerId: owner.user.id });
  await share(d.id, fam.user.id, ['history.view']);
  const s = keep(await socketConnect(fam.c));
  assert.deepEqual((await ask(s, 'devices:subscribe', { deviceIds: [d.id] })).deviceIds, [d.id]);
  assert.deepEqual(await ask(s, 'live:subscribe', { deviceId: d.id }), { ok: false, code: 'NOT_FOUND' });
});

test('info message fills connection details in device_state', async () => {
  const { user } = await registered();
  const d = await insertDevice({ ownerId: user.id });
  const dev = await sensor(d.mac);
  await dev.publishAsync(`argus/${d.mac}/info`,
    JSON.stringify({ fw: '1.0.1', ip: '192.168.1.41', ssid: 'Shah_Home_5G', chip: 'ESP32-S3', radar: 1, rst: 'poweron' }),
    { qos: 1, retain: true });
  await sleep(500);
  const { rows: [st] } = await db.query('SELECT fw_version, host(ip) AS ip, wifi_ssid, radar_ok FROM device_state WHERE device_id = $1', [d.id]);
  assert.deepEqual(st, { fw_version: '1.0.1', ip: '192.168.1.41', wifi_ssid: 'Shah_Home_5G', radar_ok: true });
});

test('admin:subscribe needs a staff permission', async () => {
  const cust = await registered();
  const s1 = keep(await socketConnect(cust.c));
  assert.equal((await ask(s1, 'admin:subscribe', { topics: ['devices'] })).ok, false);

  const staff = await registered();
  await db.query("UPDATE users SET staff_role_id = (SELECT id FROM staff_roles WHERE name = 'Support') WHERE id = $1", [staff.user.id]);
  const s2 = keep(await socketConnect(staff.c));
  const r = await ask(s2, 'admin:subscribe', { topics: ['devices', 'rollouts'] });
  assert.deepEqual(r, { ok: true, topics: ['devices'] }, 'Support has devices.view but not firmware.view');
  const d = await insertDevice();               // nobody's device: admins still see it
  const seen = nextEvent(s2, 'device:status', (p) => p.deviceId === d.id && p.online);
  await sensor(d.mac);
  await seen;
});

test('logout-all closes open sockets', async () => {
  const { c } = await registered();
  const s = keep(await socketConnect(c));
  const gone = new Promise((resolve) => s.once('disconnect', resolve));
  assert.equal((await c.post('/auth/logout-all')).status, 204);
  await gone;
});

test('stale sweep marks a silent sensor offline', async () => {
  // In-process: drive the live module directly with a far-future clock.
  const live = require('../src/services/live');
  const { user } = await registered();
  const d = await insertDevice({ ownerId: user.id });
  await live._handlers.onState(d.mac, Buffer.from('{"pr":0,"rssi":-60}'));
  assert.equal((await db.query('SELECT is_online FROM device_state WHERE device_id = $1', [d.id])).rows[0].is_online, true);
  await live.sweep(Date.now() + 10 * 60_000);
  assert.equal((await db.query('SELECT is_online FROM device_state WHERE device_id = $1', [d.id])).rows[0].is_online, false);
});

test('device events (bed_in, bed_out, reboot, struggle) are stored', async () => {
  const { user } = await registered();
  const d = await insertDevice({ ownerId: user.id });
  const dev = await sensor(d.mac);
  const ts = Math.floor(Date.now() / 1000) - 60;
  await dev.publishAsync(`argus/${d.mac}/event`, JSON.stringify({ t: 'bed_in', ts }), { qos: 1 });
  await dev.publishAsync(`argus/${d.mac}/event`, JSON.stringify({ t: 'struggle', ts }), { qos: 1 });
  await dev.publishAsync(`argus/${d.mac}/event`, JSON.stringify({ t: 'reboot', reason: 'power' }), { qos: 1 });
  await dev.publishAsync(`argus/${d.mac}/event`, JSON.stringify({ t: 'made_up' }), { qos: 1 });
  await dev.publishAsync(`argus/${d.mac}/info`, JSON.stringify({ fw: '2.0.0', radar: 'C1001 v?' }), { qos: 1 });
  await sleep(600);
  const { rows } = await db.query(
    "SELECT type, severity, message, extract(epoch FROM occurred_at)::int AS at FROM device_events WHERE device_id = $1 AND type NOT IN ('online','offline') ORDER BY id", [d.id]);
  assert.deepEqual(rows.map((r) => [r.type, r.severity]), [['bed_in', 'info'], ['struggle', 'warning'], ['reboot', 'info']]);
  assert.equal(rows[0].at, ts, 'device timestamp kept');
  assert.equal(rows[2].message, 'reason: power');
  assert.equal((await db.query("SELECT radar_ok FROM device_state WHERE device_id = $1", [d.id])).rows[0].radar_ok, null,
    'a radar name string is not a fault');
});
