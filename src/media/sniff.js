'use strict';

/**
 * Magic-byte check for uploaded videos. The file name and the browser's
 * declared type are never trusted; only the first bytes of the file are.
 *
 * Phone videos are ISO base media files (MP4) or QuickTime (MOV). Both start
 * with an `ftyp` box: [4-byte size]['ftyp'][4-byte major brand][4-byte
 * version][compatible brands...]. HEIC/AVIF photos use the same box layout,
 * so image brands are refused explicitly. ffprobe re-checks the real
 * container and codecs once the whole file is in.
 */

const VIDEO_BRANDS = new Set([
  'isom', 'iso2', 'iso3', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'M4VP', 'MSNV',
  'qt  ', '3gp4', '3gp5', '3gp6', '3g2a', 'hvc1', 'dby1', 'XAVC',
]);
// Still images (HEIC, AVIF) and audio-only (M4A) share the ftyp layout.
const NOT_VIDEO_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1', 'avif', 'avis', 'M4A ', 'M4B ', 'M4P ', 'crx ']);

/** Bytes needed to decide (the ftyp box is small; 64 covers its brands). */
const SNIFF_BYTES = 64;

/**
 * Returns { container: 'mp4' | 'mov', brand } for an MP4/MOV, else null.
 */
function sniffVideo(head) {
  if (!Buffer.isBuffer(head) || head.length < 12) {
    return null;
  }
  if (head.toString('latin1', 4, 8) !== 'ftyp') {
    return null;
  }
  const boxSize = head.readUInt32BE(0);
  if (boxSize < 16 || boxSize > 4096) {
    return null;
  }
  const major = head.toString('latin1', 8, 12);
  if (NOT_VIDEO_BRANDS.has(major)) {
    return null;
  }
  const container = major === 'qt  ' ? 'mov' : 'mp4';
  if (VIDEO_BRANDS.has(major)) {
    return { container, brand: major };
  }
  // Unknown major brand: accept only if a compatible brand is a known video one.
  const end = Math.min(boxSize, head.length);
  for (let i = 16; i + 4 <= end; i += 4) {
    const brand = head.toString('latin1', i, i + 4);
    if (NOT_VIDEO_BRANDS.has(brand)) {
      return null;
    }
    if (VIDEO_BRANDS.has(brand)) {
      return { container, brand: major };
    }
  }
  return null;
}

module.exports = { sniffVideo, SNIFF_BYTES };
