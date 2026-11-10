'use strict';

const { generateAccessCode } = require('../auth');
const { isValidRole, ROLES } = require('../permissions');
const { generateResetCode, hashSecret } = require('../security/recovery');
const { audit } = require('../audit');
const { logger } = require('../logger');
const { buildInviteEmail } = require('./inviteEmail');
const { maskEmail } = require('./support');

/**
 * Side-effecting operations shared by routes and by governance executors.
 * Kept in one place so a governed action does exactly what the immediate
 * version would have done.
 */
function createActions({ store, media, config, notifier }) {
  /**
   * Remove and revoke one member: disable, end every session, drop group
   * memberships, revoke invite codes they created. A removed GUARDIAN is
   * always told at their own address (before the account is disabled, since
   * disabled accounts get no mail), so a co-guardian cannot lock them out
   * silently. Refuses to remove the last active guardian.
   */
  async function removeMember(targetId, { removedBy } = {}) {
    const target = await store.findUserById(targetId);
    if (!target || target.disabled) {
      return { ok: false, message: 'That member no longer exists or was already removed.' };
    }
    if (target.role === 'parent') {
      const others = (await store.listUsers()).filter(
        (u) => u.role === 'parent' && !u.disabled && u.id !== target.id
      );
      if (others.length === 0) {
        return { ok: false, message: 'The last guardian cannot be removed.' };
      }
      if (notifier) {
        await notifier.notifyUser(target, {
          subject: 'Your guardian access was removed',
          text:
            'Your guardian account was removed and your sessions were ended. ' +
            'If you did not agree to this, contact the other guardian and your hosting provider right away.',
        });
      }
    }
    await store.updateUser(target.id, {
      disabled: true,
      disabledAt: new Date().toISOString(),
      disabledBy: removedBy || null,
      groupIds: [],
    });
    await store.bumpSessionVersion(target.id);
    const revokedCodes = await store.revokeAccessCodesCreatedBy(target.id, removedBy || null);
    return { ok: true, target, revokedCodes, message: `${target.displayName} was removed. Their sessions ended.` };
  }

  /**
   * Complete deletion of one photo: every stored variant (and, on Spaces,
   * every noncurrent version), the record, its album links, comments,
   * reactions and reports. Ledger events stay (leak history) but lose all
   * content. Returns the removed object keys for the audit trail.
   */
  async function deletePhotoCompletely(photoId) {
    const photo = await store.findPhotoById(photoId);
    if (!photo) {
      return null;
    }
    const removedKeys = await media.purge(photo);
    await store.deletePhoto(photoId);
    return { photoId, removedKeys };
  }

  async function createInviteCode({ createdBy, note, groupId, intendedEmail }) {
    let linkedGroupId = null;
    if (groupId) {
      const group = await store.findGroupById(groupId);
      linkedGroupId = group ? group.id : null;
    }
    let code = generateAccessCode();
    for (let i = 0; i < 5 && (await store.findAccessCode(code)); i += 1) {
      code = generateAccessCode();
    }
    return store.createAccessCode({
      code,
      createdBy,
      note,
      groupId: linkedGroupId,
      intendedEmail: intendedEmail || null,
      expiresAt: new Date(Date.now() + config.security.accessCodeTtlMs).toISOString(),
    });
  }

  /**
   * Email an open invite code to the person it is for. Called when a governed
   * code is created (approval or the solo delay) and from "Send by email".
   * Never throws: returns { ok, masked, reason }. The audit entry and logs
   * carry only a masked address, never the code.
   */
  async function emailInviteCode(accessCode, { to, firstName, sentBy, req } = {}) {
    const masked = maskEmail(to);
    if (!notifier || !notifier.emailAvailable()) {
      return { ok: false, masked, reason: 'not_configured' };
    }
    const inviter = sentBy ? await store.findUserById(sentBy) : null;
    const message = buildInviteEmail({
      appName: config.app.name,
      origin: config.publicOrigin,
      code: accessCode.code,
      inviterName: inviter ? inviter.displayName : null,
      firstName,
      expiresAt: accessCode.expiresAt,
      timeZone: config.app.timeZone,
    });
    try {
      await notifier.sendEmail({ to, subject: message.subject, text: message.text, html: message.html });
    } catch (err) {
      logger.warn({ err: { type: err && err.name } }, 'invite email failed');
      await audit(store, req, 'invite.email_failed', { targetType: 'accessCode', details: { to: masked } });
      return { ok: false, masked, reason: 'failed' };
    }
    await audit(store, req, 'invite.emailed', {
      targetType: 'accessCode',
      details: { to: masked, ...(req ? {} : { requestedBy: sentBy || null }) },
    });
    return { ok: true, masked };
  }

  /**
   * Issue a one-time sign-in reset code for an account (forgotten password,
   * lost 2FA phone). The code is returned ONCE for the guardian to hand over
   * in person or by phone; only its hash is stored. Older unused codes for
   * the account are revoked, and the account owner is emailed.
   *
   * For a GUARDIAN the code only starts working after a delay
   * (guardianResetDelayMs, 24 hours in production). They are emailed at once
   * and can cancel it from Settings, Security, so one guardian cannot quietly
   * take over the other's account. (A governed approval cannot work here: the
   * guardian who lost their phone is exactly the one who cannot sign in.)
   */
  async function issueResetCode(targetId, { issuedBy } = {}) {
    const target = await store.findUserById(targetId);
    if (!target || target.disabled) {
      return { ok: false, message: 'That member no longer exists or was removed.' };
    }
    await store.revokeResetCodesForUser(target.id);
    const isGuardian = target.role === 'parent';
    const now = Date.now();
    const delayMs = isGuardian ? config.security.guardianResetDelayMs : 0;
    const code = generateResetCode();
    await store.createResetCode({
      codeHash: hashSecret(code),
      userId: target.id,
      createdBy: issuedBy || null,
      notBefore: new Date(now + delayMs).toISOString(),
      expiresAt: new Date(now + delayMs + config.security.resetCodeTtlMs).toISOString(),
    });
    const delayHours = Math.round(delayMs / 3600000);
    if (notifier) {
      await notifier.notifyUser(target, {
        subject: 'A sign-in reset code was issued for your account',
        text:
          'A guardian issued a one-time code to reset your password and two-step verification. ' +
          (isGuardian && delayMs > 0
            ? `It starts working in ${delayHours} hours. If you did not ask for this, sign in and cancel it under Settings, Security, then contact the other guardian. `
            : 'If you did not ask for this, tell the guardians right away. '),
      });
      if (isGuardian) {
        await notifier.notifyGuardians(store, {
          subject: 'A guardian sign-in reset was issued',
          text: `A reset code was issued for guardian ${target.displayName}.`,
          excludeUserId: issuedBy,
        });
      }
    }
    const hours = Math.round(config.security.resetCodeTtlMs / 3600000);
    const when = delayMs > 0 ? `It starts working in ${delayHours} hours, then works once for ${hours} hours` : `It works once, for ${hours} hours`;
    return {
      ok: true,
      code,
      target,
      message:
        `Reset code for ${target.displayName}: ${code}. ${when}. ` +
        'Give it to them in person or by phone, never by email or text. They use it at /reset.',
    };
  }

  const executors = {
    'photos.update': async ({ ids, changes }) => {
      const count = await store.bulkUpdatePhotos(ids, changes);
      return { message: `${count} photo(s) updated.` };
    },
    'photos.delete': async ({ ids }) => {
      let count = 0;
      for (const id of ids) {
        if (await deletePhotoCompletely(id)) {
          count += 1;
        }
      }
      return { message: `${count} photo(s) permanently deleted.` };
    },
    'group.addMember': async ({ groupId, userId }) => {
      const user = await store.addUserToGroup(userId, groupId);
      return { message: user ? 'Member added to group.' : 'That member or group no longer exists.' };
    },
    // Runs on approval, on the solo delay (runDue), or at once with no delay.
    // A declined, cancelled or expired request never gets here, so nothing is
    // emailed. The email is built from the code in hand at creation time.
    'accessCode.create': async ({ note, groupId, intendedEmail, sendEmail, firstName }, { requestedBy, req }) => {
      const ac = await createInviteCode({ createdBy: requestedBy, note, groupId, intendedEmail });
      let message = `Invite code created: ${ac.code}`;
      if (sendEmail && ac.intendedEmail) {
        const sent = await emailInviteCode(ac, { to: ac.intendedEmail, firstName, sentBy: requestedBy, req });
        message += sent.ok
          ? `. It was emailed to ${sent.masked}.`
          : `. It could not be emailed (${sent.reason === 'not_configured' ? 'email is not set up' : 'sending failed'}), so share it yourself.`;
      }
      return { message, code: ac.code };
    },
    'user.setRole': async ({ userId, role }) => {
      if (!isValidRole(role)) {
        return { message: 'Unknown role.' };
      }
      // Last line of defense: the support role is created only on the server.
      const current = await store.findUserById(userId);
      if (role === ROLES.OPERATOR || (current && current.role === ROLES.OPERATOR)) {
        return { message: 'The support account role is managed on the server.' };
      }
      const updated = await store.updateUser(userId, { role });
      if (updated) {
        await store.bumpSessionVersion(userId);
      }
      return { message: updated ? 'Role changed.' : 'That member no longer exists.' };
    },
    // Removing a guardian is governed: one guardian alone could otherwise
    // lock the other out and then act "solo".
    'user.remove': async ({ userId }, { requestedBy }) => {
      const outcome = await removeMember(userId, { removedBy: requestedBy });
      return { message: outcome.message };
    },
    'user.restore': async ({ userId }) => {
      const updated = await store.updateUser(userId, { disabled: false, disabledAt: null, disabledBy: null });
      return { message: updated ? 'Access restored. Group memberships must be re-added.' : 'That member no longer exists.' };
    },
    'archive.erase': async () => {
      const photos = await store.listPhotos();
      for (const p of photos) {
        await deletePhotoCompletely(p.id);
      }
      return { message: `Archive erased (${photos.length} photo(s)).` };
    },
  };

  return { deletePhotoCompletely, createInviteCode, emailInviteCode, removeMember, issueResetCode, executors };
}

module.exports = { createActions };
