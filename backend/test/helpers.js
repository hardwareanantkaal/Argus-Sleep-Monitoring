// Test helpers. Tests run on the host against the dev Docker stack:
//   docker compose up -d   then   npm test   (from backend/)
const { Pool } = require('pg');

const BASE = process.env.TEST_BASE_URL || 'http://localhost:3100';
const ORIGIN = process.env.TEST_ORIGIN || 'http://localhost:3101';
const db = new Pool({ connectionString: process.env.TEST_DATABASE_URL || 'postgres://argus:argus@localhost:5434/argus' });

// A tiny browser: keeps cookies (respecting Path and expiry) and sends the
// Origin header like a real browser on our web app would.
class Client {
  constructor() { this.cookies = new Map(); } // name -> {value, path, attrs}

  cookieHeader(path) {
    return [...this.cookies.entries()]
      .filter(([, c]) => path.startsWith(c.path))
      .map(([n, c]) => `${n}=${c.value}`).join('; ');
  }

  store(res) {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';').map((s) => s.trim());
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq);
      const value = pair.slice(eq + 1);
      const a = Object.fromEntries(attrs.map((x) => {
        const i = x.indexOf('=');
        return i < 0 ? [x.toLowerCase(), true] : [x.slice(0, i).toLowerCase(), x.slice(i + 1)];
      }));
      const expired = a['max-age'] === '0' || (a.expires && new Date(a.expires) <= new Date());
      if (expired || value === '') this.cookies.delete(name);
      else this.cookies.set(name, { value, path: a.path || '/', attrs: a });
    }
  }

  async req(method, path, body, { origin = ORIGIN, headers = {} } = {}) {
    const url = `/api/v1${path}`;
    const h = { ...headers };
    if (origin) h.origin = origin;
    const cookie = this.cookieHeader(url);
    if (cookie) h.cookie = cookie;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await fetch(BASE + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    this.store(res);
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  }

  get(p, o) { return this.req('GET', p, undefined, o); }
  post(p, b, o) { return this.req('POST', p, b ?? {}, o); }
  patch(p, b, o) { return this.req('PATCH', p, b, o); }
  put(p, b, o) { return this.req('PUT', p, b, o); }
  del(p, b, o) { return this.req('DELETE', p, b, o); }
}

// Unique test phone per call, so runs never collide and no cleanup is needed.
let seq = 0;
function phone() {
  seq += 1;
  return `+9190${String(Date.now()).slice(-6)}${String(seq).padStart(2, '0')}${Math.floor(Math.random() * 10)}`;
}

async function registered(extra = {}) {
  const c = new Client();
  const p = phone();
  const r = await c.post('/auth/register', { fullName: 'Test User', phone: p, country: 'IN', password: 'sleepwell24', ...extra });
  if (r.status !== 201) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { c, phone: p, user: r.body.user, password: extra.password || 'sleepwell24' };
}

// ---- devices and MQTT ------------------------------------------------
const MQTT_URL = process.env.TEST_MQTT_URL || 'mqtt://localhost:1885';
const MQTT_BACKEND = { username: process.env.MQTT_BACKEND_USERNAME || 'argus-backend',
  password: process.env.MQTT_BACKEND_PASSWORD || 'dev-only-mqtt-password' };

function randomMac() {
  return Array.from({ length: 6 }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, '0')).join('');
}

// Insert a registered (unclaimed) device straight into the DB. Returns {id, mac, serial}.
async function insertDevice({ disabled = false, ownerId = null } = {}) {
  const mac = randomMac();
  const serial = `ARG-T${mac.slice(6).toUpperCase()}`;
  const { rows: [d] } = await db.query(
    `INSERT INTO devices (serial_no, mac, mqtt_username, chip_model, hw_model, is_disabled, owner_id, claimed_at)
     VALUES ($1, $2::macaddr, $3, 'ESP32-S3', 'ARG-S1', $4, $5, CASE WHEN $5::uuid IS NULL THEN NULL ELSE now() END)
     RETURNING id`, [serial, mac, mac, disabled, ownerId]);
  await db.query('INSERT INTO device_settings (device_id) VALUES ($1)', [d.id]);
  return { id: d.id, mac, serial };
}

// Connect like a sensor (MQTT 3.1.1, MAC as username and client id).
// Resolves with the client, rejects with the CONNACK error.
// `will: true` sets the firmware's last will (retained "offline" on <p>/<mac>/status).
function mqttConnect(username, { clientId = username, password = 'x', will = false } = {}) {
  const mqtt = require('mqtt');
  return new Promise((resolve, reject) => {
    const opts = { username, clientId, password, protocolVersion: 4, reconnectPeriod: 0, connectTimeout: 5000 };
    if (will) opts.will = { topic: `argus/${username}/status`, payload: Buffer.from('offline'), qos: 1, retain: true };
    const c = mqtt.connect(MQTT_URL, opts);
    c.once('connect', () => resolve(c));
    c.once('error', (err) => { c.end(true); reject(err); });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A logged-in staff member with the given role (Owner, Developer, Manufacturing, Support).
async function staff(role = 'Owner') {
  const r = await registered();
  await db.query('UPDATE users SET staff_role_id = (SELECT id FROM staff_roles WHERE name = $2) WHERE id = $1', [r.user.id, role]);
  return r;
}

// Register a device through the admin API (as a real factory would). Returns the 201 body.
async function registerDevice(adminClient, extra = {}) {
  const mac = randomMac();
  const r = await adminClient.post('/admin/devices', { mac: mac.match(/.{2}/g).join(':'), chip: 'ESP32-S3', hwModel: 'ARG-S1 rev B', ...extra });
  if (r.status !== 201) throw new Error(`register device failed: ${r.status} ${JSON.stringify(r.body)}`);
  return { ...r.body, mac };
}

// ---- Socket.IO ---------------------------------------------------------
// Open a socket as the logged-in `client` (sends its argus_at cookie and our
// Origin, like the browser). Resolves on connect, rejects on connect_error.
function socketConnect(client, { origin = ORIGIN } = {}) {
  const { io } = require('socket.io-client');
  return new Promise((resolve, reject) => {
    const headers = {};
    if (origin) headers.origin = origin;
    const cookie = client ? client.cookieHeader('/socket.io/') : '';
    if (cookie) headers.cookie = cookie;
    const s = io(BASE, { transports: ['websocket'], extraHeaders: headers, reconnection: false, timeout: 5000 });
    s.once('connect', () => resolve(s));
    s.once('connect_error', (err) => { s.close(); reject(err); });
  });
}

// Wait for the next `event` on a socket that matches `pred` (default: any).
function nextEvent(socket, event, pred = () => true, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { socket.off(event, h); reject(new Error(`timeout waiting for ${event}`)); }, timeoutMs);
    function h(payload) {
      if (!pred(payload)) return;
      clearTimeout(t); socket.off(event, h); resolve(payload);
    }
    socket.on(event, h);
  });
}

// emitWithAck with a timeout.
const ask = (socket, event, payload) => socket.timeout(4000).emitWithAck(event, payload);

module.exports = { BASE, ORIGIN, db, Client, phone, registered, MQTT_URL, MQTT_BACKEND, randomMac, insertDevice, mqttConnect, sleep, socketConnect, nextEvent, ask, staff, registerDevice };
