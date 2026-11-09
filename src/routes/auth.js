'use strict';

const { createRouter } = require('../security/asyncRouter');
const { hashPassword, checkCredentials, verifyPassword, redirectIfAuthed } = require('../auth');
const { lockoutKeys, isLocked, registerFailure, clearFailures } = require('../security/authLockout');
const { checkNewPassword } = require('../security/passwordPolicy');
const { deviceFingerprint, clientIp } = require('../security/clientInfo');
const { safeInternalPath } = require('../security/sessionGuard');
const { openText, deriveKey } = require('../security/secretBox');
const totp = require('../security/totp');
const { hashSecret, normalizeCode, isResetCodeShape, isRecoveryCodeShape } = require('../security/recovery');
const { audit } = require('../audit');
const { str, validateEmail, validateDisplayName } = require('../validation');

const GENERIC_LOGIN_ERROR = 'That email and password did not match. Please try again.';
const GENERIC_CODE_ERROR =
  'That access code cannot be used. It may be mistyped, expired, already used, or meant for a different email.';
const GENERIC_RESET_ERROR =
  'That reset code cannot be used. It may be mistyped, expired, already used, not active yet, or for a different email.';
const MFA_PENDING_TTL_MS = 5 * 60 * 1000;

module.exports = function authRoutes(ctx) {
  const { store, config, notifier, limiters } = ctx;
  const router = createRouter();
  const kek = deriveKey(config.encryptionKey);

  /** Establish a fully authenticated session (after password and MFA). */
  function establishSession(req, user, done) {
    req.session.regenerate((err) => {
      if (err) {
        return done(err);
      }
      req.session.userId = user.id;
      req.session.role = user.role;
      req.session.displayName = user.displayName;
      req.session.theme = user.theme || 'system';
      req.session.sessionVersion = user.sessionVersion;
      req.session.authAt = Date.now();
      // A fresh sign-in counts as recent authentication for step-up.
      req.session.stepUpAt = Date.now();
      return done(null);
    });
  }

  async function noteDevice(req, user) {
    const fp = deviceFingerprint(req, config.session.secret);
    const known = user.knownDevices || [];
    if (!known.includes(fp)) {
      await store.updateUser(user.id, { knownDevices: [...known.slice(-19), fp] });
      if (known.length > 0) {
        await notifier.notifyUser(user, {
          subject: 'New sign-in to your account',
          text:
            `Your ${config.app.name} account was just signed in from a new device or network. ` +
            'If this was not you, change your password and use "Sign out everywhere" in Settings.',
        });
        if (user.role === 'parent') {
          await notifier.notifyGuardians(store, {
            subject: 'A guardian signed in from a new device',
            text: `${user.displayName} signed in from a new device or network.`,
            excludeUserId: user.id,
          });
        }
      }
    }
  }

  async function finishLogin(req, res, next, user) {
    await noteDevice(req, user);
    await audit(store, req, 'auth.login', { targetType: 'user', targetId: user.id });
    establishSession(req, user, (err) => {
      if (err) {
        return next(err);
      }
      return res.redirect('/home');
    });
  }

  // --- Sign in ---

  router.get('/login', redirectIfAuthed, (req, res) => {
    res.render('login', { title: 'Sign In', error: null });
  });

  router.post('/login', limiters.loginIpLimiter, limiters.loginLimiter, async (req, res, next) => {
    const email = str(req.body.email, { field: 'email', max: 254 }).toLowerCase();
    const password = str(req.body.password, { field: 'password', max: 1024, trim: false });
    const fail = (status, message) => res.status(status).render('login', { title: 'Sign In', error: message });

    if (!email || !password) {
      return fail(400, 'Email and password are both required.');
    }
    const keys = lockoutKeys(clientIp(req), email);
    if (await isLocked(store, keys)) {
      return fail(429, 'Too many failed attempts. Please wait 15 minutes and try again.');
    }

    const user = await checkCredentials(store, email, password);
    if (!user || user.disabled) {
      const nowLocked = await registerFailure(store, keys, config.security);
      // Looked up only for the audit trail and owner notification; the
      // response is identical whether or not the account exists.
      const account = user || (await store.findUserByEmail(email));
      await audit(store, req, nowLocked ? 'auth.lockout' : 'auth.login_failed', {
        targetType: account ? 'user' : null,
        targetId: account ? account.id : null,
      });
      if (nowLocked && account) {
        await notifier.notifyUser(account, {
          subject: 'Sign-in attempts were blocked',
          text: 'Several wrong passwords were entered for your account, so sign-in is paused for 15 minutes.',
        });
        await notifier.notifyGuardians(store, {
          subject: 'An account was temporarily locked',
          text: 'Repeated failed sign-ins locked a family account for 15 minutes.',
        });
      }
      return fail(401, GENERIC_LOGIN_ERROR);
    }
    await clearFailures(store, keys);

    if (user.mfaEnabled) {
      // Password OK; hold a short-lived pending state until the code checks.
      return req.session.regenerate((err) => {
        if (err) {
          return next(err);
        }
        req.session.mfaPending = { userId: user.id, at: Date.now() };
        return res.redirect('/login/mfa');
      });
    }
    return finishLogin(req, res, next, user);
  });

  router.get('/login/mfa', (req, res) => {
    if (!req.session.mfaPending) {
      return res.redirect('/login');
    }
    return res.render('mfa-challenge', { title: 'Two-step verification', error: null, action: '/login/mfa' });
  });

  router.post('/login/mfa', limiters.loginIpLimiter, async (req, res, next) => {
    const pending = req.session.mfaPending;
    if (!pending || Date.now() - pending.at > MFA_PENDING_TTL_MS) {
      delete req.session.mfaPending;
      req.flash('error', 'Please sign in again.');
      return res.redirect('/login');
    }
    const user = await store.findUserById(pending.userId);
    const code = str(req.body.code, { field: 'code', max: 12 });
    const keys = lockoutKeys(clientIp(req), user ? user.email : '');
    if (!user || user.disabled || !user.mfaEnabled || (await isLocked(store, keys))) {
      delete req.session.mfaPending;
      req.flash('error', 'Please sign in again.');
      return res.redirect('/login');
    }
    // A one-time recovery code (lost phone) works in place of the app code.
    const recovery = normalizeCode(req.body.code);
    if (isRecoveryCodeShape(recovery)) {
      const hash = hashSecret(recovery);
      const remaining = (user.mfaRecoveryCodes || []).filter((h) => h !== hash);
      if (remaining.length === (user.mfaRecoveryCodes || []).length) {
        await registerFailure(store, keys, config.security);
        await audit(store, req, 'auth.mfa_failed', { targetType: 'user', targetId: user.id });
        return res
          .status(401)
          .render('mfa-challenge', { title: 'Two-step verification', error: 'That code did not work.', action: '/login/mfa' });
      }
      await store.updateUser(user.id, { mfaRecoveryCodes: remaining });
      await audit(store, req, 'auth.mfa_recovery_used', { targetType: 'user', targetId: user.id, details: { remaining: remaining.length } });
      await notifier.notifyUser(user, {
        subject: 'A recovery code was used to sign in',
        text: `One of your two-step recovery codes was just used. ${remaining.length} remain. If this was not you, contact the guardians now.`,
      });
      await clearFailures(store, keys);
      delete req.session.mfaPending;
      return finishLogin(req, res, next, user);
    }
    const secret = openText(kek, user.mfaSecretSealed, `mfa:${user.id}`);
    const counter = totp.verify(secret, code);
    if (counter < 0 || counter <= (user.mfaLastCounter ?? -1)) {
      await registerFailure(store, keys, config.security);
      await audit(store, req, 'auth.mfa_failed', { targetType: 'user', targetId: user.id });
      return res
        .status(401)
        .render('mfa-challenge', { title: 'Two-step verification', error: 'That code did not work.', action: '/login/mfa' });
    }
    // Remember the step so the same code cannot be replayed.
    await store.updateUser(user.id, { mfaLastCounter: counter });
    await clearFailures(store, keys);
    delete req.session.mfaPending;
    return finishLogin(req, res, next, user);
  });

  // --- Step-up re-authentication for sensitive actions ---

  router.get('/reauth', (req, res) => {
    if (!req.user) {
      return res.redirect('/login');
    }
    return res.render('reauth', { title: 'Confirm it is you', error: null, needsCode: Boolean(req.user.mfaEnabled) });
  });

  router.post('/reauth', limiters.reauthLimiter, async (req, res) => {
    if (!req.user) {
      return res.redirect('/login');
    }
    const user = req.user;
    const password = str(req.body.password, { field: 'password', max: 1024, trim: false });
    const render = (error) =>
      res.status(401).render('reauth', { title: 'Confirm it is you', error, needsCode: Boolean(user.mfaEnabled) });
    if (!(await verifyPassword(password, user.passwordHash))) {
      await audit(store, req, 'auth.stepup_failed', { targetType: 'user', targetId: user.id });
      return render('That password did not match.');
    }
    if (user.mfaEnabled) {
      const secret = openText(kek, user.mfaSecretSealed, `mfa:${user.id}`);
      const counter = totp.verify(secret, str(req.body.code, { field: 'code', max: 12 }));
      if (counter < 0 || counter <= (user.mfaLastCounter ?? -1)) {
        return render('That code did not work.');
      }
      await store.updateUser(user.id, { mfaLastCounter: counter });
    }
    req.session.stepUpAt = Date.now();
    await audit(store, req, 'auth.stepup', { targetType: 'user', targetId: user.id });
    const back = safeInternalPath(req.session.reauthReturn, '/home');
    delete req.session.reauthReturn;
    req.flash('success', 'Thanks. Please submit your change again.');
    return res.redirect(back);
  });

  // --- Reset sign-in with a guardian-issued one-time code ---

  router.get('/reset', redirectIfAuthed, (req, res) => {
    res.render('reset', { title: 'Reset your sign-in', values: {}, errors: [] });
  });

  router.post('/reset', limiters.accessCodeLimiter, redirectIfAuthed, async (req, res, next) => {
    const email = str(req.body.email, { field: 'email', max: 254 }).toLowerCase();
    const code = normalizeCode(str(req.body.code, { field: 'code', max: 40 }));
    const password = str(req.body.password, { field: 'password', max: 1024, trim: false });
    const confirm = str(req.body.confirm, { field: 'confirm', max: 1024, trim: false });
    const rerender = (message, status = 400) =>
      res.status(status).render('reset', { title: 'Reset your sign-in', values: { email }, errors: [message] });

    if (!email || !code || !password) {
      return rerender('Email, reset code, and a new password are all required.');
    }
    // Both values come from this same request; no stored secret is compared.
    // eslint-disable-next-line security/detect-possible-timing-attacks
    if (password !== confirm) {
      return rerender('Password and confirmation did not match.');
    }
    const pw = await checkNewPassword(password, { email });
    if (!pw.ok) {
      return rerender(pw.error);
    }
    const user = await store.findUserByEmail(email);
    const used =
      user && !user.disabled && isResetCodeShape(code)
        ? await store.consumeResetCode(hashSecret(code), { userId: user.id })
        : null;
    if (!used) {
      await audit(store, req, 'account.reset_failed', { targetType: user ? 'user' : null, targetId: user ? user.id : null });
      // One message for every failure, so the form does not reveal accounts.
      return rerender(GENERIC_RESET_ERROR);
    }
    // A reset replaces the password AND two-step verification (the usual
    // reason is a lost phone), and ends every existing session.
    await store.updateUser(user.id, {
      passwordHash: await hashPassword(password),
      mustChangePassword: false,
      mfaEnabled: false,
      mfaSecretSealed: null,
      mfaLastCounter: -1,
      mfaRecoveryCodes: [],
    });
    await store.bumpSessionVersion(user.id);
    await clearFailures(store, lockoutKeys(clientIp(req), email));
    await audit(store, req, 'account.reset_redeemed', { targetType: 'user', targetId: user.id });
    await notifier.notifyUser(user, {
      subject: 'Your sign-in was reset',
      text: 'Your password was reset with a one-time code and two-step verification was turned off. Other devices were signed out.',
    });
    await notifier.notifyGuardians(store, {
      subject: 'A sign-in reset code was used',
      text: `${user.displayName} reset their sign-in with a one-time code.`,
      excludeUserId: user.id,
    });
    return req.session.regenerate((err) => {
      if (err) {
        return next(err);
      }
      req.flash('success', 'Your sign-in was reset. Sign in with your new password.');
      return res.redirect('/login');
    });
  });

  // --- Register (requires a valid access code) ---

  router.get('/register', redirectIfAuthed, (req, res) => {
    res.render('register', { title: 'Create Account', values: {}, errors: [] });
  });

  router.post(
    '/register',
    limiters.registerLimiter,
    limiters.accessCodeLimiter,
    redirectIfAuthed,
    async (req, res, next) => {
      const email = str(req.body.email, { field: 'email', max: 254 }).toLowerCase();
      const displayNameRaw = str(req.body.displayName, { field: 'displayName' });
      const password = str(req.body.password, { field: 'password', max: 1024, trim: false });
      const confirm = str(req.body.confirm, { field: 'confirm', max: 1024, trim: false });
      const accessCode = str(req.body.accessCode, { field: 'accessCode', max: 40 }).toUpperCase();
      const acknowledged = str(req.body.acknowledgePrivacy) === 'on';

      const rerender = (message, status = 400) =>
        res.status(status).render('register', {
          title: 'Create Account',
          values: { email, displayName: displayNameRaw, accessCode },
          errors: [message],
        });

      if (!email || !password || !accessCode) {
        return rerender('Email, password, and access code are all required.');
      }
      const emailCheck = validateEmail(email);
      if (!emailCheck.ok) {
        return rerender(emailCheck.error);
      }
      const nameCheck = validateDisplayName(displayNameRaw || email.split('@')[0], { role: 'user' });
      if (!nameCheck.ok) {
        return rerender(nameCheck.error);
      }
      // Both values come from this same request; no stored secret is compared.
      // eslint-disable-next-line security/detect-possible-timing-attacks
      if (password !== confirm) {
        return rerender('Password and confirmation did not match.');
      }
      const pw = await checkNewPassword(password, { email });
      if (!pw.ok) {
        return rerender(pw.error);
      }
      if (!acknowledged) {
        return rerender('Please read and acknowledge the privacy notice to join.');
      }

      // Claim the code atomically BEFORE creating the account, so parallel
      // requests with one code can create at most one account.
      const claimed = await store.claimAccessCode(accessCode, { email });
      if (!claimed) {
        await audit(store, req, 'invite.redeem_failed');
        return rerender(GENERIC_CODE_ERROR);
      }

      // A REMOVED account still holds its email. A guardian's fresh invite
      // (governed) may bring that person back: free the email on the old,
      // disabled record, which keeps its history (download ledger, audit)
      // for leak tracing, and create a new account below.
      const previous = await store.findUserByEmail(email);
      if (previous && previous.disabled) {
        await store.updateUser(previous.id, { email: `removed-${previous.id}@removed.invalid` });
        await audit(store, req, 'invite.reused_removed_email', { targetType: 'user', targetId: previous.id });
      }

      let user;
      try {
        user = await store.createUser({
          email,
          passwordHash: await hashPassword(password),
          displayName: nameCheck.value,
          role: 'user',
          groupIds: claimed.groupId ? [claimed.groupId] : [],
          privacyNoticeVersion: config.privacy.noticeVersion,
        });
      } catch (err) {
        await store.releaseAccessCode(accessCode);
        if (err.code === 'USER_EXISTS') {
          // Same message as a bad code: do not confirm which emails exist.
          return rerender(GENERIC_CODE_ERROR);
        }
        throw err;
      }
      await store.consumeAccessCode(accessCode, user.id);
      await audit(store, req, 'invite.redeemed', {
        targetType: 'user',
        targetId: user.id,
        details: { groupId: claimed.groupId || null },
      });
      await notifier.notifyGuardians(store, {
        subject: 'An invite code was used',
        text: `${user.displayName} joined using an invite code${claimed.note ? ` ("${claimed.note}")` : ''}.`,
      });

      await store.updateUser(user.id, { knownDevices: [deviceFingerprint(req, config.session.secret)] });
      // Regenerate the session on registration (prevents session fixation).
      return establishSession(req, user, (err) => {
        if (err) {
          return next(err);
        }
        req.flash('success', 'Welcome. Your account has been created.');
        return res.redirect('/home');
      });
    }
  );

  // --- Sign out ---

  router.post('/logout', async (req, res, next) => {
    if (req.session.userId) {
      await audit(store, req, 'auth.logout', { targetType: 'user', targetId: req.session.userId });
    }
    req.session.destroy((err) => {
      if (err) {
        return next(err);
      }
      res.clearCookie(config.session.name);
      return res.redirect('/login');
    });
  });

  return router;
};
