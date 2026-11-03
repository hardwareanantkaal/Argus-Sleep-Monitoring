// Step 5: factory registration, QR claim, my devices, admin devices
// (docs/API.md §3.1–3.5, 3.9, 3.10, §8.1–8.7, 8.12).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { db, registered, staff, registerDevice, mqttConnect, insertDevice, sleep } = require('./helpers');

const open = [];
after(async () => {
  for (const c of open) { try { c.end(true); } catch { /* closed */ } }
  await db.end();
});

const CODE_RE = /^[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTVWXYZ]{4}$/;
const claimBody = (code, extra = {}) => ({ claimCode: code, name: "Mom's bedroom", room: 'Master', tz: 'Asia/Kolkata', place: 'Surat', ...extra });

test('register: serial, one-time claim code, QR payload and PNG', async () => {
  const { c } = await staff('Manufacturing');
  const r = await registerDevice(c, { batch: 'B-2026-11-A', manufacturedAt: '2026-11-03', fwOnBoard: '1.0.0' });
  assert.match(r.serial, /^ARG-\d{2}[A-Z]\d{4}$/);
  assert.match(r.claimCode, CODE_RE);
  assert.equal(r.qrPayload, `ARG1:${r.claimCode.replaceAll('-', '')}`);
  assert.ok(Buffer.from(r.qrPngBase64, 'base64').subarray(1, 4).toString() === 'PNG');
  assert.equal(r.device.mac, r.mac.match(/.{2}/g).join(':').toUpperCase());
  const { rows: [d] } = await db.query('SELECT claim_code_hash, mqtt_username FROM devices WHERE id = $1', [r.device.id]);
  assert.equal(d.mqtt_username, r.mac);
  assert.ok(d.claim_code_hash && !d.claim_code_hash.includes(r.claimCode.replaceAll('-', '')), 'only the HMAC is stored');
  // the sensor can log in to MQTT straight away
  open.push(await mqttConnect(r.mac));
});

test('register: duplicate MAC 409, customers 403, serials increase', async () => {
  const { c } = await staff('Owner');
  const a = await registerDevice(c);
  const b = await registerDevice(c);
  assert.ok(b.serial > a.serial);
  const dup = await c.post('/admin/devices', { mac: a.mac.toUpperCase(), chip: 'ESP32-S3', hwModel: 'X' });
  assert.deepEqual([dup.status, dup.body.error.code], [409, 'MAC_EXISTS']);
  const cust = await registered();
  assert.equal((await cust.c.post('/admin/devices', { mac: 'aabbccddeeff', chip: 'ESP32', hwModel: 'X' })).status, 403);
  const support = await staff('Support');   // no devices.register
  assert.equal((await support.c.post('/admin/devices', { mac: 'aabbccddeeff', chip: 'ESP32', hwModel: 'X' })).status, 403);
});

test('claim check accepts QR or typed code; wrong codes are rate limited', async () => {
  const { c: admin } = await staff();
  const dev = await registerDevice(admin);
  const { c } = await registered();
  const typed = await c.post('/devices/claim/check', { claimCode: dev.claimCode.toLowerCase(), serial: dev.serial });
  assert.deepEqual([typed.status, typed.body.serial], [200, dev.serial]);
  assert.equal((await c.post('/devices/claim/check', { qr: dev.qrPayload })).body.serial, dev.serial);
  const wrongSerial = await c.post('/devices/claim/check', { claimCode: dev.claimCode, serial: 'ARG-00A0000' });
  assert.equal(wrongSerial.body.error.code, 'INVALID_CODE');

  const other = await registered();
  for (let i = 0; i < 5; i += 1) {
    assert.equal((await other.c.post('/devices/claim/check', { claimCode: 'ZZZZ-ZZZZ-ZZZZ' })).body.error.code, 'INVALID_CODE');
  }
  const limited = await other.c.post('/devices/claim/check', { qr: dev.qrPayload });
  assert.deepEqual([limited.status, limited.body.error.code], [429, 'RATE_LIMITED']);
});

test('claim makes you the owner, sets up settings + alert rules, and burns the code', async () => {
  const { c: admin } = await staff();
  const dev = await registerDevice(admin);
  const { c, user } = await registered();
  const badTz = await c.post('/devices/claim', claimBody(dev.claimCode, { tz: 'Mars/Olympus' }));
  assert.deepEqual([badTz.status, badTz.body.error.code, badTz.body.error.field], [422, 'INVALID_TIMEZONE', 'tz']);

  const r = await c.post('/devices/claim', claimBody(dev.claimCode));
  assert.equal(r.status, 201);
  assert.deepEqual([r.body.serial, r.body.isOwner, r.body.tz, r.body.place, r.body.sleepCutoff, r.body.myPermissions.length],
    [dev.serial, true, 'Asia/Kolkata', 'Surat', '12:00', 5]);
  assert.equal(r.body.sensorSync.sync, 'queued_offline');
  const rules = await db.query('SELECT type, is_enabled FROM alert_rules WHERE device_id = $1 ORDER BY type', [r.body.id]);
  assert.equal(rules.rowCount, 5);
  const ev = await db.query("SELECT 1 FROM device_events WHERE device_id = $1 AND type = 'claimed'", [r.body.id]);
  assert.equal(ev.rowCount, 1);
  assert.equal((await db.query("SELECT 1 FROM audit_log WHERE action = 'device.claim' AND target_id = $1 AND actor_id = $2",
    [r.body.id, user.id])).rowCount, 1);

  const again = await (await registered()).c.post('/devices/claim', claimBody(dev.claimCode));
  assert.equal(again.body.error.code, 'INVALID_CODE', 'a used code no longer works');
});

test('my devices: list, detail, permissions decide the fields, others get 404', async () => {
  const owner = await registered();
  const fam = await registered();
  const stranger = await registered();
  const d = await insertDevice({ ownerId: owner.user.id });
  await db.query('UPDATE devices SET name = $2 WHERE id = $1', [d.id, 'Dad']);
  await db.query('INSERT INTO device_shares (device_id, user_id) VALUES ($1, $2)', [d.id, fam.user.id]);
  await db.query("INSERT INTO device_share_permissions VALUES ($1, $2, 'history.view'), ($1, $2, 'live.view')", [d.id, fam.user.id]);

  const list = await owner.c.get('/devices');
  const card = list.body.items.find((x) => x.id === d.id);
  assert.deepEqual([card.isOwner, card.sharedBy, card.status.online], [true, null, false]);

  const famList = (await fam.c.get('/devices')).body.items;
  assert.deepEqual(famList.map((x) => [x.id, x.isOwner, x.sharedBy.fullName]), [[d.id, false, 'Test User']]);
  const famDetail = (await fam.c.get(`/devices/${d.id}`)).body;
  assert.deepEqual(famDetail.connection, { fw: null }, 'live.view sees only the firmware');
  assert.equal(famDetail.sensorSync, undefined);
  assert.equal((await fam.c.patch(`/devices/${d.id}`, { name: 'X' })).status, 403);

  assert.equal((await stranger.c.get(`/devices/${d.id}`)).status, 404);
  assert.equal((await stranger.c.get('/devices/not-a-uuid')).status, 404);
});

test('PATCH device: name, room, tz, place, cut-off, auto-update', async () => {
  const owner = await registered();
  const d = await insertDevice({ ownerId: owner.user.id });
  const r = await owner.c.patch(`/devices/${d.id}`,
    { name: 'Nani', room: null, tz: 'America/New_York', place: null, sleepCutoff: '14:30', autoUpdate: false });
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.name, r.body.room, r.body.tz, r.body.place, r.body.sleepCutoff, r.body.autoUpdate],
    ['Nani', null, 'America/New_York', null, '14:30', false]);
  assert.equal((await owner.c.patch(`/devices/${d.id}`, { place: 'X' })).body.error.field, 'place');
  assert.equal((await owner.c.patch(`/devices/${d.id}`, { serial: 'ARG-1' })).status, 400, 'unknown fields refused');
});

test('remove device (owner) deletes history; support issues a new code; someone else claims it', async () => {
  const { c: admin } = await staff();
  const dev = await registerDevice(admin);
  const owner = await registered();
  const claimed = await owner.c.post('/devices/claim', claimBody(dev.claimCode, { name: 'Old' }));
  const id = claimed.body.id;
  await db.query(`INSERT INTO sleep_sessions (device_id, sid, started_at, ended_at, timezone, raw)
                  VALUES ($1, 1, now() - interval '8 hours', now(), 'Asia/Kolkata', '{}')`, [id]);

  assert.equal((await owner.c.del(`/devices/${id}`, { confirmName: 'Wrong' })).body.error.code, 'CONFIRM_MISMATCH');
  assert.equal((await owner.c.del(`/devices/${id}`, { confirmName: 'Old' })).status, 204);
  assert.equal((await owner.c.get(`/devices/${id}`)).status, 404);
  assert.equal((await db.query('SELECT 1 FROM sleep_sessions WHERE device_id = $1', [id])).rowCount, 0);
  assert.equal((await db.query('SELECT 1 FROM alert_rules WHERE device_id = $1', [id])).rowCount, 0);

  const code2 = (await admin.post(`/admin/devices/${id}/claim-code`)).body;
  assert.match(code2.claimCode, CODE_RE);
  assert.notEqual(code2.claimCode, dev.claimCode);
  const buyer = await registered();
  assert.equal((await buyer.c.post('/devices/claim', claimBody(dev.claimCode))).body.error.code, 'INVALID_CODE');
  assert.equal((await buyer.c.post('/devices/claim', claimBody(code2.claimCode))).status, 201);
});

test('a family member can leave; the owner cannot', async () => {
  const owner = await registered();
  const fam = await registered();
  const d = await insertDevice({ ownerId: owner.user.id });
  await db.query('INSERT INTO device_shares (device_id, user_id) VALUES ($1, $2)', [d.id, fam.user.id]);
  await db.query("INSERT INTO device_share_permissions VALUES ($1, $2, 'history.view')", [d.id, fam.user.id]);
  assert.equal((await owner.c.del(`/devices/${d.id}/me`)).status, 422);
  assert.equal((await fam.c.del(`/devices/${d.id}/me`)).status, 204);
  assert.equal((await fam.c.get(`/devices/${d.id}`)).status, 404);
});

test('admin list: search by MAC or serial, status filters, paging, mac in rows', async () => {
  const { c } = await staff('Support');
  const mfg = await staff('Manufacturing');
  const dev = await registerDevice(mfg.c);
  const byMac = await c.get(`/admin/devices?q=${encodeURIComponent(dev.mac.slice(4).match(/.{2}/g).join(':'))}`);
  assert.equal(byMac.status, 200);
  assert.deepEqual(byMac.body.items.map((x) => [x.serial, x.mac]), [[dev.serial, dev.device.mac]]);
  const bySerial = await c.get(`/admin/devices?q=${dev.serial}&status=unclaimed`);
  assert.equal(bySerial.body.total, 1);
  const page1 = await c.get('/admin/devices?limit=2');
  assert.equal(page1.body.items.length, 2);
  assert.ok(page1.body.nextCursor);
  const page2 = await c.get(`/admin/devices?limit=2&cursor=${page1.body.nextCursor}`);
  assert.ok(!page2.body.items.some((x) => page1.body.items.some((y) => y.id === x.id)), 'pages do not overlap');
  const cust = await registered();
  assert.equal((await cust.c.get('/admin/devices')).status, 403);
});

test('admin detail, disable (MQTT refused), unclaim, delete only if never claimed', async () => {
  const { c } = await staff('Owner');
  const dev = await registerDevice(c);
  const detail = await c.get(`/admin/devices/${dev.device.id}`);
  assert.deepEqual([detail.body.hardware.mac, detail.body.claimCodeActive, detail.body.owner],
    [dev.device.mac, true, null]);

  assert.equal((await c.patch(`/admin/devices/${dev.device.id}`, { isDisabled: true })).status, 400, 'reason required');
  assert.equal((await c.patch(`/admin/devices/${dev.device.id}`, { isDisabled: true, disabledReason: 'returned' })).status, 200);
  await assert.rejects(mqttConnect(dev.mac), /Not authorized|Bad username or password/);
  await c.patch(`/admin/devices/${dev.device.id}`, { isDisabled: false });
  await sleep(2500);   // the broker caches login answers for 2 s (mosquitto.conf)
  open.push(await mqttConnect(dev.mac));

  const owner = await registered();
  const cl = await owner.c.post('/devices/claim', claimBody(dev.claimCode));
  assert.equal(cl.status, 201);
  assert.equal((await c.del(`/admin/devices/${dev.device.id}`)).body.error.code, 'DEVICE_IN_USE');
  assert.equal((await c.post(`/admin/devices/${dev.device.id}/unclaim`, { reason: 'refund' })).status, 204);
  assert.equal((await owner.c.get(`/devices/${dev.device.id}`)).status, 404);
  assert.equal((await c.del(`/admin/devices/${dev.device.id}`)).body.error.code, 'DEVICE_IN_USE', 'claimed once = keep');

  const typo = await registerDevice(c);
  assert.equal((await c.del(`/admin/devices/${typo.device.id}`)).status, 204);
  assert.equal((await c.get(`/admin/devices/${typo.device.id}`)).status, 404);
});

test('dashboard counts; recent audit only with audit.view', async () => {
  const owner = await staff('Owner');
  const r = await owner.c.get('/admin/dashboard');
  assert.equal(r.status, 200);
  for (const k of ['registered', 'online', 'offline', 'unclaimed', 'customers', 'rolloutsRunning']) {
    assert.equal(typeof r.body.counts[k], 'number', k);
  }
  assert.ok(Array.isArray(r.body.recentAudit));
  const mfg = await staff('Manufacturing');
  assert.equal((await mfg.c.get('/admin/dashboard')).body.recentAudit, undefined);
});
