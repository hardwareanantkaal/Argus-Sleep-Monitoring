// The backend's own MQTT connection (docs/API.md §11).
// Subscribes to every device → server topic and hands each message to the
// handler registered for its suffix:
//   mqtt.on('state', (mac, payload, packet) => {...})     payload = Buffer
//   mqtt.publish(mac, 'cmd', {id: 812, c: 'reboot'}, {qos: 1})
const mqttLib = require('mqtt');
const config = require('../config');
const log = require('../logger');
const { DEVICE_PUBLISH } = require('../routes/mqttAuth');

const P = config.mqtt.topicPrefix;
const handlers = new Map(); // suffix -> fn
const connectListeners = [];
let client = null;

function on(suffix, fn) {
  if (!DEVICE_PUBLISH.has(suffix)) throw new Error(`not a device topic: ${suffix}`);
  handlers.set(suffix, fn);
}

// Called after every (re)connect, e.g. to re-send pending settings.
function onConnect(fn) { connectListeners.push(fn); }

function topicFor(mac, suffix) { return `${P}/${mac}/${suffix}`; }

// "argus/348518a10f22/cmd/ack" -> {mac, suffix: "cmd/ack"}
function parseTopic(topic) {
  const parts = topic.split('/');
  if (parts.length < 3 || parts[0] !== P) return null;
  return { mac: parts[1], suffix: parts.slice(2).join('/') };
}

async function dispatch(topic, payload, packet) {
  const t = parseTopic(topic);
  const fn = t && handlers.get(t.suffix);
  if (!fn) {
    log.debug({ topic }, 'mqtt message with no handler');
    return;
  }
  try {
    await fn(t.mac, payload, packet);
  } catch (err) {
    log.error({ err, topic }, 'mqtt handler failed');
  }
}

function start() {
  client = mqttLib.connect(config.mqtt.url, {
    clientId: config.mqtt.clientId,
    username: config.mqtt.username,
    password: config.mqtt.password,
    protocolVersion: 4,          // MQTT 3.1.1, same as the sensors
    clean: true,
    keepalive: 30,
    reconnectPeriod: 2000,
    connectTimeout: 10_000,
  });

  client.on('connect', () => {
    log.info({ url: config.mqtt.url }, 'mqtt connected');
    const topics = Object.fromEntries([...DEVICE_PUBLISH].map((s) => [`${P}/+/${s}`, { qos: 1 }]));
    client.subscribe(topics, (err) => {
      if (err) log.error({ err }, 'mqtt subscribe failed');
    });
    for (const fn of connectListeners) Promise.resolve().then(fn).catch((err) => log.error({ err }, 'mqtt onConnect failed'));
  });
  client.on('message', (topic, payload, packet) => { dispatch(topic, payload, packet); });
  client.on('close', () => log.warn('mqtt connection closed'));
  client.on('error', (err) => log.warn({ err: err.message }, 'mqtt error'));
  return client;
}

const isConnected = () => !!client?.connected;

// Publish to one device. Objects are sent as JSON. Resolves when the broker
// has accepted it (QoS 1) or rejects when not connected.
function publish(mac, suffix, payload, { qos = 1, retain = false } = {}) {
  return new Promise((resolve, reject) => {
    if (!isConnected()) return reject(new Error('mqtt not connected'));
    const body = Buffer.isBuffer(payload) || typeof payload === 'string' ? payload : JSON.stringify(payload);
    client.publish(topicFor(mac, suffix), body, { qos, retain }, (err) => (err ? reject(err) : resolve()));
  });
}

function stop() {
  return new Promise((resolve) => (client ? client.end(false, {}, resolve) : resolve()));
}

module.exports = { start, stop, on, onConnect, publish, isConnected, topicFor, parseTopic };
