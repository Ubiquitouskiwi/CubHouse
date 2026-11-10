'use strict';

const crypto = require('crypto');
const helmet = require('helmet');

/**
 * Security response headers.
 *
 * CSP is strict: scripts only from our origin or carrying this request's
 * nonce (the one inline theme-init script), images only from our own origin
 * (photos are app-gated at /media, never data: URIs or third-party hosts),
 * nothing framed, forms post only to us. No 'unsafe-inline' anywhere.
 */

function nonceMiddleware(req, res, next) {
  res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
  next();
}

function createSecurityHeaders({ isProduction }) {
  const helmetMw = helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
        styleSrc: ["'self'"],
        // blob: is only the local upload preview (an object URL that never
        // leaves the browser). No data:, no third-party image hosts.
        imgSrc: ["'self'", 'blob:'],
        // Videos stream from our own origin (/media/:id/video). blob: is only
        // the uploader reading a picked clip's length in the browser.
        mediaSrc: ["'self'", 'blob:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'none'"],
        ...(isProduction ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    strictTransportSecurity: isProduction
      ? { maxAge: 63072000, includeSubDomains: true, preload: false }
      : false,
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginOpenerPolicy: { policy: 'same-origin' },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    crossOriginEmbedderPolicy: false,
    xFrameOptions: { action: 'deny' },
  });

  function extraHeaders(req, res, next) {
    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=(), payment=(), usb=(), ' +
        'interest-cohort=(), browsing-topics=()'
    );
    // A private family site: never index, never archive, never snippet.
    res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
    next();
  }

  return [nonceMiddleware, helmetMw, extraHeaders];
}

/** Pages carrying family content must not be cached by browsers or proxies. */
function noStore(req, res, next) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  next();
}

module.exports = { createSecurityHeaders, noStore };
