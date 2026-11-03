const http = require('http');
const config = require('./config');
const db = require('./db');
const log = require('./logger');
const { createApp } = require('./app');

async function main() {
  if (!(await db.ping())) {
    log.fatal('cannot reach PostgreSQL, check DATABASE_URL');
    process.exit(1);
  }

  // Boot order (same as Water Tank): DB → app → Socket.IO → live → MQTT → scheduler.
  // Socket.IO, MQTT and the scheduler are added in the next build steps.
  const app = createApp();
  const server = http.createServer(app);
  server.listen(config.port, () => log.info({ port: config.port }, 'argus backend listening'));

  const shutdown = (signal) => {
    log.info({ signal }, 'shutting down');
    server.close(() => db.pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((err) => {
  log.fatal({ err }, 'boot failed');
  process.exit(1);
});
