'use strict';

const pino = require('pino');
const config = require('./config');

/**
 * Structured JSON logger with redaction. Anything that could carry family
 * data (bodies, cookies, emails, passwords, image bytes, MFA codes) is
 * removed before a line is written, so logs are safe to ship and retain.
 */
const logger = pino({
  level: config.logging.level,
  base: { app: config.app.slug },
  redact: {
    paths: [
      'req.body',
      'req.headers.cookie',
      'req.headers.authorization',
      'body',
      'password',
      'passwordHash',
      'email',
      'userEmail',
      'mfaSecret',
      'token',
      'code',
      '*.password',
      '*.passwordHash',
      '*.email',
      '*.mfaSecret',
      '*.image',
    ],
    censor: '[redacted]',
  },
});

/** Reduce an Error to what an operator needs, never the request payload. */
function errorFields(err) {
  if (!err) {
    return {};
  }
  return {
    err: {
      type: err.name,
      message: String(err.message || '').slice(0, 500),
      code: err.code,
      stack: config.isProduction ? undefined : err.stack,
    },
  };
}

module.exports = { logger, errorFields };
