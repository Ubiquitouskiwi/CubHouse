'use strict';

const crypto = require('crypto');

/**
 * Time-based one-time passwords (RFC 6238 / RFC 4226), SHA-1, 6 digits,
 * 30-second step. Compatible with every common authenticator app. Implemented
 * on Node's crypto so there is no extra dependency in the auth path.
 */

const STEP_SECONDS = 30;
const DIGITS = 6;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += B32[(value << (5 - bits)) & 31];
  }
  return out;
}

function base32Decode(str) {
  const clean = String(str).toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20));
}

function hotp(secret, counter) {
  const key = base32Decode(secret);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = crypto.createHmac('sha1', key).update(msg).digest();
  const offset = mac[mac.length - 1] & 0xf;
  const code =
    ((mac[offset] & 0x7f) << 24) |
    (mac[offset + 1] << 16) |
    (mac[offset + 2] << 8) |
    mac[offset + 3];
  return String(code % 10 ** DIGITS).padStart(DIGITS, '0');
}

function counterAt(timeMs) {
  return Math.floor(timeMs / 1000 / STEP_SECONDS);
}

function generate(secret, timeMs = Date.now()) {
  return hotp(secret, counterAt(timeMs));
}

/**
 * Verify a code, allowing +/- `window` steps of clock drift. Returns the
 * matched counter (so the caller can reject replay of the same step) or -1.
 */
function verify(secret, code, { timeMs = Date.now(), window = 1 } = {}) {
  const candidate = String(code || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(candidate)) {
    return -1;
  }
  const now = counterAt(timeMs);
  for (let delta = -window; delta <= window; delta += 1) {
    const expected = hotp(secret, now + delta);
    if (
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(candidate))
    ) {
      return now + delta;
    }
  }
  return -1;
}

function otpauthUri({ secret, account, issuer = 'Cubhouse' }) {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

module.exports = {
  generateSecret,
  generate,
  verify,
  otpauthUri,
  base32Encode,
  base32Decode,
};
