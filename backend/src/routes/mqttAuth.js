// Mosquitto go-auth HTTP hooks (docs/API.md §11). The broker POSTs JSON:
//   /mqtt/user       {username, password, clientid}
//   /mqtt/acl        {username, clientid, topic, acc}   acc: 1 read, 2 write, 3 both, 4 subscribe
//   /mqtt/superuser  always denied (superusers are disabled)
// 200 = allow, 403 = deny. Mounted OUTSIDE /api/v1, accepted from private
// addresses only (the broker on the Docker network); Nginx also returns 404
// for /mqtt in production.
const express = require('express');
const config = require('../config');
const db = require('../db');
const log = require('../logger');
const { safeEqual } = require('../lib/crypto');

const router = express.Router();
const P = config.mqtt.topicPrefix;
const MAC_RE = /^[0-9a-f]{12}$/;

// Topic suffixes after <p>/<mac>/ (API.md §11 ACL).
const DEVICE_PUBLISH = new Set(['status', 'info', 'state', 'event', 'session', 'cmd/ack', 'logs', 'settings/ack', 'ota/status']);
const DEVICE_SUBSCRIBE = new Set(['cmd', 'settings/set', 'ota', 'session/ack']);

// Is this device allowed on the broker? Cached 10 s; forget() clears an entry
// at once (e.g. when an admin disables the device).
const cache = new Map(); // mac -> {ok, at}
async function deviceAllowed(mac) {
  const hit = cache.get(mac);
  if (hit && Date.now() - hit.at < 10_000) return hit.ok;
  const row = await db.one('SELECT is_disabled FROM devices WHERE mqtt_username = $1', [mac]);
  const ok = !!row && !row.is_disabled;
  cache.set(mac, { ok, at: Date.now() });
  return ok;
}
const forget = (mac) => cache.delete(mac);

function isPrivate(addr = '') {
  const a = addr.replace(/^::ffff:/, '');
  return a === '::1' || a.startsWith('127.') || a.startsWith('10.') || a.startsWith('192.168.')
    || /^172\.(1[6-9]|2[0-9]|3[01])\./.test(a) || a.startsWith('fd') || a.startsWith('fc');
}

router.use((req, res, next) => {
  // The raw socket address, never req.ip: behind a proxy req.ip comes from a
  // header that a caller could set.
  if (!isPrivate(req.socket.remoteAddress)) return res.status(404).end();
  next();
});
router.use(express.json({ limit: '4kb' }));

const isBackend = (u) => u === config.mqtt.username;

router.post('/user', async (req, res) => {
  const { username = '', password = '', clientid = '' } = req.body || {};
  if (isBackend(username)) {
    return res.status(safeEqual(password, config.mqtt.password) ? 200 : 403).end();
  }
  // Devices: MAC only, no password (decision C1). The client id must be the
  // MAC too, so one sensor can't log in under another's name.
  if (!MAC_RE.test(username) || clientid !== username) return res.status(403).end();
  const ok = await deviceAllowed(username);
  if (!ok) log.info({ mac: username }, 'mqtt login refused');
  res.status(ok ? 200 : 403).end();
});

router.post('/superuser', (req, res) => res.status(403).end());

router.post('/acl', async (req, res) => {
  const { username = '', clientid = '', topic = '', acc } = req.body || {};
  if (isBackend(username)) return res.status(200).end();
  if (!MAC_RE.test(username) || clientid !== username) return res.status(403).end();

  const own = `${P}/${username}/`;
  if (!topic.startsWith(own) || /[+#]/.test(topic)) return res.status(403).end();
  const suffix = topic.slice(own.length);
  const allowed = acc === 2 ? DEVICE_PUBLISH.has(suffix)
    : acc === 1 || acc === 4 ? DEVICE_SUBSCRIBE.has(suffix)
      : false;
  if (allowed && !(await deviceAllowed(username))) return res.status(403).end();
  res.status(allowed ? 200 : 403).end();
});

module.exports = { router, forget, DEVICE_PUBLISH, DEVICE_SUBSCRIBE };
