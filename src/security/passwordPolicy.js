'use strict';

const crypto = require('crypto');
const config = require('../config');

/**
 * Password policy.
 *
 * - Minimum length (default 12). Length beats composition rules.
 * - Maximum 72 BYTES: bcrypt silently ignores anything past 72 bytes, so a
 *   longer password would give a false sense of strength.
 * - Breached-password check against Have I Been Pwned using k-anonymity: only
 *   the first 5 hex chars of the SHA-1 are sent, never the password or its
 *   full hash. If the API is unreachable the check fails OPEN (logged), so an
 *   outage cannot lock the family out.
 */

const MAX_BYTES = 72;

async function isBreached(password, { fetchImpl = globalThis.fetch } = {}) {
  if (!config.security.breachedPasswordCheck || typeof fetchImpl !== 'function') {
    return false;
  }
  const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    const res = await fetchImpl(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true', 'User-Agent': 'family-photos-password-check' },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      return false;
    }
    const text = await res.text();
    return text.split('\n').some((line) => {
      const [hashSuffix, count] = line.trim().split(':');
      return hashSuffix === suffix && Number(count) > 0;
    });
  } catch {
    return false;
  }
}

/**
 * Validate a new password. Returns { ok: true } or { ok: false, error }.
 * `context` lets the caller reject passwords equal to the email.
 */
async function checkNewPassword(password, { email, fetchImpl } = {}) {
  const value = typeof password === 'string' ? password : '';
  const min = config.security.passwordMinLength;
  if (value.length < min) {
    return { ok: false, error: `Password must be at least ${min} characters.` };
  }
  if (Buffer.byteLength(value, 'utf8') > MAX_BYTES) {
    return { ok: false, error: 'Password must be 72 bytes or fewer.' };
  }
  if (email && value.toLowerCase() === String(email).toLowerCase()) {
    return { ok: false, error: 'Password cannot be the same as your email.' };
  }
  if (await isBreached(value, { fetchImpl })) {
    return {
      ok: false,
      error:
        'That password has appeared in a known data breach. Please choose a different one.',
    };
  }
  return { ok: true };
}

module.exports = { checkNewPassword, isBreached, MAX_BYTES };
