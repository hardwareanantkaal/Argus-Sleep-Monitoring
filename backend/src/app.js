const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const config = require('./config');
const db = require('./db');
const log = require('./logger');
const { ApiError } = require('./errors');
const { checkOrigin } = require('./middleware/origin');
const { requireUser } = require('./middleware/auth');

function createApp({ mqttConnected = () => false } = {}) {
  const app = express();
  app.set('trust proxy', config.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet());

  // Health check: used by Docker and by us after every deploy step.
  app.get('/health', async (req, res) => {
    const dbOk = await db.ping();
    const mqttOk = mqttConnected();
    res.status(dbOk ? 200 : 503).json({ ok: dbOk, db: dbOk, mqtt: mqttOk });
  });

  // Mosquitto go-auth hooks: private addresses only, outside /api/v1.
  app.use('/mqtt', require('./routes/mqttAuth').router);
  // Firmware downloads for OTA (signed link from the MQTT ota message).
  app.use('/fw', require('./routes/firmwareFiles'));

  const api = express.Router();
  api.use(cors({ origin: config.corsOrigins, credentials: true }));
  api.use(express.json({ limit: '200kb' }));
  api.use(cookieParser());
  api.use(checkOrigin);

  // Route modules (docs/API.md §1–§9), mounted as they are built.
  api.use('/auth', require('./routes/auth'));
  api.use('/me', require('./routes/me'));
  api.use('/devices', require('./routes/devices').router);
  api.use('/devices', require('./routes/shares').router);
  api.use('/devices', require('./routes/alerts').rules);
  api.use('/alerts', require('./routes/alerts').list);
  api.use('/invites', require('./routes/invites'));
  api.use('/vendor', require('./routes/vendor').router);
  const admin = express.Router();
  admin.use(requireUser);
  admin.use(require('./routes/admin/devices'));
  admin.use(require('./routes/admin/firmware'));
  admin.use(require('./routes/admin/factory'));
  admin.use(require('./routes/admin/team'));
  admin.use(require('./routes/admin/customers'));
  admin.use(require('./routes/admin/vendors'));
  api.use('/admin', admin);

  api.use((req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint' } });
  });
  app.use('/api/v1', api);

  // Central error handler. Express 5 forwards async errors here by itself.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      if (err.retryAfterS) res.set('Retry-After', String(err.retryAfterS));
      return res.status(err.status).json({ error: {
        code: err.code, message: err.message, field: err.field, retryAfterS: err.retryAfterS } });
    }
    if (err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Request body is not valid JSON' } });
    }
    log.error({ err, path: req.path }, 'unhandled error');
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong' } });
  });

  return app;
}

module.exports = { createApp };
