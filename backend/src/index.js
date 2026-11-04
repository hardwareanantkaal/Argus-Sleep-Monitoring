const http = require('http');
const config = require('./config');
const db = require('./db');
const log = require('./logger');
const { createApp } = require('./app');
const mqtt = require('./services/mqtt');
const realtime = require('./services/realtime');
const live = require('./services/live');
const sleep = require('./services/sleep');
const deviceViews = require('./services/deviceViews');
const settingsSync = require('./services/settingsSync');
const commands = require('./services/commands');
const ota = require('./services/ota');

async function main() {
  if (!(await db.ping())) {
    log.fatal('cannot reach PostgreSQL, check DATABASE_URL');
    process.exit(1);
  }

  // Boot order (same as Water Tank): DB → app → Socket.IO → live → MQTT → scheduler.
  // The scheduler is added in a later build step.
  // The HTTP server starts before MQTT because the broker's login hook
  // (/mqtt/user) has to answer the backend's own MQTT login.
  const app = createApp({ mqttConnected: mqtt.isConnected });
  const server = http.createServer(app);
  realtime.attach(server);
  live.start();
  sleep.start();
  settingsSync.start();
  commands.start();
  ota.start();
  deviceViews.setLastNight(sleep.lastNight);
  server.listen(config.port, () => {
    log.info({ port: config.port }, 'argus backend listening');
    mqtt.start();
  });

  const shutdown = (signal) => {
    log.info({ signal }, 'shutting down');
    server.close(() => mqtt.stop().finally(() => db.pool.end().finally(() => process.exit(0))));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log.fatal({ err }, 'boot failed');
  process.exit(1);
});
