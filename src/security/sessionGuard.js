'use strict';

/**
 * Per-request session validation: the revocation backbone.
 *
 * On EVERY request with a signed-in session the user is reloaded from the
 * store and the session is refused (ended) when:
 *   - the account no longer exists or is disabled,
 *   - the account's sessionVersion moved on (password change, "sign out
 *     everywhere", or a parent's "remove and revoke"),
 *   - the session is past its absolute lifetime (default 7 days), even if it
 *     stayed active (the 15-minute idle timeout handles inactivity).
 *
 * The role comes from the store, never trusted from the session, so a role
 * change takes effect on the very next request.
 *
 * It also enforces two gates: parents must enroll MFA when required, and an
 * account flagged mustChangePassword (seeded accounts) must change it first.
 */

// /settings itself must be allowed: the password gate redirects there (the
// #password fragment never reaches the server), so leaving it out loops.
const GATE_ALLOW = [
  /^\/logout$/,
  /^\/reauth$/,
  /^\/settings$/,
  /^\/settings\/security(\/|$)/,
  /^\/settings\/password$/,
  /^\/privacy$/,
];

function isAllowedDuringGate(path) {
  return GATE_ALLOW.some((re) => re.test(path));
}

function createSessionGuard({ store, config }) {
  return async function sessionGuard(req, res, next) {
    const session = req.session;
    if (!session || !session.userId) {
      return next();
    }
    const user = await store.findUserById(session.userId);
    const expired =
      !session.authAt || Date.now() - session.authAt > config.session.absoluteLifetimeMs;
    if (!user || user.disabled || user.sessionVersion !== session.sessionVersion || expired) {
      return session.regenerate((err) => {
        if (err) {
          return next(err);
        }
        req.flash('error', expired ? 'Your session expired. Please sign in again.' : 'Please sign in to continue.');
        return res.redirect('/login');
      });
    }

    req.user = user;
    session.role = user.role;
    session.displayName = user.displayName;
    session.theme = user.theme || 'system';

    if (!isAllowedDuringGate(req.path)) {
      if (user.mustChangePassword) {
        req.flash('error', 'Please choose a new password before continuing.');
        return res.redirect('/settings#password');
      }
      if (user.role === 'parent' && config.parentAuth.requireMfa && !user.mfaEnabled) {
        req.flash('error', 'Guardian accounts must turn on two-step verification before continuing.');
        return res.redirect('/settings/security');
      }
    }
    return next();
  };
}

/**
 * Step-up: destructive and exposure-widening actions require a password (and
 * MFA code, if enrolled) confirmation within the last few minutes. A fresh
 * sign-in counts. When it is stale, send the guardian to /reauth and then
 * back to the page they came from to resubmit.
 */
function createRequireStepUp({ config }) {
  return function requireStepUp(req, res, next) {
    const at = req.session && req.session.stepUpAt;
    if (at && Date.now() - at < config.parentAuth.stepUpTtlMs) {
      return next();
    }
    req.session.reauthReturn = safeReturnPath(req, '/home');
    req.flash('error', 'Please confirm it is you before making this change.');
    return res.redirect('/reauth');
  };
}

/**
 * Same-origin relative path from the Referer, or the fallback. Prevents an
 * open redirect through a forged Referer header.
 */
function safeReturnPath(req, fallback) {
  const ref = req.get('referer');
  if (!ref) {
    return fallback;
  }
  try {
    const url = new URL(ref, `http://${req.get('host') || 'localhost'}`);
    if (url.host !== req.get('host')) {
      return fallback;
    }
    const target = `${url.pathname}${url.search}`;
    return target.startsWith('/') && !target.startsWith('//') ? target : fallback;
  } catch {
    return fallback;
  }
}

/** Validate an internal path we stored ourselves (e.g. reauthReturn). */
function safeInternalPath(p, fallback) {
  return typeof p === 'string' && /^\/(?!\/)[\w\-./?=&%#]*$/.test(p) ? p : fallback;
}

module.exports = { createSessionGuard, createRequireStepUp, safeReturnPath, safeInternalPath };
