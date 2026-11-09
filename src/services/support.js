'use strict';

const { hashPassword } = require('../auth');
const { ROLES, ROLE_LABELS } = require('../permissions');
const { generateTempPassword } = require('../security/recovery');
const { validateEmail, validateDisplayName } = require('../validation');

/**
 * Support operator actions: the break-glass for a family whose only guardian
 * is locked out. The routes (src/routes/support.js) add the typed confirm,
 * the fresh two-step check, the audit event and the notifications; this file
 * holds what each action changes, so the CLI and the tests use the same code.
 *
 * None of these touch photos, albums, comments or groups.
 */

const ACTIONS = Object.freeze({
  unlock: Object.freeze({
    id: 'unlock',
    word: 'UNLOCK',
    label: 'Unlock sign-in',
    auditType: 'support.unlocked',
    effect:
      'Clears the failed-attempt counters and the 15-minute lockout. ' +
      'The password and two-step verification do not change.',
    past: 'unlocked your sign-in after too many failed attempts',
  }),
  'reset-password': Object.freeze({
    id: 'reset-password',
    word: 'RESET PASSWORD',
    label: 'Reset password',
    auditType: 'support.password_reset',
    effect:
      'Replaces the password with a temporary one shown once, signs out every device, and clears the lockout. ' +
      'They must choose a new password when they sign in. Two-step verification does not change.',
    past: 'reset your password',
  }),
  'reset-mfa': Object.freeze({
    id: 'reset-mfa',
    word: 'RESET MFA',
    label: 'Reset two-step verification',
    auditType: 'support.mfa_reset',
    effect:
      'Turns off two-step verification, deletes the recovery codes, and signs out every device. ' +
      'They set it up again at their next sign-in. The password does not change.',
    past: 'reset your two-step verification',
  }),
});

function findAction(key) {
  return Object.hasOwn(ACTIONS, key) ? ACTIONS[key] : null;
}

/** A support-issued temporary password stops working once it expires. */
function tempPasswordExpired(user, now = Date.now()) {
  return Boolean(
    user && user.mustChangePassword && user.tempPasswordExpiresAt && Date.parse(user.tempPasswordExpiresAt) <= now
  );
}

/** The in-app notice shown once at the affected person's next sign-in. */
function supportNoticeText(notice) {
  const action = findAction(notice && notice.action);
  const day = String((notice && notice.at) || '').slice(0, 10);
  return (
    `On ${day || 'a recent day'}, the site's developer ${action ? action.past : 'changed your sign-in'} from the ` +
    'Support page. The guardians were told and it is in the audit trail. ' +
    'If you did not ask for this, tell a guardian right away.'
  );
}

/** "p•••@example.com": enough to match a caller to an account, no more. */
function maskEmail(email) {
  const [local, domain] = String(email || '').split('@');
  return domain ? `${local.charAt(0)}\u2022\u2022\u2022@${domain}` : '\u2022\u2022\u2022';
}

/**
 * Sign-in state of one account, for the Support page. Deliberately only
 * these fields: no groups, no photos, no full email.
 */
async function accountState(store, user, now = Date.now()) {
  const states = await store.listAuthFailureStatesFor(user.email);
  const lockedUntil = Math.max(0, ...states.map((s) => (s.lockedUntil > now ? s.lockedUntil : 0)));
  const accountWide = states.find((s) => s.key === `acct:${user.email}`);
  return {
    id: user.id,
    displayName: user.displayName,
    role: user.role,
    roleLabel: ROLE_LABELS[user.role] || user.role,
    maskedEmail: maskEmail(user.email),
    disabled: Boolean(user.disabled),
    locked: lockedUntil > 0,
    lockedUntil: lockedUntil > 0 ? new Date(lockedUntil).toISOString() : null,
    failedAttempts: accountWide ? accountWide.count : 0,
    mfaEnabled: Boolean(user.mfaEnabled),
    mustChangePassword: Boolean(user.mustChangePassword),
    lastLoginAt: user.lastLoginAt || null,
  };
}

/**
 * What each action changes, keyed by the action's own id. Dispatch goes
 * through this table with an entry from ACTIONS, never the request value.
 * Each handler gets `notices` (the in-app notice list to store) and returns
 * { details, tempPassword? }: details are safe for the audit trail;
 * tempPassword is for the operator's screen only and is never stored in
 * plaintext, logged or emailed.
 */
const HANDLERS = Object.freeze({
  unlock: async (store, config, target, notices) => {
    const cleared = await store.clearAuthFailureStatesFor(target.email);
    await store.updateUser(target.id, { supportNotices: notices });
    return { details: { cleared } };
  },
  'reset-password': async (store, config, target, notices, now) => {
    const tempPassword = generateTempPassword();
    const expiresAt = new Date(now + config.security.resetCodeTtlMs).toISOString();
    await store.updateUser(target.id, {
      passwordHash: await hashPassword(tempPassword),
      mustChangePassword: true,
      tempPasswordExpiresAt: expiresAt,
      supportNotices: notices,
    });
    await store.bumpSessionVersion(target.id);
    await store.clearAuthFailureStatesFor(target.email);
    return { details: { expiresAt }, tempPassword, expiresAt };
  },
  'reset-mfa': async (store, config, target, notices) => {
    await store.updateUser(target.id, {
      mfaEnabled: false,
      mfaSecretSealed: null,
      mfaLastCounter: -1,
      mfaRecoveryCodes: [],
      // Only someone who had it on is asked to set it up again.
      mustEnrollMfa: Boolean(target.mfaEnabled),
      supportNotices: notices,
    });
    await store.bumpSessionVersion(target.id);
    return { details: { hadMfa: Boolean(target.mfaEnabled) } };
  },
});

/** Apply one `action` (an entry of ACTIONS) to `target`. */
async function performAction(store, config, action, target, now = Date.now()) {
  const handler = action && Object.hasOwn(HANDLERS, action.id) ? HANDLERS[action.id] : null;
  if (!handler || ACTIONS[action.id] !== action) {
    throw new Error('unknown support action');
  }
  const notices = [...(target.supportNotices || []), { action: action.id, at: new Date(now).toISOString() }].slice(-10);
  return handler(store, config, target, notices, now);
}

/**
 * Create the support operator account. Only the server CLI calls this
 * (scripts/create-operator.js); no web route can create or grant the role.
 * Returns { ok, user, tempPassword, expiresAt } or { ok: false, message }.
 */
async function createOperatorAccount(store, config, { email, displayName } = {}, now = Date.now()) {
  const emailCheck = validateEmail(email);
  if (!emailCheck.ok) {
    return { ok: false, message: emailCheck.error };
  }
  const nameCheck = validateDisplayName(displayName || 'Site developer', { role: ROLES.OPERATOR });
  if (!nameCheck.ok) {
    return { ok: false, message: nameCheck.error };
  }
  const normalized = emailCheck.value.toLowerCase();
  if (await store.findUserByEmail(normalized)) {
    return {
      ok: false,
      message: 'An account with that email already exists. Use a separate email for the support account.',
    };
  }
  const tempPassword = generateTempPassword();
  const expiresAt = new Date(now + config.security.resetCodeTtlMs).toISOString();
  const user = await store.createUser({
    email: normalized,
    passwordHash: await hashPassword(tempPassword),
    displayName: nameCheck.value,
    role: ROLES.OPERATOR,
    privacyNoticeVersion: config.privacy.noticeVersion,
  });
  await store.updateUser(user.id, { mustChangePassword: true, tempPasswordExpiresAt: expiresAt });
  return { ok: true, user, tempPassword, expiresAt };
}

module.exports = {
  ACTIONS,
  findAction,
  tempPasswordExpired,
  supportNoticeText,
  maskEmail,
  accountState,
  performAction,
  createOperatorAccount,
};
