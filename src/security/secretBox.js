'use strict';

const crypto = require('crypto');

/**
 * Authenticated symmetric encryption (AES-256-GCM) used for:
 *   - wrapping the family media data key (envelope encryption), and
 *   - encrypting each stored media object with that data key, and
 *   - encrypting MFA (TOTP) secrets at rest.
 *
 * Sealed layout: [1 byte version][12 byte IV][16 byte tag][ciphertext].
 * `aad` (additional authenticated data) binds a ciphertext to its context,
 * e.g. the object key, so a blob cannot be swapped onto a different photo.
 */

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const DEV_KEY_SEED = 'family-photos-dev-only-key-encryption-key';

function deriveKey(material) {
  // Accept a base64 key of 32 bytes directly; otherwise stretch with SHA-256
  // (dev fallback only; safe boot requires a real 32-byte key in production).
  if (material) {
    const raw = Buffer.from(material, 'base64');
    if (raw.length === 32) {
      return raw;
    }
    return crypto.createHash('sha256').update(String(material)).digest();
  }
  return crypto.createHash('sha256').update(DEV_KEY_SEED).digest();
}

function seal(key, plaintext, aad) {
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  if (aad) {
    cipher.setAAD(Buffer.from(aad));
  }
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

function open(key, sealed, aad) {
  if (!Buffer.isBuffer(sealed) || sealed.length < 1 + IV_BYTES + TAG_BYTES) {
    throw new Error('sealed payload is malformed');
  }
  if (sealed[0] !== VERSION) {
    throw new Error('unsupported sealed payload version');
  }
  const iv = sealed.subarray(1, 1 + IV_BYTES);
  const tag = sealed.subarray(1 + IV_BYTES, 1 + IV_BYTES + TAG_BYTES);
  const body = sealed.subarray(1 + IV_BYTES + TAG_BYTES);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  if (aad) {
    decipher.setAAD(Buffer.from(aad));
  }
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body), decipher.final()]);
}

/** Seal a short string to base64 text (for MFA secrets stored on the user). */
function sealText(key, text, aad) {
  return seal(key, Buffer.from(String(text), 'utf8'), aad).toString('base64');
}

function openText(key, b64, aad) {
  return open(key, Buffer.from(String(b64), 'base64'), aad).toString('utf8');
}

module.exports = { deriveKey, seal, open, sealText, openText, DEV_KEY_SEED };
