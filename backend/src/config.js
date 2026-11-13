// All environment variables are read here and nowhere else.
// Outside production a missing value falls back to a dev default;
// in production a missing required value stops the server at boot.
require('dotenv').config();

const isProd = process.env.NODE_ENV === 'production';

function required(name, devDefault) {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (isProd) throw new Error(`Missing required env var ${name}`);
  return devDefault;
}

function int(name, def) {
  const v = process.env[name];
  return v === undefined || v === '' ? def : parseInt(v, 10);
}

module.exports = {
  isProd,
  port: int('BACKEND_PORT', 3100),
  logLevel: process.env.LOG_LEVEL || 'info',
  logPretty: process.env.LOG_PRETTY === 'true',
  trustProxy: int('TRUST_PROXY', 0),
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3101')
    .split(',').map((s) => s.trim()).filter(Boolean),

  databaseUrl: required('DATABASE_URL', 'postgres://argus:argus@localhost:5434/argus'),
  migrationsDir: process.env.MIGRATIONS_DIR || require('path').join(__dirname, '../../database/migrations'),

  jwtSecret: required('JWT_SECRET', 'dev-only-jwt-secret-change-me'),
  hashPepper: required('HASH_PEPPER', 'dev-only-pepper-change-me'),
  accessTokenTtlS: int('ACCESS_TOKEN_TTL_S', 15 * 60),
  refreshTokenTtlDays: int('REFRESH_TOKEN_TTL_DAYS', 30),
  // Secure cookies need https; on by default in production, off for http://localhost.
  cookieSecure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : isProd,
  // Invite and reset links are built from this, so production must set it.
  publicBaseUrl: required('PUBLIC_BASE_URL', 'http://localhost:3101').replace(/\/+$/, ''),
  // Web Push for alerts: off in v1 (alerts are in-app only).
  webPushEnabled: process.env.WEB_PUSH_ENABLED === 'true',

  mqtt: {
    url: required('MQTT_URL', 'mqtt://localhost:1885'),
    username: required('MQTT_BACKEND_USERNAME', 'argus-backend'),
    password: required('MQTT_BACKEND_PASSWORD', 'dev-only-mqtt-password'),
    clientId: process.env.MQTT_CLIENT_ID || 'argus-backend',
    topicPrefix: process.env.MQTT_TOPIC_PREFIX || 'argus',
  },

  deviceStaleS: int('DEVICE_STALE_S', 30),   // firmware keepalive 15 s

  // OTA: where uploaded .bin files live, how long a download link works, and
  // the address sensors use to fetch firmware (the gateway serves /fw/).
  otaDir: process.env.OTA_DIR || require('path').join(__dirname, '../../ota'),
  otaTokenTtlS: int('OTA_TOKEN_TTL_S', 600),
  otaMaxBytes: int('OTA_MAX_BYTES', 4 * 1024 * 1024),
  // Factory image (merged .bin = the whole flash) for the manufacturing station
  factoryMaxBytes: int('FACTORY_MAX_BYTES', 16 * 1024 * 1024),
  fwBaseUrl: (process.env.FW_BASE_URL || process.env.PUBLIC_BASE_URL || 'http://localhost:3100').replace(/\/+$/, ''),
  commandTtlS: int('COMMAND_TTL_S', 30),
};
