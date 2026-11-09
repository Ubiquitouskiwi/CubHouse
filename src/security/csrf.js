'use strict';

const { csrfSync } = require('csrf-sync');

/**
 * CSRF protection: synchronizer token stored in the server-side session.
 * Replaces the deprecated and archived `csurf` package.
 *
 * Every mutating form posts `_csrf`. The multipart upload route parses its
 * body (fields included) before this middleware runs, so its token is read
 * from `req.body._csrf` the same way. A header is accepted for fetch() calls.
 */
function createCsrf() {
  const { csrfSynchronisedProtection, generateToken } = csrfSync({
    getTokenFromRequest: (req) =>
      (req.body && typeof req.body._csrf === 'string' && req.body._csrf) ||
      req.get('x-csrf-token') ||
      undefined,
    errorConfig: {
      statusCode: 403,
      message: 'Invalid or missing CSRF token.',
      code: 'EBADCSRFTOKEN',
    },
  });
  return { protect: csrfSynchronisedProtection, generateToken };
}

module.exports = { createCsrf };
