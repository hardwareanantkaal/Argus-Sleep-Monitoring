const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const config = require('./config');
const db = require('./db');
const log = require('./logger');
const { ApiError } = require('./errors');

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

  const api = express.Router();
  api.use(cors({ origin: config.corsOrigins, credentials: true }));
  api.use(express.json({ limit: '200kb' }));
  api.use(cookieParser());

  // Route modules are mounted here as they are built (docs/API.md §1–§9).

  api.use((req, res) => {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such endpoint' } });
  });
  app.use('/api/v1', api);

  // Central error handler. Express 5 forwards async errors here by itself.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof ApiError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, field: err.field } });
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
