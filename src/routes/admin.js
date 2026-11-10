'use strict';

const { createRouter } = require('../security/asyncRouter');
const { requireParent, requireDevOrParent } = require('../auth');
const { PHOTO_AUDIENCE, portalCapabilities, isValidPhotoAudience, ROLE_LABELS, ROLES } = require('../permissions');
const { audit, verifyChain } = require('../audit');
const { buildZip } = require('../services/zip');
const { str, strList, validateEmail } = require('../validation');

/**
 * Guardian controls. Dev (development only) may VIEW a reduced dashboard but
 * never sees member emails or unused invite codes, and changes nothing.
 *
 * Immediate (any one guardian):  remove and revoke a member, mute, revoke a
 *   code, remove someone from a group, delete a group, decline requests.
 * Governed (needs the other guardian, or the solo delay):  create invite
 *   codes, add someone to a group, change a role, erase the archive.
 */
module.exports = function adminRoutes(ctx) {
  const { store, config, governance, actions, media, notifier, requireStepUp } = ctx;
  const router = createRouter();

  function flashOutcome(req, outcome, pendingMessage) {
    if (outcome.status === 'pending') {
      req.flash('success', pendingMessage);
    } else {
      req.flash('success', outcome.result.message);
    }
  }

  router.get('/admin', requireDevOrParent, async (req, res) => {
    const can = portalCapabilities(req.user.role);
    const [users, accessCodes, groups, uploadProfiles, governanceRequests, reports] = await Promise.all([
      store.listUsers(),
      store.listAccessCodes(),
      store.listGroups(),
      store.listUploadProfiles(),
      can.manageMembers ? store.listGovernanceRequests() : [],
      can.manageMembers ? store.listReports() : [],
    ]);
    const groupsById = new Map(groups.map((g) => [g.id, g]));
    const usersById = new Map(users.map((u) => [u.id, u]));
    const now = Date.now();
    const codeStatus = (ac) =>
      ac.usedBy
        ? 'used'
        : ac.revokedAt
          ? 'revoked'
          : ac.expiresAt && Date.parse(ac.expiresAt) <= now
            ? 'expired'
            : 'open';

    const memberCountByGroup = new Map();
    for (const u of users) {
      for (const gid of u.groupIds || []) {
        memberCountByGroup.set(gid, (memberCountByGroup.get(gid) || 0) + 1);
      }
    }
    const reportsWithComment = await Promise.all(
      reports.map(async (r) => ({ ...r, comment: r.commentId ? await store.findCommentById(r.commentId) : null }))
    );

    res.render('admin', {
      title: 'Admin',
      can,
      // Dev sees names and roles only: no emails.
      users: users.map((u) => ({
        ...u,
        email: can.viewMemberContact ? u.email : null,
        roleLabel: ROLE_LABELS[u.role] || u.role,
        groupNames: (u.groupIds || []).map((g) => (groupsById.get(g) || {}).name).filter(Boolean),
      })),
      // Dev never sees invite codes.
      accessCodes: can.viewAccessCodes
        ? accessCodes.map((ac) => ({
            ...ac,
            status: codeStatus(ac),
            groupName: ac.groupId ? (groupsById.get(ac.groupId) || {}).name : null,
            usedByName: ac.usedBy ? (usersById.get(ac.usedBy) || {}).displayName || 'Former member' : null,
          }))
        : [],
      groups: groups.map((g) => ({ ...g, memberCount: memberCountByGroup.get(g.id) || 0 })),
      uploadProfiles,
      rawGroups: groups,
      audiences: PHOTO_AUDIENCE,
      governanceRequests: governanceRequests.map((r) => ({
        ...r,
        requestedByName: (usersById.get(r.requestedBy) || {}).displayName || 'A guardian',
        mine: r.requestedBy === req.user.id,
      })),
      reports: reportsWithComment,
      currentUserId: req.user.id,
      codeTtlHours: Math.round(config.security.accessCodeTtlMs / 3600000),
    });
  });

  // --- Invite codes ---

  router.post('/admin/access-codes', requireParent, requireStepUp, async (req, res) => {
    const note = str(req.body.note, { field: 'note', max: 200 });
    const groupId = str(req.body.groupId, { field: 'groupId' }) || null;
    const rawEmail = str(req.body.intendedEmail, { field: 'intendedEmail', max: 254 });
    let intendedEmail = null;
    if (rawEmail) {
      const check = validateEmail(rawEmail);
      if (!check.ok) {
        req.flash('error', check.error);
        return res.redirect('/admin');
      }
      intendedEmail = check.value.toLowerCase();
    }
    const outcome = await governance.requestAction(req, {
      type: 'accessCode.create',
      payload: { note, groupId, intendedEmail },
      summary: `Create an invite code${note ? ` for "${note}"` : ''}${intendedEmail ? ' (bound to one email)' : ''}`,
    });
    flashOutcome(req, outcome, 'Inviting a new member needs the other guardian, so the request is waiting for approval.');
    return res.redirect('/admin');
  });

  router.post('/admin/access-codes/:code/revoke', requireParent, async (req, res) => {
    const revoked = await store.revokeAccessCode(req.params.code, req.user.id);
    if (revoked) {
      await audit(store, req, 'invite.revoked', { targetType: 'accessCode' });
    }
    req.flash(revoked ? 'success' : 'error', revoked ? 'Invite code revoked.' : 'That code cannot be revoked.');
    return res.redirect('/admin');
  });

  // --- Members ---

  // The emergency control: one click, any one guardian, effective at once
  // for family members. Removing a GUARDIAN is governed (the other guardian
  // must agree, or the solo delay applies), so one guardian cannot lock the
  // other out and then approve their own pending requests alone.
  router.post('/admin/members/:id/remove', requireParent, requireStepUp, async (req, res) => {
    const target = await store.findUserById(req.params.id);
    if (!target || target.id === req.user.id || target.disabled) {
      req.flash('error', 'That member cannot be removed here.');
      return res.redirect('/admin');
    }
    const guardians = await governance.activeGuardians();
    if (target.role === ROLES.PARENT && guardians.length <= 1) {
      req.flash('error', 'The last guardian cannot be removed.');
      return res.redirect('/admin');
    }
    if (target.role === ROLES.PARENT) {
      const outcome = await governance.requestAction(req, {
        type: 'user.remove',
        payload: { userId: target.id },
        summary: `Remove guardian ${target.displayName}`,
      });
      flashOutcome(req, outcome, 'Removing a guardian needs the other guardian to agree, so the request is waiting.');
      return res.redirect('/admin');
    }
    const removed = await actions.removeMember(target.id, { removedBy: req.user.id });
    if (!removed.ok) {
      req.flash('error', removed.message);
      return res.redirect('/admin');
    }
    await audit(store, req, 'member.removed', {
      targetType: 'user',
      targetId: target.id,
      details: { revokedCodes: removed.revokedCodes, role: target.role },
    });
    await notifier.notifyGuardians(store, {
      subject: 'A member was removed',
      text: `${req.user.displayName} removed ${target.displayName}. Their sessions were ended and access revoked.`,
      excludeUserId: req.user.id,
    });
    req.flash('success', `${target.displayName} was removed. Their sessions ended immediately.`);
    return res.redirect('/admin');
  });

  // Account recovery: a one-time code that resets the password and 2FA. For
  // a guardian the code is delayed and the guardian is emailed and can cancel
  // it (see actions.issueResetCode).
  router.post('/admin/members/:id/reset-signin', requireParent, requireStepUp, async (req, res) => {
    const target = await store.findUserById(req.params.id);
    // The support account is managed on the server, never reset from here
    // (a reset would hand its powers to whoever issued the code).
    if (!target || target.disabled || target.id === req.user.id || target.role === ROLES.OPERATOR) {
      req.flash('error', 'A reset code cannot be issued for that account here.');
      return res.redirect('/admin');
    }
    const issued = await actions.issueResetCode(target.id, { issuedBy: req.user.id });
    if (issued.ok) {
      await audit(store, req, 'account.reset_issued', {
        targetType: 'user',
        targetId: target.id,
        details: { role: target.role },
      });
    }
    req.flash(issued.ok ? 'success' : 'error', issued.message);
    return res.redirect('/admin');
  });

  // Restoring access widens exposure, so it is governed.
  router.post('/admin/members/:id/restore', requireParent, requireStepUp, async (req, res) => {
    const target = await store.findUserById(req.params.id);
    if (!target || !target.disabled) {
      return res.redirect('/admin');
    }
    const outcome = await governance.requestAction(req, {
      type: 'user.restore',
      payload: { userId: target.id },
      summary: `Restore access for ${target.displayName}`,
    });
    flashOutcome(req, outcome, 'Restoring a member needs the other guardian, so the request is waiting.');
    return res.redirect('/admin');
  });

  router.post('/admin/members/:id/mute', requireParent, async (req, res) => {
    const target = await store.findUserById(req.params.id);
    if (!target || target.role === ROLES.PARENT) {
      return res.redirect('/admin');
    }
    const muted = str(req.body.muted) === 'on';
    await store.updateUser(target.id, { commentsMuted: muted });
    await audit(store, req, muted ? 'member.muted' : 'member.unmuted', { targetType: 'user', targetId: target.id });
    req.flash('success', muted ? `${target.displayName} can no longer comment or react.` : `${target.displayName} can comment again.`);
    return res.redirect('/admin');
  });

  router.post('/admin/members/:id/role', requireParent, requireStepUp, async (req, res) => {
    const target = await store.findUserById(req.params.id);
    const role = str(req.body.role, { field: 'role' });
    const allowed = config.isProduction ? [ROLES.PARENT, ROLES.USER] : [ROLES.PARENT, ROLES.DEV, ROLES.USER];
    // The operator role is never granted or changed from the web.
    if (!target || !allowed.includes(role) || target.id === req.user.id || target.role === ROLES.OPERATOR) {
      req.flash('error', 'That role change is not allowed.');
      return res.redirect('/admin');
    }
    const outcome = await governance.requestAction(req, {
      type: 'user.setRole',
      payload: { userId: target.id, role },
      summary: `Change ${target.displayName}'s role to ${ROLE_LABELS[role] || role}`,
    });
    flashOutcome(req, outcome, 'Role changes need the other guardian, so the request is waiting.');
    return res.redirect('/admin');
  });

  // --- Groups ---

  router.post('/admin/groups', requireParent, async (req, res) => {
    const name = str(req.body.name, { field: 'name', max: 80 });
    if (!name) {
      req.flash('error', 'Give the group a name.');
      return res.redirect('/admin');
    }
    const group = await store.createGroup({ name, note: str(req.body.note, { field: 'note', max: 200 }) });
    await audit(store, req, 'group.created', { targetType: 'group', targetId: group.id });
    req.flash('success', `Group "${group.name}" created.`);
    return res.redirect('/admin');
  });

  router.post('/admin/groups/:id/delete', requireParent, async (req, res) => {
    const deleted = await store.deleteGroup(req.params.id);
    if (deleted) {
      await audit(store, req, 'group.deleted', { targetType: 'group', targetId: req.params.id });
    }
    req.flash(deleted ? 'success' : 'error', deleted ? 'Group deleted.' : 'That group no longer exists.');
    return res.redirect('/admin');
  });

  router.post('/admin/groups/:id/members', requireParent, async (req, res) => {
    const groupId = req.params.id;
    const userId = str(req.body.userId, { field: 'userId' });
    const [group, member] = await Promise.all([store.findGroupById(groupId), store.findUserById(userId)]);
    if (!group || !member) {
      req.flash('error', 'That group or member no longer exists.');
      return res.redirect('/admin');
    }
    if (str(req.body.action) === 'remove') {
      await store.removeUserFromGroup(userId, groupId);
      await audit(store, req, 'group.member_removed', { targetType: 'group', targetId: groupId, details: { userId } });
      req.flash('success', 'Member removed from group.');
      return res.redirect('/admin');
    }
    const outcome = await governance.requestAction(req, {
      type: 'group.addMember',
      payload: { groupId, userId },
      summary: `Add ${member.displayName} to "${group.name}"`,
    });
    flashOutcome(req, outcome, 'Adding someone to a group needs the other guardian, so the request is waiting.');
    return res.redirect('/admin');
  });

  // --- Upload profiles ---

  function readProfileBody(body) {
    const raw = str(body.audienceType, { field: 'audienceType' });
    const audienceType = isValidPhotoAudience(raw) ? raw : PHOTO_AUDIENCE.PARENTS;
    const onOff = (v) => v === 'on' || v === 'true';
    const downloadable = onOff(body.downloadable);
    return {
      name: str(body.name, { field: 'name', max: 80 }),
      downloadable,
      watermark: downloadable ? body.watermarkOff !== 'on' : true,
      audienceType,
      audienceUserIds: audienceType === PHOTO_AUDIENCE.USERS ? strList(body.audienceUserIds) : [],
      audienceGroupIds: audienceType === PHOTO_AUDIENCE.GROUPS ? strList(body.audienceGroupIds) : [],
      commentsEnabled: onOff(body.commentsEnabled),
      reactionsEnabled: onOff(body.reactionsEnabled),
    };
  }

  router.post('/admin/profiles', requireParent, async (req, res) => {
    const fields = readProfileBody(req.body);
    if (!fields.name) {
      req.flash('error', 'Give the upload profile a name.');
      return res.redirect('/admin');
    }
    const profile = await store.createUploadProfile(fields);
    await audit(store, req, 'profile.created', { targetType: 'profile', targetId: profile.id });
    req.flash('success', `Upload profile "${profile.name}" created.`);
    return res.redirect('/admin');
  });

  router.post('/admin/profiles/:id', requireParent, async (req, res) => {
    const fields = readProfileBody(req.body);
    if (!fields.name) {
      req.flash('error', 'An upload profile needs a name.');
      return res.redirect('/admin');
    }
    // Editing a profile never changes existing photos (they hold a copy), so
    // it is not itself an exposure change; applying it to photos is governed.
    const updated = await store.updateUploadProfile(req.params.id, fields);
    if (updated) {
      await audit(store, req, 'profile.updated', { targetType: 'profile', targetId: updated.id });
    }
    req.flash(updated ? 'success' : 'error', updated ? `Upload profile "${updated.name}" updated.` : 'That upload profile no longer exists.');
    return res.redirect('/admin');
  });

  router.post('/admin/profiles/:id/delete', requireParent, async (req, res) => {
    const deleted = await store.deleteUploadProfile(req.params.id);
    if (deleted) {
      await audit(store, req, 'profile.deleted', { targetType: 'profile', targetId: req.params.id });
    }
    req.flash(
      deleted ? 'success' : 'error',
      deleted ? 'Upload profile deleted. Photos keep their current permissions.' : 'That upload profile no longer exists.'
    );
    return res.redirect('/admin');
  });

  // --- Governance decisions ---

  router.post('/admin/governance/:id/approve', requireParent, requireStepUp, async (req, res) => {
    const outcome = await governance.approve(req, req.params.id);
    req.flash(outcome.ok ? 'success' : 'error', outcome.ok ? `Approved. ${outcome.result.message}` : outcome.error);
    return res.redirect('/admin');
  });

  router.post('/admin/governance/:id/decline', requireParent, async (req, res) => {
    const ok = await governance.decline(req, req.params.id);
    req.flash(ok ? 'success' : 'error', ok ? 'Request declined.' : 'That request is no longer pending.');
    return res.redirect('/admin');
  });

  // --- Reports (moderation) ---

  router.post('/admin/reports/:id/resolve', requireParent, async (req, res) => {
    const report = await store.resolveReport(req.params.id, req.user.id);
    if (report && str(req.body.removeComment) === 'on' && report.commentId) {
      await store.softDeleteComment(report.commentId, req.user.id);
    }
    if (report) {
      await audit(store, req, 'report.resolved', { targetType: 'report', targetId: report.id });
    }
    req.flash('success', 'Report resolved.');
    return res.redirect('/admin#reports');
  });

  // --- Audit trail (every guardian can read it; nobody can edit it) ---

  router.get('/admin/audit', requireParent, async (req, res) => {
    const [events, users] = await Promise.all([store.listSecurityAuditEvents(), store.listUsers()]);
    const names = new Map(users.map((u) => [u.id, u.displayName]));
    res.render('audit', {
      title: 'Audit trail',
      chain: verifyChain(events),
      events: events
        .slice(-500)
        .reverse()
        .map((e) => ({ ...e, actorName: e.actorId ? names.get(e.actorId) || 'Former member' : 'System' })),
      retentionDays: config.privacy.auditDetailRetentionDays,
    });
  });

  // --- The child's archive ---

  // Full export: sanitized originals plus captions and who published each.
  router.post('/admin/archive/export', requireParent, requireStepUp, async (req, res) => {
    const photos = await store.listPhotos();
    const entries = [];
    const index = [];
    for (const p of photos) {
      if (p.kind === 'video') {
        // shortcut: videos are listed, not included (phase 1, downloads off). Including them needs a
        // streaming zip (with ZIP64 past 4 GB) instead of this in-memory one; do that in phase 2.
        index.push({
          kind: 'video',
          included: false,
          caption: p.caption,
          createdAt: p.createdAt,
          durationSeconds: Math.round(((p.video && p.video.durationMs) || 0) / 1000),
          publishedBy: p.publishedBy,
          uploadedBy: p.uploadedByName,
        });
        continue;
      }
      const bytes = await media.read(p, 'full');
      if (!bytes) {
        continue;
      }
      const name = `photos/${p.createdAt.slice(0, 10)}-${p.id.slice(0, 8)}.jpg`;
      entries.push({ name, data: bytes });
      index.push({ file: name, caption: p.caption, createdAt: p.createdAt, publishedBy: p.publishedBy, uploadedBy: p.uploadedByName });
    }
    entries.push({ name: 'index.json', data: JSON.stringify({ exportedAt: new Date().toISOString(), photos: index }, null, 2) });
    const videosListed = index.filter((e) => e.kind === 'video').length;
    await audit(store, req, 'archive.exported', { details: { photos: index.length - videosListed, videosListed } });
    await notifier.notifyGuardians(store, {
      subject: 'The photo archive was exported',
      text: `${req.user.displayName} downloaded a full export of the photo archive.`,
      excludeUserId: req.user.id,
    });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${config.app.slug}-archive.zip"`);
    res.setHeader('Cache-Control', 'private, no-store');
    return res.send(buildZip(entries));
  });

  // Erase everything: always needs both guardians (or the solo delay).
  router.post('/admin/archive/erase', requireParent, requireStepUp, async (req, res) => {
    if (str(req.body.confirm) !== 'ERASE') {
      req.flash('error', 'Type ERASE to request erasing the whole archive.');
      return res.redirect('/admin');
    }
    const outcome = await governance.requestAction(req, {
      type: 'archive.erase',
      payload: {},
      summary: 'Permanently erase every photo in the archive',
    });
    flashOutcome(req, outcome, 'Erasing the archive needs the other guardian, so the request is waiting.');
    return res.redirect('/admin');
  });

  return router;
};
