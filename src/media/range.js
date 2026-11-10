'use strict';

/**
 * Parse an HTTP Range header (RFC 9110, section 14) for a resource of `size`
 * bytes. Only single byte ranges are served, which is all video players
 * (including iOS Safari, which refuses to play without Range support) send.
 *
 * Returns:
 *   null                    no usable Range header: send the whole resource (200)
 *   { start, end }          inclusive byte positions to send (206)
 *   'unsatisfiable'         a valid range that lies wholly past the end (416)
 *
 * A malformed header or a multi-range request is ignored (null), as the RFC
 * allows, rather than refused.
 */
function parseRange(header, size) {
  if (typeof header !== 'string' || !Number.isSafeInteger(size) || size < 1) {
    return null;
  }
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) {
    return null;
  }
  if (m[1] === '') {
    // Suffix: the last N bytes.
    const n = Number(m[2]);
    if (!Number.isSafeInteger(n)) {
      return null;
    }
    if (n === 0) {
      return 'unsatisfiable';
    }
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Number(m[2]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
    return null;
  }
  if (start >= size) {
    return 'unsatisfiable';
  }
  if (end < start) {
    return null;
  }
  return { start, end: Math.min(end, size - 1) };
}

module.exports = { parseRange };
