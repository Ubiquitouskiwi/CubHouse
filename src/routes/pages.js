'use strict';

const { createRouter } = require('../security/asyncRouter');
const { requireAuth, hashPassword, verifyPassword } = require('../auth');
const { portalCapabilities, photoCapabilities, canViewPhoto, ROLE_LABELS, PHOTO_AUDIENCE } = require('../permissions');
const { checkNewPassword } = require('../security/passwordPolicy');
const { audit } = require('../audit');
const {
  THEMES,
  str,
  normalizeTheme,
  validateUsername,
  validateEmail,
  validateDisplayName,
} = require('../validation');

function viewerFrom(user) {
  return { role: user.role, id: user.id, groupIds: user.groupIds || [], commentsMuted: user.commentsMuted };
}

module.exports = function pageRoutes(ctx) {
  const { store, config, notifier } = ctx;
  const router = createRouter();

  router.get('/', (req, res) => res.redirect(req.session && req.session.userId ? '/home' : '/login'));

  router.get('/home', requireAuth, async (req, res) => {
    const user = req.user;
    const can = portalCapabilities(user.role);

    let stats = null;
    if (can.viewAllUsers) {
      const [users, accessCodes] = await Promise.all([store.listUsers(), store.listAccessCodes()]);
      const now = Date.now();
      const open = accessCodes.filter(
        (c) => !c.usedBy && !c.revokedAt && (!c.expiresAt || Date.parse(c.expiresAt) > now)
      );
      stats = {
        memberCount: users.filter((u) => !u.disabled).length,
        openCodeCount: open.length,
        usedCodeCount: accessCodes.filter((c) => c.usedBy).length,
      };
    }

    const viewer = viewerFrom(user);
    const [allPhotos, myAlbums] = await Promise.all([store.listPhotos(), store.listAlbumsByOwner(user.id)]);
    const visiblePhotos = allPhotos.filter((p) => canViewPhoto(viewer, p));
    const photoCan = photoCapabilities(viewer);

    let pendingPhotos = [];
    let governancePending = [];
    let groups = [];
    let profiles = [];
    if (photoCan.setPermissions) {
      pendingPhotos = allPhotos.filter((p) => p.pendingApproval === true);
      governancePending = await store.listGovernanceRequests({ status: 'pending' });
      [groups, profiles] = await Promise.all([store.listGroups(), store.listUploadProfiles()]);
    }

    res.render('home', {
      title: 'Home',
      user,
      can,
      photoCan,
      roleLabel: ROLE_LABELS[user.role] || user.role,
      stats,
      photoCount: visiblePhotos.length,
      albumCount: myAlbums.length,
      recentPhotos: visiblePhotos.slice(0, 6),
      recentAlbums: myAlbums.slice(0, 4),
      myUploads: allPhotos
        .filter((p) => p.uploadedBy === user.id)
        .slice(0, 6)
        .map((p) => ({ ...p, visibleToMe: canViewPhoto(viewer, p) })),
      pendingPhotos,
      governancePending,
      groups,
      profiles,
      audiences: PHOTO_AUDIENCE,
    });
  });

  router.get('/settings', requireAuth, async (req, res) => {
    res.render('settings', { title: 'Settings', user: req.user, themes: THEMES });
  });

  // Profile. Changing the sign-in email requires the current password, since
  // whoever controls the email controls account recovery.
  router.post('/settings/profile', requireAuth, async (req, res) => {
    const user = req.user;
    const nameCheck = validateDisplayName(req.body.displayName, { role: user.role });
    if (!nameCheck.ok) {
      req.flash('error', nameCheck.error);
      return res.redirect('/settings');
    }
    const emailCheck = validateEmail(req.body.email);
    if (!emailCheck.ok) {
      req.flash('error', emailCheck.error);
      return res.redirect('/settings');
    }
    const changes = { displayName: nameCheck.value };
    const emailChanged = emailCheck.value.toLowerCase() !== user.email;
    if (emailChanged) {
      const current = str(req.body.currentPassword, { field: 'currentPassword', max: 1024, trim: false });
      if (!(await verifyPassword(current, user.passwordHash))) {
        req.flash('error', 'Enter your current password to change your email.');
        return res.redirect('/settings');
      }
      changes.email = emailCheck.value;
    }
    const rawUsername = str(req.body.username, { field: 'username' });
    if (rawUsername) {
      const usernameCheck = validateUsername(rawUsername);
      if (!usernameCheck.ok) {
        req.flash('error', usernameCheck.error);
        return res.redirect('/settings');
      }
      changes.username = usernameCheck.value;
    } else if (user.username) {
      changes.username = '';
    }

    try {
      const updated = await store.updateUser(user.id, changes);
      req.session.displayName = updated.displayName;
      if (emailChanged) {
        await audit(store, req, 'account.email_changed', { targetType: 'user', targetId: user.id });
        // Tell the OLD address, so a hijacked session cannot quietly take over.
        await notifier.notifyUser(user, {
          subject: 'Your sign-in email was changed',
          text: `The email on your ${config.app.name} account was just changed. If this was not you, contact the parents right away.`,
        });
      }
      req.flash('success', 'Your profile has been updated.');
    } catch (err) {
      if (err.code === 'USER_EXISTS' || err.code === 'USERNAME_EXISTS') {
        req.flash('error', 'That email or username cannot be used. Please choose another.');
      } else {
        throw err;
      }
    }
    return res.redirect('/settings');
  });

  // Password change: verify current, enforce policy, then END every other
  // session (bump sessionVersion) and rotate this one.
  router.post('/settings/password', requireAuth, async (req, res, next) => {
    const user = req.user;
    const current = str(req.body.currentPassword, { field: 'currentPassword', max: 1024, trim: false });
    const nextPw = str(req.body.newPassword, { field: 'newPassword', max: 1024, trim: false });
    const confirm = str(req.body.confirmPassword, { field: 'confirmPassword', max: 1024, trim: false });

    if (!current || !nextPw) {
      req.flash('error', 'Current and new passwords are both required.');
      return res.redirect('/settings');
    }
    if (!(await verifyPassword(current, user.passwordHash))) {
      req.flash('error', 'Your current password is incorrect.');
      return res.redirect('/settings');
    }
    if (nextPw !== confirm) {
      req.flash('error', 'New password and confirmation did not match.');
      return res.redirect('/settings');
    }
    const policy = await checkNewPassword(nextPw, { email: user.email });
    if (!policy.ok) {
      req.flash('error', policy.error);
      return res.redirect('/settings');
    }

    await store.updateUser(user.id, { passwordHash: await hashPassword(nextPw), mustChangePassword: false });
    const bumped = await store.bumpSessionVersion(user.id);
    await audit(store, req, 'account.password_changed', { targetType: 'user', targetId: user.id });
    await notifier.notifyUser(user, {
      subject: 'Your password was changed',
      text: `Your ${config.app.name} password was just changed and other devices were signed out.`,
    });

    const keep = { userId: user.id, role: user.role, displayName: user.displayName, theme: user.theme };
    return req.session.regenerate((err) => {
      if (err) {
        return next(err);
      }
      Object.assign(req.session, keep, {
        sessionVersion: bumped.sessionVersion,
        authAt: Date.now(),
        stepUpAt: Date.now(),
      });
      req.flash('success', 'Your password has been changed. Other devices were signed out.');
      return res.redirect('/settings');
    });
  });

  router.post('/settings/theme', requireAuth, async (req, res) => {
    const theme = normalizeTheme(str(req.body.theme, { field: 'theme' }));
    await store.updateUser(req.user.id, { theme });
    req.session.theme = theme;
    req.flash('success', 'Your appearance preference has been saved.');
    return res.redirect('/settings');
  });

  router.get('/robots.txt', (req, res) => {
    res.type('text/plain').send('User-agent: *\nDisallow: /\n');
  });

  // Readiness, for an external uptime check (liveness is /healthz, in
  // server.js). Reports only coarse states, never data or error text. 503
  // when the database is unreachable, or when email (the channel for security
  // alerts and governance requests) is failing in production, so the monitor
  // alerts a human. Not for a platform health gate: an outage in a dependency
  // is not fixed by restarting or rolling back the app.
  router.get('/readyz', async (req, res) => {
    let database = 'ok';
    try {
      await ctx.store.ping();
    } catch {
      database = 'failing';
    }
    const email = ctx.notifier && ctx.notifier.status ? ctx.notifier.status().email : 'not_configured';
    const healthy = database === 'ok' && !(config.isProduction && email === 'failing');
    res.setHeader('Cache-Control', 'no-store');
    return res.status(healthy ? 200 : 503).json({ status: healthy ? 'ok' : 'degraded', database, email });
  });

  return router;
};
