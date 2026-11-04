// Step 7: sensor settings sync, commands (with the offline queue), logs,
// device events (docs/API.md §3.6–3.8, §8.8–8.11, §11).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, registered, staff, insertDevice, mqttConnect, sleep, socketConnect, nextEvent, ask } = require('./helpers');

const open = [];
after(async () => {
  for (const c of open) { try { c.close ? c.close() : c.end(true); } catch { /* closed */ } }
  await db.end();
});

// A fake sensor: subscribes like the firmware, announces itself online and
// records what it receives per topic suffix.
async function sensor(mac) {
  const c = await mqttConnect(mac, { will: true });
  open.push(c);
  const got = { cmd: [], 'settings/set': [] };
  c.on('message', (topic, p) => {
    const suffix = topic.split('/').slice(2).join('/');
    const text = p.toString();
    got[suffix]?.push(text ? JSON.parse(text) : null);
  });
  await c.subscribeAsync([`argus/${mac}/cmd`, `argus/${mac}/settings/set`], { qos: 1 });
  await c.publishAsync(`argus/${mac}/status`, 'online', { qos: 1, retain: true });
  const pub = (suffix, body) => c.publishAsync(`argus/${mac}/${suffix}`, JSON.stringify(body), { qos: 1 });
  return { c, got, pub };
}

async function until(fn, ms = 4000) {
  for (let t = 0; t < ms; t += 50) {
    const v = await fn();
    if (v) return v;
    await sleep(50);
  }
  return fn();
}

async function ownedDevice() {
  const owner = await registered();
  const d = await insertDevice({ ownerId: owner.user.id });
  return { owner, d };
}

test('sensor settings: change -> retained settings/set -> ack -> applied', async () => {
  const { owner, d } = await ownedDevice();
  const s = await sensor(d.mac);
  await until(() => s.got['settings/set'].length);          // initial v1 on coming online
  assert.equal(s.got['settings/set'].at(-1).v, 1);

  const sock = await socketConnect(owner.c);
  open.push(sock);
  await ask(sock, 'devices:subscribe', { deviceIds: [d.id] });

  const r = await owner.c.patch(`/devices/${d.id}/sensor-settings`, { exitS: 600, unattended: true });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.settings.version, r.body.settings.sync, r.body.settings.exitS], [2, 'sending', 600]);
  const msg = await until(() => s.got['settings/set'].find((m) => m.v === 2));
  assert.deepEqual(msg, { v: 2, exit_s: 600, live_s: 2, idle_s: 60, struggle: 1, unattended: 1, unatt_min: 30, min_sess: 25 });

  const synced = nextEvent(sock, 'settings:sync', (p) => p.deviceId === d.id && p.sync === 'applied');
  await s.pub('settings/ack', { v: 2 });
  await synced;
  await s.pub('settings/ack', { v: 1 });                      // older than applied: ignored
  await s.pub('settings/ack', { v: 2 });                      // duplicate: ignored
  await s.pub('settings/ack', { v: 9 });                      // never sent: ignored
  await sleep(300);
  const g = await owner.c.get(`/devices/${d.id}/sensor-settings`);
  assert.deepEqual([g.body.appliedVersion, g.body.sync], [2, 'applied']);
  assert.equal((await db.query("SELECT 1 FROM device_events WHERE device_id = $1 AND type = 'settings_applied'", [d.id])).rowCount, 1);
});

test('sensor settings: offline change reaches the sensor when it connects', async () => {
  const { owner, d } = await ownedDevice();
  const r = await owner.c.patch(`/devices/${d.id}/sensor-settings`, { liveS: 3 });
  assert.equal(r.body.settings.sync, 'queued_offline');
  const s = await sensor(d.mac);
  const msg = await until(() => s.got['settings/set'].find((m) => m.live_s === 3));
  assert.equal(msg.v, 2);
});

test('sensor settings: validation and permissions', async () => {
  const { owner, d } = await ownedDevice();
  assert.equal((await owner.c.patch(`/devices/${d.id}/sensor-settings`, { exitS: 10 })).body.error.field, 'exitS');
  assert.equal((await owner.c.patch(`/devices/${d.id}/sensor-settings`, { mount: 'ceiling' })).status, 400);
  const fam = await registered();
  await db.query('INSERT INTO device_shares (device_id, user_id) VALUES ($1, $2)', [d.id, fam.user.id]);
  await db.query("INSERT INTO device_share_permissions VALUES ($1, $2, 'live.view')", [d.id, fam.user.id]);
  assert.equal((await fam.c.get(`/devices/${d.id}/sensor-settings`)).status, 403);
  assert.equal((await fam.c.post(`/devices/${d.id}/wifi-setup`)).status, 403);
});

test('command to an online sensor: sent, acked, visible in history and on the socket', async () => {
  const { d } = await ownedDevice();
  const admin = await staff('Support');
  const s = await sensor(d.mac);
  await until(() => s.got['settings/set'].length);
  const sock = await socketConnect(admin.c);
  open.push(sock);
  await ask(sock, 'admin:subscribe', { topics: ['devices'] });

  const r = await admin.c.post(`/admin/devices/${d.id}/commands`, { type: 'reboot' });
  assert.deepEqual([r.status, r.body.status], [202, 'sent']);
  const cmd = await until(() => s.got.cmd.find((m) => m.id === r.body.commandId));
  assert.deepEqual(cmd, { id: r.body.commandId, c: 'reboot' });

  const acked = nextEvent(sock, 'command:status', (p) => p.commandId === r.body.commandId && p.status === 'acked');
  await s.pub('cmd/ack', { id: r.body.commandId, ok: 1 });
  assert.equal((await acked).serial, d.serial);

  const h = await admin.c.get(`/admin/devices/${d.id}/commands`);
  assert.deepEqual([h.body.items[0].type, h.body.items[0].status, h.body.items[0].requestedBy], ['reboot', 'acked', 'Test User']);
});

test('a failed ack is recorded with its error', async () => {
  const { d } = await ownedDevice();
  const admin = await staff('Owner');
  const s = await sensor(d.mac);
  await until(() => s.got['settings/set'].length);
  const r = await admin.c.post(`/admin/devices/${d.id}/commands`, { type: 'ota_check' });
  await until(() => s.got.cmd.length);
  await s.pub('cmd/ack', { id: r.body.commandId, ok: 0, err: 'no wifi' });
  const row = await until(async () => (await db.query("SELECT status, error FROM device_commands WHERE id = $1 AND status = 'failed'", [r.body.commandId])).rows[0]);
  assert.deepEqual(row, { status: 'failed', error: 'no wifi' });
});

test('offline sensor: command is queued, sent on reconnect; logs arrive in parts', async () => {
  const { d } = await ownedDevice();
  const admin = await staff('Owner');
  const r = await admin.c.post(`/admin/devices/${d.id}/commands`, { type: 'logs' });
  assert.deepEqual([r.status, r.body.status], [202, 'queued']);
  const ttl = (await db.query('SELECT extract(epoch FROM expires_at - created_at)::int AS s FROM device_commands WHERE id = $1', [r.body.commandId])).rows[0].s;
  assert.equal(ttl, 24 * 3600);

  const s = await sensor(d.mac);
  const cmd = await until(() => s.got.cmd.find((m) => m.id === r.body.commandId));
  assert.equal(cmd.c, 'logs');
  await s.pub('logs', { id: cmd.id, part: 2, of: 2, text: 'I radar: C1001 init ok\n' });   // out of order on purpose
  await s.pub('logs', { id: cmd.id, part: 1, of: 2, text: '[06:41:02] I wifi: connected\n' });
  await s.pub('cmd/ack', { id: cmd.id, ok: 1 });
  const logs = await until(async () => (await admin.c.get(`/admin/devices/${d.id}/logs`)).body.items[0]);
  assert.equal(logs.content, '[06:41:02] I wifi: connected\nI radar: C1001 init ok\n');

  const ev = await admin.c.get(`/admin/devices/${d.id}/events?limit=50`);
  const types = ev.body.items.map((e) => e.type);
  assert.ok(types.includes('logs_uploaded') && types.includes('online'));
  assert.deepEqual(Object.keys(ev.body.items[0]).sort(), ['createdAt', 'detail', 'id', 'severity', 'type']);
});

test('Wi-Fi setup (config_mode) on an offline sensor expires after 30 s', async () => {
  const { owner, d } = await ownedDevice();
  const r = await owner.c.post(`/devices/${d.id}/wifi-setup`);
  assert.deepEqual([r.status, r.body.status], [202, 'queued']);
  const ttl = (await db.query('SELECT extract(epoch FROM expires_at - created_at)::int AS s FROM device_commands WHERE id = $1', [r.body.commandId])).rows[0].s;
  assert.equal(ttl, 30);
  // Pretend the 30 s are over; the backend's expiry sweep runs every 10 s.
  await db.query("UPDATE device_commands SET expires_at = now() - interval '1 second' WHERE id = $1", [r.body.commandId]);
  const st = await until(async () => (await db.query('SELECT status FROM device_commands WHERE id = $1', [r.body.commandId])).rows[0].status === 'expired', 12_000);
  assert.ok(st, 'expired');
  const s = await sensor(d.mac);
  await sleep(500);
  assert.equal(s.got.cmd.length, 0, 'an expired command is never sent');
});

test('command permissions: devices.command only', async () => {
  const { d } = await ownedDevice();
  const mfg = await staff('Manufacturing');
  assert.equal((await mfg.c.post(`/admin/devices/${d.id}/commands`, { type: 'reboot' })).status, 403);
  assert.equal((await mfg.c.get(`/admin/devices/${d.id}/commands`)).status, 200, 'devices.view can read history');
  const cust = await registered();
  assert.equal((await cust.c.post(`/admin/devices/${d.id}/commands`, { type: 'reboot' })).status, 403);
  const owner = await staff('Owner');
  assert.equal((await owner.c.post(`/admin/devices/${d.id}/commands`, { type: 'selfdestruct' })).status, 400);
});

test('recalibrate (firmware 2.0.0): sent to an online sensor, 30 s when offline', async () => {
  const { d } = await ownedDevice();
  const admin = await staff('Support');
  const s = await sensor(d.mac);
  await until(() => s.got['settings/set'].length);
  const r = await admin.c.post(`/admin/devices/${d.id}/commands`, { type: 'recalibrate' });
  assert.deepEqual([r.status, r.body.status], [202, 'sent']);
  assert.deepEqual(await until(() => s.got.cmd.find((m) => m.id === r.body.commandId)), { id: r.body.commandId, c: 'recalibrate' });
  const off = await ownedDevice();
  const q = await admin.c.post(`/admin/devices/${off.d.id}/commands`, { type: 'recalibrate' });
  const ttl = (await db.query('SELECT extract(epoch FROM expires_at - created_at)::int AS s FROM device_commands WHERE id = $1', [q.body.commandId])).rows[0].s;
  assert.deepEqual([q.body.status, ttl], ['queued', 30]);
});
