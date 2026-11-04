const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const config = require('../config');

const BCRYPT_COST = 11;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// HMAC with the server pepper: used for claim codes and invite/reset tokens,
// so a leaked database alone can't be used to guess them.
const hmac = (purpose, s) => crypto.createHmac('sha256', config.hashPepper).update(`${purpose}:${s}`).digest('hex');

// URL-safe random token (32 bytes = 256 bits by default).
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

const hashPassword = (pw) => bcrypt.hash(pw, BCRYPT_COST);
const checkPassword = (pw, hash) => bcrypt.compare(pw, hash);

// Constant-time string compare (no early exit that leaks length/prefix timing).
function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

// Small secrets we must be able to read back (the sticker claim code).
// AES-256-GCM, key derived from HASH_PEPPER with HKDF, so no extra env var.
// Layout: 12-byte IV | 16-byte tag | ciphertext.
const keyFor = (info) => Buffer.from(crypto.hkdfSync('sha256', config.hashPepper, 'argus', info, 32));
function encrypt(text, info) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', keyFor(info), iv);
  const body = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]);
}
function decrypt(buf, info) {
  const d = crypto.createDecipheriv('aes-256-gcm', keyFor(info), buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8');
}

module.exports = { sha256, hmac, randomToken, hashPassword, checkPassword, safeEqual, encrypt, decrypt };
