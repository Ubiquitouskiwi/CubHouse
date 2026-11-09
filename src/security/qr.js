'use strict';

const QRCode = require('qrcode');

/**
 * Server-side QR code for pairing an authenticator app, as inline SVG.
 *
 * The otpauth URI carries the TOTP secret, so it never leaves the server
 * except inside the authenticated enrollment page: no external QR service, no
 * client-side encoder, no image URL a tag could fetch.
 *
 * The library's SVG is not trusted as markup. Only its viewBox size and the
 * path data are taken, each checked against a strict shape, and the <svg> is
 * rebuilt here. Nothing the user typed (email, site name) can reach the
 * markup: it is encoded into the modules, never written as text.
 */

const LIBRARY_SVG =
  /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" viewBox="0 0 (\d{1,3}) \1" shape-rendering="crispEdges">(?:<path fill="#ffffff" d="M0 0h\1v\1H0z"\/>)?<path stroke="#000000" d="([MmHhVv0-9. ]+)"\/><\/svg>\s*$/;

const ARIA_LABEL = 'QR code for your authenticator app';

/** Inline <svg> markup for `text`, black on white with the 4-module quiet zone. */
async function qrSvg(text) {
  const raw = await QRCode.toString(String(text), {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 4,
    color: { dark: '#000000ff', light: '#ffffffff' },
  });
  const m = LIBRARY_SVG.exec(raw);
  if (!m) {
    throw new Error('unexpected QR code output');
  }
  const size = m[1];
  const path = m[2];
  // Inline in HTML, so no xmlns: the parser places <svg> in the SVG namespace.
  return (
    `<svg viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" ` +
    `role="img" aria-label="${ARIA_LABEL}" focusable="false">` +
    `<rect width="${size}" height="${size}" fill="#ffffff"/>` +
    `<path stroke="#000000" d="${path}"/></svg>`
  );
}

module.exports = { qrSvg, ARIA_LABEL };
