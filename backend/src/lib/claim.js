// Sticker claim codes and serial numbers (docs/API.md §3 "QR and claim
// code", §8.4).
//   code: 12 chars from an alphabet without look-alikes (0/O, 1/I/L, U),
//         shown as XXXX-XXXX-XXXX, about 58 bits. Only HMAC(pepper) is stored.
//   QR:   "ARG1:<code>" and nothing else, so a normal phone scanner learns
//         nothing about the device.
const crypto = require('crypto');
const QRCode = require('qrcode');
const { hmac, encrypt, decrypt } = require('./crypto');

const ALPHABET = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LEN = 12;
const QR_PREFIX = 'ARG1';

function newCode() {
  let out = '';
  while (out.length < CODE_LEN) {
    const b = crypto.randomBytes(1)[0];
    if (b < ALPHABET.length * Math.floor(256 / ALPHABET.length)) out += ALPHABET[b % ALPHABET.length];
  }
  return out;
}

// What people type: lower case, dashes, spaces. Returns null if not a code.
function normalizeCode(s) {
  const c = String(s || '').toUpperCase().replace(/[\s-]/g, '');
  return c.length === CODE_LEN && [...c].every((ch) => ALPHABET.includes(ch)) ? c : null;
}

const formatCode = (c) => c.match(/.{4}/g).join('-');
const hashCode = (c) => hmac('claim', c);
const qrPayload = (c) => `${QR_PREFIX}:${c}`;
// Encrypted copy for reprinting the sticker (devices.claim_code_enc).
const sealCode = (c) => encrypt(c, 'claim-sticker');
const openCode = (buf) => decrypt(buf, 'claim-sticker');

// "ARG1:K7P29XQM4HTR" -> "K7P29XQM4HTR", or null.
function codeFromQr(qr) {
  const m = /^ARG1:(.+)$/i.exec(String(qr || '').trim());
  return m ? normalizeCode(m[1]) : null;
}

const qrPng = async (c) => (await QRCode.toBuffer(qrPayload(c), { errorCorrectionLevel: 'M', margin: 1, scale: 8 })).toString('base64');

// Next serial "ARG-" + 7 chars (D8 still open; this format is easy to change):
//   ARG-<YY><letter><4 digits>, e.g. ARG-26A0001. The letter goes A..Z after
//   each 9999 devices in a year. Call inside a transaction that holds the
//   serial advisory lock (see routes/admin/devices.js).
async function nextSerial(c, now = new Date()) {
  const yy = String(now.getUTCFullYear()).slice(-2);
  const { rows } = await c.query(
    `SELECT serial_no FROM devices WHERE serial_no ~ $1 ORDER BY serial_no DESC LIMIT 1`, [`^ARG-${yy}[A-Z][0-9]{4}$`]);
  let letter = 'A';
  let n = 1;
  if (rows[0]) {
    letter = rows[0].serial_no[6];
    n = parseInt(rows[0].serial_no.slice(7), 10) + 1;
    if (n > 9999) {
      if (letter === 'Z') throw new Error('serial range for this year is full');
      letter = String.fromCharCode(letter.charCodeAt(0) + 1);
      n = 1;
    }
  }
  return `ARG-${yy}${letter}${String(n).padStart(4, '0')}`;
}

module.exports = { sealCode, openCode, newCode, normalizeCode, formatCode, hashCode, qrPayload, codeFromQr, qrPng, nextSerial, QR_PREFIX };
