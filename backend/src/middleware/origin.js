// CSRF guard (docs/API.md §0). Cookies are SameSite=Lax; on top of that every
// request that changes something must come from one of our own web origins.
// Browsers always send Origin on POST/PATCH/PUT/DELETE, and a page on another
// site can't fake it.
const config = require('../config');
const { E } = require('../errors');

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

function checkOrigin(req, res, next) {
  if (SAFE.has(req.method)) return next();
  const origin = req.get('origin');
  if (!origin || !config.corsOrigins.includes(origin)) {
    throw E.forbidden('BAD_ORIGIN', 'Request did not come from the Argus web app');
  }
  next();
}

module.exports = { checkOrigin };
