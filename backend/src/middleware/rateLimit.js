// In-memory failure counter. Fine for ONE backend instance (same as Water
// Tank); running several instances would need Redis instead.
const { E } = require('../errors');

const buckets = new Map(); // key -> { count, resetAt }

function hit(key, windowMs) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b || b.resetAt <= now) {
    b = { count: 0, resetAt: now + windowMs };
    buckets.set(key, b);
  }
  b.count += 1;
  return b;
}

// limiter.check(key) throws 429 when the key already used up its tries;
// limiter.fail(key) counts one failure; limiter.reset(key) clears it on success.
function limiter({ max, windowMs }) {
  return {
    check(key) {
      const b = buckets.get(key);
      if (b && b.resetAt > Date.now() && b.count >= max) {
        const err = E.tooMany();
        err.retryAfterS = Math.ceil((b.resetAt - Date.now()) / 1000);
        throw err;
      }
    },
    fail(key) { hit(key, windowMs); },
    reset(key) { buckets.delete(key); },
  };
}

// Drop expired buckets now and then so the map can't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
}, 60_000).unref();

const limits = {
  login: limiter({ max: 5, windowMs: 10 * 60_000 }),       // per phone + IP
  claim: limiter({ max: 5, windowMs: 10 * 60_000 }),       // per user
  invite: limiter({ max: 10, windowMs: 10 * 60_000 }),     // per IP
};

module.exports = { limiter, limits };
