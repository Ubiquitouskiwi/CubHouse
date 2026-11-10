'use strict';

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');

/**
 * Rate limiters, created per app instance so state never leaks between apps
 * (or tests). In development the limiter state lives in memory at zero cost;
 * when DATABASE_URL is set a shared Postgres-backed store is used so limits
 * hold across multiple instances. Safe boot refuses production on memory.
 *
 * Keys:
 *   - login: IP + identity, plus a separate account-wide lockout (authLockout)
 *     so rotating IPs does not reset the counter for one account.
 *   - register / access codes: IP ONLY. Keying on the submitted email would
 *     let a guesser get a fresh bucket per made-up email.
 */

function identityOf(req) {
  const raw = req.body && (req.body.email || req.body.username);
  return String(raw || '').trim().toLowerCase();
}

function ipKey(req) {
  return ipKeyGenerator(req.ip || '0.0.0.0');
}

// Photos one person may upload per hour. Shown on the upload form so a big
// batch is not a surprise.
const UPLOADS_PER_HOUR = 120;
const INVITE_EMAILS_PER_HOUR = 10;

function createRateLimiters({ storeFactory } = {}) {
  const make = (name, opts) =>
    rateLimit({
      standardHeaders: 'draft-7',
      legacyHeaders: false,
      ...(storeFactory ? { store: storeFactory(name) } : {}),
      handler: (req, res, _next, options) => {
        res.status(options.statusCode);
        // fetch()/XHR callers (the bulk uploader) get a code they can map.
        if (req.accepts(['html', 'json']) === 'json') {
          return res.json({ ok: false, error: { code: 'rate_limited', message: options.message } });
        }
        if (req.accepts('html')) {
          return res.render('error', {
            title: 'Slow down',
            message: options.message,
          });
        }
        return res.send(options.message);
      },
      ...opts,
    });

  return {
    loginLimiter: make('login', {
      windowMs: 15 * 60 * 1000,
      limit: 20,
      keyGenerator: (req) => `${ipKey(req)}:${identityOf(req)}`,
      message: 'Too many sign-in attempts. Please wait a few minutes and try again.',
    }),
    // Per-IP ceiling on sign-in regardless of identity (credential stuffing).
    loginIpLimiter: make('login-ip', {
      windowMs: 15 * 60 * 1000,
      limit: 60,
      keyGenerator: ipKey,
      message: 'Too many sign-in attempts from this network. Please wait and try again.',
    }),
    registerLimiter: make('register', {
      windowMs: 30 * 60 * 1000,
      limit: 10,
      keyGenerator: ipKey,
      message: 'Too many registration attempts. Please wait and try again.',
    }),
    accessCodeLimiter: make('access-code', {
      windowMs: 60 * 60 * 1000,
      limit: 15,
      keyGenerator: ipKey,
      message: 'Too many access-code attempts. Please wait and try again.',
    }),
    // Authenticated write actions: comments and reactions (anti-harassment).
    commentLimiter: make('comment', {
      windowMs: 10 * 60 * 1000,
      limit: 30,
      keyGenerator: (req) => `u:${(req.session && req.session.userId) || ipKey(req)}`,
      message: 'You are posting very quickly. Please wait a few minutes.',
    }),
    uploadLimiter: make('upload', {
      windowMs: 60 * 60 * 1000,
      limit: UPLOADS_PER_HOUR,
      keyGenerator: (req) => `u:${(req.session && req.session.userId) || ipKey(req)}`,
      message: 'Upload limit reached for now. Please try again later.',
    }),
    reauthLimiter: make('reauth', {
      windowMs: 15 * 60 * 1000,
      limit: 10,
      keyGenerator: (req) => `u:${(req.session && req.session.userId) || ipKey(req)}`,
      message: 'Too many confirmation attempts. Please wait and try again.',
    }),
    // Invite codes sent by email, per guardian (counted when the guardian
    // asks, including requests still waiting for approval).
    inviteEmailLimiter: make('invite-email', {
      windowMs: 60 * 60 * 1000,
      limit: INVITE_EMAILS_PER_HOUR,
      keyGenerator: (req) => `u:${(req.session && req.session.userId) || ipKey(req)}`,
      message: 'You have sent a lot of invite emails just now. Please wait an hour and try again.',
    }),
  };
}

module.exports = { createRateLimiters, UPLOADS_PER_HOUR, INVITE_EMAILS_PER_HOUR };
