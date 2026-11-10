'use strict';

const { createRouter } = require('../security/asyncRouter');
const { requireAuth, verifyPassword } = require('../auth');
const { deriveKey, sealText, openText } = require('../security/secretBox');
const totp = require('../security/totp');
const { qrSvg } = require('../security/qr');
const { generateRecoveryCodes, hashSecret } = require('../security/recovery');
const { audit } = require('../audit');
const { buildZip } = require('../services/zip');
const { str } = require('../validation');

/**
 * Account self-service: privacy notice, two-step verification, sign out
 * everywhere, data export, and account deletion.
 */
module.exports = function accountRoutes(ctx) {
  const { store, config, notifier, requireStepUp } = ctx;
  const router = createRouter();
  const kek = deriveKey(config.encryptionKey);

  // Guardians (when configured) and the support operator (always) keep it on.
  const mfaRequiredFor = (user) =>
    user.role === 'operator' || (user.role === 'parent' && config.parentAuth.requireMfa);

  // --- Privacy notice (public, so invitees can read it before joining) ---

  router.get('/privacy', (req, res) => {
    res.render('privacy', {
      title: 'Privacy notice',
      noticeVersion: config.privacy.noticeVersion,
      downloadRetentionDays: config.privacy.downloadRetentionDays,
      auditRetentionDays: config.privacy.auditDetailRetentionDays,
      needsAccept: Boolean(req.user && req.user.privacyNoticeVersion !== config.privacy.noticeVersion),
    });
  });

  router.post('/privacy/accept', requireAuth, async (req, res) => {
    await store.updateUser(req.user.id, {
      privacyNoticeVersion: config.privacy.noticeVersion,
      privacyAcceptedAt: new Date().toISOString(),
    });
    await audit(store, req, 'privacy.acknowledged', { details: { version: config.privacy.noticeVersion } });
    req.flash('success', 'Thanks for reading the privacy notice.');
    return res.redirect('/home');
  });

  // --- Two-step verification (TOTP) ---

  router.get('/settings/security', requireAuth, async (req, res) => {
    const user = req.user;
    let setup = null;
    if (!user.mfaEnabled) {
      // A provisional secret lives in the session until confirmed with a code.
      if (!req.session.mfaSetupSecret) {
        req.session.mfaSetupSecret = totp.generateSecret();
      }
      const secret = req.session.mfaSetupSecret;
      const uri = totp.otpauthUri({ secret, account: user.email, issuer: config.app.name });
      setup = {
        secret: secret.replace(/(.{4})/g, '$1 ').trim(),
        uri,
        // Rendered here and inlined in this authenticated, no-store page only.
        qrSvg: await qrSvg(uri),
      };
    }
    // Freshly issued recovery codes are shown exactly once, then forgotten.
    const newRecoveryCodes = req.session.newRecoveryCodes || null;
    delete req.session.newRecoveryCodes;
    res.render('security', {
      title: 'Security',
      user,
      setup,
      mfaRequired: mfaRequiredFor(user),
      newRecoveryCodes,
      recoveryCodesLeft: (user.mfaRecoveryCodes || []).length,
    });
  });

  // Step-up: a hijacked session must not be able to bind its own
  // authenticator and lock the real owner out.
  router.post('/settings/security/mfa/enable', requireAuth, requireStepUp, async (req, res) => {
    const user = req.user;
    const secret = req.session.mfaSetupSecret;
    if (!secret || user.mfaEnabled) {
      return res.redirect('/settings/security');
    }
    const counter = totp.verify(secret, str(req.body.code, { field: 'code', max: 12 }));
    if (counter < 0) {
      req.flash('error', 'That code did not match. Check the time on your phone and try again.');
      return res.redirect('/settings/security');
    }
    const recoveryCodes = generateRecoveryCodes();
    await store.updateUser(user.id, {
      mfaEnabled: true,
      mfaSecretSealed: sealText(kek, secret, `mfa:${user.id}`),
      mfaLastCounter: counter,
      mfaRecoveryCodes: recoveryCodes.map(hashSecret),
      mustEnrollMfa: false,
    });
    delete req.session.mfaSetupSecret;
    req.session.newRecoveryCodes = recoveryCodes;
    await audit(store, req, 'account.mfa_enabled', { targetType: 'user', targetId: user.id });
    req.flash('success', 'Two-step verification is on. Save your recovery codes now.');
    return res.redirect('/settings/security');
  });

  router.post('/settings/security/mfa/disable', requireAuth, async (req, res) => {
    const user = req.user;
    if (mfaRequiredFor(user)) {
      req.flash('error', 'This account must keep two-step verification on.');
      return res.redirect('/settings/security');
    }
    const password = str(req.body.password, { field: 'password', max: 1024, trim: false });
    const secret = user.mfaSecretSealed ? openText(kek, user.mfaSecretSealed, `mfa:${user.id}`) : null;
    const counter = secret ? totp.verify(secret, str(req.body.code, { field: 'code', max: 12 })) : -1;
    if (!(await verifyPassword(password, user.passwordHash)) || counter < 0) {
      req.flash('error', 'Enter your password and a current code to turn this off.');
      return res.redirect('/settings/security');
    }
    await store.updateUser(user.id, { mfaEnabled: false, mfaSecretSealed: null, mfaLastCounter: -1, mfaRecoveryCodes: [] });
    await audit(store, req, 'account.mfa_disabled', { targetType: 'user', targetId: user.id });
    req.flash('success', 'Two-step verification is off.');
    return res.redirect('/settings/security');
  });

  // New recovery codes replace every old one (use after printing went missing
  // or most codes are used up).
  router.post('/settings/security/recovery-codes', requireAuth, requireStepUp, async (req, res) => {
    if (!req.user.mfaEnabled) {
      return res.redirect('/settings/security');
    }
    const recoveryCodes = generateRecoveryCodes();
    await store.updateUser(req.user.id, { mfaRecoveryCodes: recoveryCodes.map(hashSecret) });
    req.session.newRecoveryCodes = recoveryCodes;
    await audit(store, req, 'account.recovery_codes_regenerated', { targetType: 'user', targetId: req.user.id });
    req.flash('success', 'New recovery codes are ready. The old ones no longer work.');
    return res.redirect('/settings/security');
  });

  // The account owner can cancel any unused reset code issued for them (for
  // example a guardian reset they did not ask for, during its delay).
  router.post('/settings/security/cancel-reset', requireAuth, async (req, res) => {
    const count = await store.revokeResetCodesForUser(req.user.id);
    if (count > 0) {
      await audit(store, req, 'account.reset_cancelled', { targetType: 'user', targetId: req.user.id, details: { count } });
      await notifier.notifyGuardians(store, {
        subject: 'A sign-in reset was cancelled',
        text: `${req.user.displayName} cancelled a reset code issued for their account.`,
        excludeUserId: req.user.id,
      });
    }
    req.flash('success', count > 0 ? 'Pending reset code cancelled.' : 'There was no pending reset code.');
    return res.redirect('/settings/security');
  });

  // Ends every session for this account, including this one.
  router.post('/settings/security/signout-all', requireAuth, async (req, res, next) => {
    await store.bumpSessionVersion(req.user.id);
    await audit(store, req, 'account.signout_all', { targetType: 'user', targetId: req.user.id });
    req.session.destroy((err) => {
      if (err) {
        return next(err);
      }
      res.clearCookie(config.session.name);
      return res.redirect('/login');
    });
  });

  // --- Export my data (JSON inside a zip) ---

  router.post('/settings/export', requireAuth, async (req, res) => {
    const user = req.user;
    const [comments, reactions, albums, uploads, downloads, videoJobs] = await Promise.all([
      store.listCommentsByUser(user.id),
      store.listReactionsByUser(user.id),
      store.listAlbumsByOwner(user.id),
      store.listPhotosByUploader(user.id),
      store.listDownloadsByUser(user.id),
      store.listVideoJobsByOwnerSince(user.id, new Date(0).toISOString()),
    ]);
    const data = {
      exportedAt: new Date().toISOString(),
      account: {
        id: user.id,
        email: user.email,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        createdAt: user.createdAt,
        mfaEnabled: user.mfaEnabled,
        privacyNoticeVersion: user.privacyNoticeVersion,
        privacyAcceptedAt: user.privacyAcceptedAt,
      },
      comments: comments.map((c) => ({
        photoId: c.photoId,
        body: c.body,
        createdAt: c.createdAt,
        deleted: Boolean(c.deletedAt),
      })),
      reactions: reactions.map((r) => ({ photoId: r.photoId, emoji: r.emoji, createdAt: r.createdAt })),
      albums: albums.map((a) => ({ name: a.name, photoIds: a.photoIds, createdAt: a.createdAt })),
      contributions: uploads.map((p) => ({
        photoId: p.id,
        kind: p.kind || 'photo',
        caption: p.caption,
        createdAt: p.createdAt,
      })),
      // Videos still being processed, or that could not be (kept 7 days).
      videoUploads: videoJobs
        .filter((j) => j.status !== 'done')
        .map((j) => ({ caption: j.caption, status: j.status, reason: j.reason, createdAt: j.createdAt })),
      downloads: downloads.map((d) => ({ photoId: d.photoId, downloadedAt: d.downloadedAt })),
    };
    await audit(store, req, 'account.exported', { targetType: 'user', targetId: user.id });
    const zip = buildZip([{ name: `${config.app.slug}-my-data.json`, data: JSON.stringify(data, null, 2) }]);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${config.app.slug}-my-data.zip"`);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(zip);
  });

  // --- Delete my account ---

  router.post('/settings/delete-account', requireAuth, async (req, res, next) => {
    const user = req.user;
    if (user.role === 'parent') {
      req.flash(
        'error',
        'Guardian accounts are removed by the other guardian (Admin, Members), so the archive is never left without an owner.'
      );
      return res.redirect('/settings');
    }
    const password = str(req.body.password, { field: 'password', max: 1024, trim: false });
    if (str(req.body.confirm) !== 'DELETE' || !(await verifyPassword(password, user.passwordHash))) {
      req.flash('error', 'Type DELETE and enter your password to delete your account.');
      return res.redirect('/settings');
    }
    const contentMode = str(req.body.contentMode) === 'delete' ? 'delete' : 'anonymize';
    await audit(store, req, 'account.deleted', { targetType: 'user', targetId: user.id, details: { contentMode } });
    await store.deleteUser(user.id, { contentMode });
    await notifier.notifyGuardians(store, {
      subject: 'A member deleted their account',
      text: 'A family member deleted their own account.',
    });
    return req.session.destroy((err) => {
      if (err) {
        return next(err);
      }
      res.clearCookie(config.session.name);
      return res.redirect('/login');
    });
  });

  return router;
};
