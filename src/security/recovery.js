'use strict';

const crypto = require('crypto');

/**
 * Account recovery secrets. Both kinds are high-entropy random values from a
 * CSPRNG, so a single SHA-256 (not bcrypt) is enough to store them: nobody
 * can brute-force 60 bits offline in useful time. Only the hash is stored.
 *
 *   Reset code     RESET-XXXX-XXXX-XXXX (60 bits). Issued by a guardian for
 *                  one account; single use; expires (default 24 hours).
 *   Recovery code  XXXXX-XXXXX (50 bits). Ten are issued when 2FA is turned
 *                  on; each works once in place of an authenticator code.
 */

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RESET_RE = /^RESET-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const RECOVERY_RE = /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/;
const RECOVERY_CODE_COUNT = 10;

function randomGroup(length) {
  return Array.from({ length }, () => ALPHABET[crypto.randomInt(0, ALPHABET.length)]).join('');
}

function hashSecret(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

/** Upper-case and drop spaces, so codes typed or read aloud still match. */
function normalizeCode(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/\s+/g, '');
}

function generateResetCode() {
  return `RESET-${randomGroup(4)}-${randomGroup(4)}-${randomGroup(4)}`;
}

function isResetCodeShape(value) {
  return RESET_RE.test(value);
}

function generateRecoveryCodes(count = RECOVERY_CODE_COUNT) {
  return Array.from({ length: count }, () => `${randomGroup(5)}-${randomGroup(5)}`);
}

function isRecoveryCodeShape(value) {
  return RECOVERY_RE.test(value);
}

/**
 * Temporary password issued by the support operator: XXXX-XXXX-XXXX-XXXX
 * (80 bits). It becomes the account's password (bcrypt, like any other), is
 * shown once, works until it expires, and must be changed at first sign-in.
 */
function generateTempPassword() {
  return `${randomGroup(4)}-${randomGroup(4)}-${randomGroup(4)}-${randomGroup(4)}`;
}

module.exports = {
  generateResetCode,
  isResetCodeShape,
  generateRecoveryCodes,
  isRecoveryCodeShape,
  generateTempPassword,
  hashSecret,
  normalizeCode,
  RECOVERY_CODE_COUNT,
};
