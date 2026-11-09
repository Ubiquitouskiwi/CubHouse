'use strict';

const crypto = require('crypto');

/**
 * Client network details, minimized.
 *
 * `req.ip` is the ONLY source of the client address. Express derives it from
 * X-Forwarded-For only when `trust proxy` is set to the exact hop count, so a
 * client cannot forge it by sending its own header. Never read the raw header.
 *
 * For the download ledger and audit trail we store a truncated address
 * (IPv4 /24, IPv6 /48): enough to tell "a household in this area" from
 * "somewhere else", without keeping a precise identifier for a year.
 */

function clientIp(req) {
  return (req && req.ip) || null;
}

function truncateIp(ip) {
  if (!ip) {
    return null;
  }
  let addr = String(ip);
  if (addr.startsWith('::ffff:')) {
    addr = addr.slice(7);
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) {
    const parts = addr.split('.');
    return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
  }
  if (addr.includes(':')) {
    // Expand "::" enough to keep the first three hextets.
    const [head] = addr.split('::');
    const groups = head.split(':').filter(Boolean);
    while (groups.length < 3) {
      groups.push('0');
    }
    return `${groups.slice(0, 3).join(':')}::/48`;
  }
  return null;
}

/**
 * A coarse device fingerprint for "new sign-in" notifications: a keyed hash of
 * the truncated IP and the user agent family. Stored only as a hash.
 */
function deviceFingerprint(req, secret) {
  const ua = String((req && req.get && req.get('user-agent')) || '').slice(0, 200);
  const net = truncateIp(clientIp(req)) || '';
  return crypto
    .createHmac('sha256', String(secret || 'fingerprint'))
    .update(`${net}|${ua}`)
    .digest('hex')
    .slice(0, 32);
}

module.exports = { clientIp, truncateIp, deviceFingerprint };
