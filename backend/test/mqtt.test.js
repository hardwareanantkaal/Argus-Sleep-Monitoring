// Step 3: Mosquitto go-auth hooks and the backend MQTT client (docs/API.md §11).
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { BASE, db, MQTT_BACKEND, randomMac, insertDevice, mqttConnect, sleep } = require('./helpers');

const open = [];
after(async () => {
  for (const c of open) c.end(true);
  await db.end();
});
async function connect(...args) {
  const c = await mqttConnect(...args);
  open.push(c);
  return c;
}

// Listens on everything with the backend's credentials (a different client
// id, so the real backend isn't kicked off).
async function spy() {
  const c = await connect(MQTT_BACKEND.username, { clientId: `argus-test-spy-${Date.now()}`, password: MQTT_BACKEND.password });
  const seen = [];
  c.on('message', (topic, payload) => seen.push({ topic, payload: payload.toString() }));
  await c.subscribeAsync('argus/#', { qos: 1 });
  return seen;
}

// Granted QoS, or 128 when the broker refuses (mqtt.js rejects in that case).
async function subscribeResult(c, topic) {
  try {
    return (await c.subscribeAsync(topic, { qos: 1 }))[0].qos;
  } catch (err) {
    if (err.granted || /Subscribe error/.test(err.message)) return 128;
    throw err;
  }
}

test('/health reports the MQTT connection', async () => {
  const r = await (await fetch(`${BASE}/health`)).json();
  assert.deepEqual(r, { ok: true, db: true, mqtt: true });
});

test('a registered device logs in with its MAC and any dummy password', async () => {
  const d = await insertDevice();
  const c = await connect(d.mac, { password: 'any-dummy' });
  assert.ok(c.connected);
  // go-auth itself refuses an EMPTY password, so firmware must send a dummy (API.md §11).
  c.end(true);
  await assert.rejects(connect(d.mac, { password: '' }), /Not authorized|Bad username or password/);
});

test('unknown, malformed and disabled devices are refused', async () => {
  await assert.rejects(connect(randomMac()), /Not authorized|Bad username or password/);
  await assert.rejects(connect('AA:BB:CC:DD:EE:FF'), /Not authorized|Bad username or password/);
  const off = await insertDevice({ disabled: true });
  await assert.rejects(connect(off.mac), /Not authorized|Bad username or password/);
});

test('the client id must equal the MAC', async () => {
  const d = await insertDevice();
  await assert.rejects(connect(d.mac, { clientId: 'something-else' }), /Not authorized|Bad username or password/);
});

test('the backend user needs the right password', async () => {
  await assert.rejects(connect(MQTT_BACKEND.username, { clientId: 'argus-test-bad', password: 'wrong' }),
    /Not authorized|Bad username or password/);
});

test('a device may publish only its own device→server topics', async () => {
  const seen = await spy();
  const a = await insertDevice();
  const b = await insertDevice();
  const dev = await connect(a.mac);
  await dev.publishAsync(`argus/${a.mac}/state`, '{"pr":1}', { qos: 1 });
  await dev.publishAsync(`argus/${a.mac}/session`, '{"sid":1}', { qos: 1 });
  await dev.publishAsync(`argus/${b.mac}/state`, '{"spoof":1}', { qos: 1 });   // another device's topic
  await dev.publishAsync(`argus/${a.mac}/cmd`, '{"id":1,"c":"reboot"}', { qos: 1 }); // server→device topic
  await sleep(800);
  const topics = seen.map((m) => m.topic);
  assert.ok(topics.includes(`argus/${a.mac}/state`));
  assert.ok(topics.includes(`argus/${a.mac}/session`));
  assert.ok(!topics.includes(`argus/${b.mac}/state`), 'spoofed publish was dropped');
  assert.ok(!topics.includes(`argus/${a.mac}/cmd`), 'device cannot publish commands');
});

test('a device may subscribe only to its own server→device topics', async () => {
  const a = await insertDevice();
  const b = await insertDevice();
  const dev = await connect(a.mac);
  for (const s of ['cmd', 'settings/set', 'ota', 'session/ack']) {
    assert.equal(await subscribeResult(dev, `argus/${a.mac}/${s}`), 1, s);
  }
  assert.equal(await subscribeResult(dev, `argus/${b.mac}/cmd`), 128, 'other device');
  assert.equal(await subscribeResult(dev, 'argus/#'), 128, 'wildcard');
  assert.equal(await subscribeResult(dev, `argus/${a.mac}/state`), 128, 'device→server topic');
});

test('the server side can send a command to a device', async () => {
  const d = await insertDevice();
  const dev = await connect(d.mac);
  await dev.subscribeAsync(`argus/${d.mac}/cmd`, { qos: 1 });
  const got = new Promise((resolve) => dev.once('message', (t, p) => resolve(p.toString())));
  const server = await connect(MQTT_BACKEND.username, { clientId: `argus-test-srv-${Date.now()}`, password: MQTT_BACKEND.password });
  await server.publishAsync(`argus/${d.mac}/cmd`, '{"id":7,"c":"reboot"}', { qos: 1 });
  assert.equal(await got, '{"id":7,"c":"reboot"}');
});

test('the auth hooks deny superusers and garbage', async () => {
  const post = (path, body) => fetch(`${BASE}/mqtt/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post('superuser', { username: MQTT_BACKEND.username })).status, 403);
  assert.equal((await post('user', {})).status, 403);
  assert.equal((await post('acl', { username: randomMac(), clientid: 'x', topic: 'argus/x/state', acc: 2 })).status, 403);
});
