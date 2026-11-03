const pino = require('pino');
const config = require('./config');

module.exports = pino({
  level: config.logLevel,
  // Never log secrets, even by accident.
  redact: ['req.headers.authorization', 'req.headers.cookie', '*.password', '*.newPassword', '*.token'],
  transport: config.logPretty ? { target: 'pino-pretty' } : undefined,
});
