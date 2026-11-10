'use strict';

const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { createRouter } = require('../security/asyncRouter');
const { requireOperator } = require('../auth');
const { ROLES } = require('../permissions');
const { deriveKey, openText } = require('../security/secretBox');
const totp = require('../security/totp');
const { audit } = require('../audit');
const { str } = require('../validation');
const { ACTIONS, findAction, accountState, performAction } = require('../services/support');

/**
 * Support page for the site's developer (the operator role): see each
 * account's sign-in state and unlock or reset it when a guardian is locked
 * out. Every action needs, in the same request:
 *   - the action word typed out (UNLOCK, RESET PASSWORD, RESET MFA),
 *   - a fresh code from the operator's authenticator (never a recovery
 *     code, never a code already used),
 * and it writes an audit event (actor, target, action, time) that the
 * guardians see in their audit trail, emails the person and the guardians,
 * and shows the person a notice at their next sign-in.
 *
 * The operator cannot act on itself or on another operator account.
 */
module.exports = function supportRoutes(ctx) {
  const { store, config, notifier, limiters } = ctx;
  const router = createRouter();
  const kek = deriveKey(config.encryptionKey);

  // Every Support route reads the account list or one account from the store,
  // so each is rate limited per signed-in user (applied directly in the chain).
  // shortcut: in-process counter, unlike the shared limiters in
  // rateLimiters.js; the operator is one person, so per-instance is enough.
  // Use the Postgres limiter store if the app ever runs several instances.
  const supportLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => `u:${(req.session && req.session.userId) || ipKeyGenerator(req.ip || '0.0.0.0')}`,
    message: 'Too many Support requests. Please wait a few minutes.',
  });

  router.get('/support', supportLimiter, requireOperator, async (req, res) => {
    const now = Date.now();
    const users = await store.listUsers();
    const accounts = await Promise.all(users.map((u) => accountState(store, u, now)));
    res.render('support', { title: 'Support', accounts, actions: ACTIONS, currentUserId: req.user.id });
  });

  /** Resolve the action and target, or say why not (status + message). */
  async function resolve(req) {
    const action = findAction(req.params.action);
    const target = action ? await store.findUserById(req.params.id) : null;
    if (!action || !target) {
      return { status: 404, message: 'That account or action could not be found.' };
    }
    if (target.id === req.user.id || target.role === ROLES.OPERATOR) {
      const message = 'Support actions cannot be used on the support account itself or on another operator.';
      return { status: 403, message, action, target, denied: true };
    }
    if (target.disabled) {
      const message = 'That account was removed by the guardians. Only they can restore it.';
      return { status: 409, message, action, target };
    }
    return { action, target };
  }

  function renderConfirm(res, status, { action, key, state, error }) {
    // The operator's own email, only for the hidden autofill username field.
    const accountEmail = res.req.user.email;
    return res
      .status(status)
      .render('support-confirm', { title: action.label, action, actionKey: key, account: state, error, accountEmail });
  }

  router.get('/support/accounts/:id/:action', supportLimiter, requireOperator, async (req, res) => {
    const r = await resolve(req);
    if (r.status) {
      return res.status(r.status).render('error', { title: 'Not allowed', message: r.message });
    }
    const state = await accountState(store, r.target);
    return renderConfirm(res, 200, { action: r.action, key: r.action.id, state, error: null });
  });

  router.post(
    '/support/accounts/:id/:action',
    supportLimiter,
    requireOperator,
    limiters.reauthLimiter,
    async (req, res) => {
      const operator = req.user;
      const r = await resolve(req);
      if (r.status) {
        if (r.denied) {
          await audit(store, req, 'support.denied', {
            targetType: 'user',
            targetId: r.target.id,
            details: { action: r.action.id },
          });
        }
        return res.status(r.status).render('error', { title: 'Not allowed', message: r.message });
      }
      const { action, target } = r;
      const key = action.id;
      const state = await accountState(store, target);

      const typed = str(req.body.confirm, { field: 'confirm', max: 40 }).toUpperCase().replace(/\s+/g, ' ');
      if (typed !== action.word) {
        return renderConfirm(res, 400, { action, key, state, error: `Type ${action.word} to confirm.` });
      }
      // A fresh authenticator code, checked against the replay counter. A
      // recovery code is not accepted here.
      const secret = openText(kek, operator.mfaSecretSealed, `mfa:${operator.id}`);
      const counter = totp.verify(secret, str(req.body.code, { field: 'code', max: 12 }));
      if (counter < 0 || counter <= (operator.mfaLastCounter ?? -1)) {
        await audit(store, req, 'support.mfa_failed', {
          targetType: 'user',
          targetId: target.id,
          details: { action: key },
        });
        const error = 'That authenticator code did not work. Wait for a new one and try again.';
        return renderConfirm(res, 401, { action, key, state, error });
      }
      await store.updateUser(operator.id, { mfaLastCounter: counter });

      const outcome = await performAction(store, config, action, target);
      await audit(store, req, action.auditType, {
        targetType: 'user',
        targetId: target.id,
        details: { action: key, targetRole: target.role, ...outcome.details },
      });
      const label = action.label.toLowerCase();
      const tempNote = outcome.tempPassword
        ? 'They will give you a temporary password by phone or in person; you choose a new one when you sign in. '
        : '';
      // The email never carries the temporary password.
      await notifier.notifyUser(target, {
        subject: `The site's developer: ${label}`,
        text:
          `The developer who runs ${config.app.name} used the Support page to ${label} on your account. ` +
          tempNote +
          'The guardians were told and it is in the audit trail. ' +
          'If you did not ask for this, tell a guardian right away.',
      });
      await notifier.notifyGuardians(store, {
        subject: `Support action: ${label}`,
        text:
          `${operator.displayName} (the site's developer) used the Support page to ${label} ` +
          `for ${target.displayName}. It is recorded in the audit trail.`,
        excludeUserId: target.id,
      });

      return res.render('support-done', {
        title: action.label,
        action,
        account: await accountState(store, await store.findUserById(target.id)),
        // Shown on this response only. Never stored in plaintext, logged, or emailed.
        tempPassword: outcome.tempPassword || null,
        expiresAt: outcome.expiresAt || null,
      });
    }
  );

  return router;
};
