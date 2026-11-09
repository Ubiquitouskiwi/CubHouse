'use strict';

const crypto = require('crypto');
const sharp = require('sharp');

/**
 * Download tracing, redesigned around privacy for everyone in the picture.
 *
 * The earlier design wrote the downloader's NAME, account UUID, and the photo
 * caption into the file. If that copy ever leaked, it would also expose a
 * grandparent's identity and context about the child. Now:
 *
 *   1. Download ledger (store): the authoritative record, server-side only.
 *   2. Opaque reference token: a random value embedded in the file's EXIF.
 *      It means nothing on its own; a parent pastes a recovered file into
 *      the trace tool and the ledger resolves it. No name, email, UUID, or
 *      caption ever goes into the file.
 *   3. Visible watermark: burned into the pixels (survives screenshots). It
 *      shows a short reference code and a "private family photo" notice, not
 *      the person's name. On by default whenever a parent enables download.
 *
 * Members are told plainly (privacy notice and download button) that
 * downloads are recorded and marked. That disclosure is the real deterrent.
 */

const TOKEN_PREFIX = 'photo-ref:';

function newTraceToken() {
  // 96 bits, URL-safe. Unguessable, so it cannot be forged to frame someone.
  return crypto.randomBytes(12).toString('base64url');
}

/** Short human-readable form shown in the visible watermark. */
function shortRef(token) {
  return String(token).slice(0, 8).toUpperCase();
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function watermarkSvg(width, height, token) {
  const band = Math.max(36, Math.round(height * 0.06));
  const font = Math.round(band * 0.42);
  const label = `Private family photo. Please do not share.  Ref ${shortRef(token)}`;
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
      `<rect x="0" y="${height - band}" width="${width}" height="${band}" fill="rgba(0,0,0,0.55)"/>` +
      `<text x="${Math.round(band * 0.4)}" y="${height - Math.round(band * 0.33)}" ` +
      `font-family="sans-serif" font-size="${font}" fill="#ffffff">${escapeXml(label)}</text>` +
      `<text x="50%" y="50%" text-anchor="middle" font-family="sans-serif" ` +
      `font-size="${Math.round(Math.min(width, height) / 12)}" fill="rgba(255,255,255,0.18)" ` +
      `transform="rotate(-30 ${width / 2} ${height / 2})">${escapeXml(shortRef(token))}</text>` +
      `</svg>`
  );
}

/**
 * Produce the bytes served for one download from the sanitized full-size
 * JPEG. Returns { buffer, metadataEmbedded, watermarkApplied } and reports
 * only what actually happened, so the ledger row is truthful.
 */
async function renderDownload(fullJpeg, { token, watermark }) {
  let img = sharp(fullJpeg);
  let watermarkApplied = false;
  if (watermark) {
    const { width, height } = await sharp(fullJpeg).metadata();
    img = img.composite([{ input: watermarkSvg(width, height, token), top: 0, left: 0 }]);
    watermarkApplied = true;
  }
  const buffer = await img
    .withExif({
      IFD0: {
        ImageDescription: `${TOKEN_PREFIX}${token}`,
        Copyright: 'Private family photo. Not for redistribution.',
      },
    })
    .jpeg({ quality: 90, mozjpeg: true })
    .toBuffer();
  return { buffer, metadataEmbedded: true, watermarkApplied };
}

/** Recover the opaque reference token from a downloaded file, if present. */
async function readTraceToken(buffer) {
  try {
    const meta = await sharp(buffer).metadata();
    if (!meta.exif) {
      return null;
    }
    const match = new RegExp(`${TOKEN_PREFIX}([A-Za-z0-9_-]{16})`).exec(meta.exif.toString('latin1'));
    return match ? match[1] : null;
  } catch {
    return null;
  }
}

module.exports = { newTraceToken, shortRef, renderDownload, readTraceToken, watermarkSvg };
