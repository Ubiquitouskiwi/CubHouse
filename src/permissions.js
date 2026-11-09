'use strict';

/**
 * Central role and permission model for the photo site.
 *
 * This is the single source of truth for what each role may do. The photo
 * system (built next) MUST resolve photo access through `photoCapabilities`
 * rather than checking roles inline, so the one rule below can never drift:
 *
 *   PARENTS have complete control over photos. They are the only role that can
 *   upload, delete, change per-photo permissions, and override download locks.
 *
 *   DEV has more PORTAL privilege than a regular user (it can see admin-style
 *   diagnostics and manage non-photo settings), but with respect to PHOTOS it
 *   is treated EXACTLY like a user. Dev never controls images.
 *
 *   USER is an invited family member: they view photos, build personal albums,
 *   and download only the photos a parent has allowed.
 *
 *   OPERATOR is the site host's support account (the developer who runs the
 *   server). It exists in production, is created only from the server CLI
 *   (scripts/create-operator.js), must use two-step verification, and can
 *   only reach the Support page: unlock an account, reset a password, reset
 *   two-step verification. It sees no photos, albums, comments or family
 *   settings, and no role on the site can grant it.
 *
 * Security and privacy of photos is parent-controlled by design. When in doubt
 * about a photo capability, the answer is "no" unless the role is parent.
 */

const ROLES = Object.freeze({
  PARENT: 'parent',
  DEV: 'dev',
  USER: 'user',
  OPERATOR: 'operator',
});

const ROLE_VALUES = Object.freeze(Object.values(ROLES));

// Human-readable labels for the UI.
const ROLE_LABELS = Object.freeze({
  [ROLES.PARENT]: 'Parent',
  [ROLES.DEV]: 'Developer',
  [ROLES.USER]: 'Family member',
  [ROLES.OPERATOR]: 'Support operator',
});

function isValidRole(role) {
  return ROLE_VALUES.includes(role);
}

function normalizeRole(role) {
  return isValidRole(role) ? role : ROLES.USER;
}

/**
 * Portal-level (non-photo) capabilities. Dev sits between parent and user:
 * it gets elevated portal access (diagnostics, user list, settings) but is
 * never granted photo control here -- that lives in `photoCapabilities`.
 */
function portalCapabilities(role) {
  const r = normalizeRole(role);
  const isParent = r === ROLES.PARENT;
  const isDev = r === ROLES.DEV;
  return Object.freeze({
    // Invite/manage family members and access codes.
    manageMembers: isParent,
    manageAccessCodes: isParent,
    // Elevated, read-oriented portal access for dev; parents get it too.
    viewAdminDashboard: isParent || isDev,
    viewDiagnostics: isParent || isDev,
    viewAllUsers: isParent || isDev,
    // Member emails and unused access codes are guardian-only. A dev seeing
    // an unused code could mint a hidden extra account.
    viewMemberContact: isParent,
    viewAccessCodes: isParent,
    // Dev may manage non-photo portal settings; it still cannot touch photos.
    manageSiteSettings: isParent || isDev,
    // The Support page (account unlock and resets) is operator-only.
    useSupportConsole: r === ROLES.OPERATOR,
  });
}

/**
 * How a photo's audience is scoped. A parent sets exactly one of these on each
 * photo to decide who (among non-parents) may see it:
 *
 *   EVERYONE - every signed-in family member can see it.
 *   USERS    - only the explicitly listed user ids.
 *   GROUPS   - only members of the listed groups.
 *
 * Parents always see every photo regardless of audience. Dev is treated as a
 * user for audience purposes, so a photo hidden from users is hidden from dev.
 */
const PHOTO_AUDIENCE = Object.freeze({
  // Private by default: only parents. New photos and approved contributions
  // start here until a parent deliberately shares them.
  PARENTS: 'parents',
  EVERYONE: 'everyone',
  USERS: 'users',
  GROUPS: 'groups',
});

const PHOTO_AUDIENCE_VALUES = Object.freeze(Object.values(PHOTO_AUDIENCE));

function isValidPhotoAudience(audience) {
  return PHOTO_AUDIENCE_VALUES.includes(audience);
}

// An unknown or missing audience fails CLOSED (parents only), never open.
function normalizePhotoAudience(audience) {
  return isValidPhotoAudience(audience) ? audience : PHOTO_AUDIENCE.PARENTS;
}

/**
 * Does the given viewer fall within a photo's shared audience?
 *
 * This is the single gate for "can this non-parent see this photo at all",
 * combining the per-photo `hidden` flag with the audience scope. Parents are
 * resolved as always-true by `canViewPhoto`; this helper answers the audience
 * question for a NON-parent viewer and is kept pure so it is easy to test.
 *
 * `viewer` is { id, groupIds? }. `photo` is
 *   { hidden?, audienceType, audienceUserIds?, audienceGroupIds? }.
 */
function isInPhotoAudience(viewer, photo) {
  if (!photo) {
    return false;
  }
  // A hidden photo is invisible to everyone except parents (handled upstream).
  if (photo.hidden === true) {
    return false;
  }
  // A photo still awaiting a parent's approval is invisible to non-parents
  // too, so a family member's contribution never leaks before it is reviewed.
  // Parents are resolved as always-visible upstream in canViewPhoto.
  if (photo.pendingApproval === true) {
    return false;
  }
  const audience = normalizePhotoAudience(photo.audienceType);
  if (audience === PHOTO_AUDIENCE.PARENTS) {
    return false;
  }
  if (audience === PHOTO_AUDIENCE.EVERYONE) {
    return true;
  }
  if (!viewer) {
    return false;
  }
  if (audience === PHOTO_AUDIENCE.USERS) {
    const ids = Array.isArray(photo.audienceUserIds)
      ? photo.audienceUserIds
      : [];
    return ids.includes(viewer.id);
  }
  if (audience === PHOTO_AUDIENCE.GROUPS) {
    const photoGroups = Array.isArray(photo.audienceGroupIds)
      ? photo.audienceGroupIds
      : [];
    const viewerGroups = Array.isArray(viewer.groupIds) ? viewer.groupIds : [];
    return photoGroups.some((g) => viewerGroups.includes(g));
  }
  return false;
}

/**
 * Can this viewer see this specific photo? Parents always can. A non-parent
 * can only when they fall within the photo's audience and it is not hidden.
 * `viewer` carries { role, id, groupIds? }.
 */
function canViewPhoto(viewer, photo) {
  if (!viewer || !photo) {
    return false;
  }
  if (normalizeRole(viewer.role) === ROLES.PARENT) {
    return true;
  }
  // The support operator never sees family content, whatever the audience.
  if (viewer.role === ROLES.OPERATOR) {
    return false;
  }
  return isInPhotoAudience(viewer, photo);
}

/**
 * Photo capabilities. THIS is the heart of the privacy model.
 *
 * Only parents get any control. Dev is deliberately collapsed to the same
 * shape as user here: regarding images, "dev acts as if it is a user".
 *
 * `viewer` carries { role, id, groupIds? } so audience membership can be
 * resolved. `photo` is optional; when provided its per-photo flags (set by a
 * parent) gate what a non-parent may do with THAT specific image.
 *
 * A photo object is expected to look like:
 *   { uploadedBy, hidden, downloadable, audienceType,
 *     audienceUserIds[], audienceGroupIds[] }
 * Fields are treated conservatively: a missing audience is EVERYONE, but a
 * non-parent still gets no download unless the parent marked it downloadable.
 */
function photoCapabilities(viewer, photo) {
  // Accept a bare role string for backward compatibility with callers that
  // only know the role (e.g. nav gating with no specific photo).
  const v = typeof viewer === 'string' ? { role: viewer } : viewer || {};
  const r = normalizeRole(v.role);
  const isParent = r === ROLES.PARENT;

  // Parent: full control, always.
  if (isParent) {
    return Object.freeze({
      upload: true,
      // Parents may contribute too; it is the same action, never pending.
      contribute: true,
      delete: true,
      setPermissions: true,
      share: true,
      hide: true,
      view: true,
      download: true,
      addToAlbum: true,
    });
  }

  // The support operator gets nothing at all, not even gallery access.
  if (r === ROLES.OPERATOR) {
    return Object.freeze({
      upload: false,
      contribute: false,
      delete: false,
      setPermissions: false,
      share: false,
      hide: false,
      view: false,
      download: false,
      addToAlbum: false,
    });
  }

  // Dev and user are identical for photos. With no photo context the viewer
  // can still reach the gallery (view:true) but gets no per-photo privilege.
  const visible = photo ? canViewPhoto(v, photo) : true;
  const downloadable = photo ? photo.downloadable === true : false;

  return Object.freeze({
    upload: false,
    // A family member MAY contribute photos, but every contribution is owned
    // and controlled by the parents and is held for approval before anyone
    // else can see it. This is distinct from `upload` (parent-only control).
    contribute: true,
    delete: false,
    setPermissions: false,
    share: false,
    hide: false,
    view: visible,
    // A non-parent can only download when the parent marked the photo
    // downloadable AND the viewer is in its audience.
    download: photo ? downloadable && visible : false,
    // Albums are personal; a user/dev may add any photo they can view.
    addToAlbum: visible,
  });
}

/**
 * The fixed palette of emoji reactions. A closed set keeps the UI simple and
 * prevents arbitrary/abusive input: only these values are ever accepted.
 */
const REACTION_EMOJIS = Object.freeze([
  '\u2764\uFE0F', // red heart
  '\uD83D\uDE0A', // smiling face
  '\uD83D\uDE02', // tears of joy
  '\uD83D\uDE2E', // surprised
  '\uD83D\uDE22', // crying
  '\uD83D\uDC4D', // thumbs up
  '\uD83C\uDF89', // party popper
]);

function isValidReactionEmoji(emoji) {
  return REACTION_EMOJIS.includes(emoji);
}

/**
 * Can this viewer post a comment on this photo? Requires that they can view it
 * AND that comments are enabled on the photo. Parents can always comment on a
 * photo they can see; the enabled flag still governs whether the thread is
 * open to anyone (a parent who turned comments off is choosing to close it).
 */
function canComment(viewer, photo) {
  if (!canViewPhoto(viewer, photo)) {
    return false;
  }
  // A parent can mute a member who harasses others in comments.
  if (viewer.commentsMuted === true && normalizeRole(viewer.role) !== ROLES.PARENT) {
    return false;
  }
  return photo.commentsEnabled !== false;
}

/**
 * May this viewer delete this comment? The comment's author may delete their
 * own; a parent may delete any comment on a photo they control.
 */
function canDeleteComment(viewer, comment) {
  if (!viewer || !comment) {
    return false;
  }
  if (normalizeRole(viewer.role) === ROLES.PARENT) {
    return true;
  }
  return comment.userId && comment.userId === viewer.id;
}

/** Can this viewer react on this photo? View access plus reactions enabled. */
function canReact(viewer, photo) {
  if (!canViewPhoto(viewer, photo)) {
    return false;
  }
  if (viewer.commentsMuted === true && normalizeRole(viewer.role) !== ROLES.PARENT) {
    return false;
  }
  return photo.reactionsEnabled !== false;
}

/**
 * Exposure of a photo to non-parents, used by two-guardian governance.
 *   'family'   - visible to every signed-in member
 *   'limited'  - visible to specific people or groups
 *   'none'     - parents only (hidden, pending, or parents audience)
 */
function photoExposure(photo) {
  if (!photo || photo.hidden === true || photo.pendingApproval === true) {
    return 'none';
  }
  const audience = normalizePhotoAudience(photo.audienceType);
  if (audience === PHOTO_AUDIENCE.EVERYONE) {
    return 'family';
  }
  if (audience === PHOTO_AUDIENCE.PARENTS) {
    return 'none';
  }
  const ids = audience === PHOTO_AUDIENCE.USERS ? photo.audienceUserIds : photo.audienceGroupIds;
  return Array.isArray(ids) && ids.length > 0 ? 'limited' : 'none';
}

/**
 * Does changing a photo from `before` to `after` WIDEN who can get it?
 * Widening = it becomes visible to the whole family when it was not, or it
 * becomes downloadable while visible to anyone. These need the other
 * guardian's approval. Every restriction (hide, narrow, lock) never does.
 */
// A share that newly reaches MORE than this fraction of the active family is
// treated like "everyone". Without it, ticking every member by name (or
// adding every group) widened exposure with no second guardian (audit
// finding 6). One guardian can still share with a smaller circle alone.
const BROAD_AUDIENCE_FRACTION = 0.5;

/**
 * The ids of the given non-parent `members` (active accounts with
 * { id, groupIds }) who can see `photo`. Parents always can, so they are not
 * counted.
 */
function effectiveViewerIds(photo, members) {
  const ids = new Set();
  for (const m of members || []) {
    if (isInPhotoAudience({ id: m.id, groupIds: m.groupIds || [] }, photo)) {
      ids.add(m.id);
    }
  }
  return ids;
}

/**
 * Does changing a photo from `before` to `after` WIDEN who can get it?
 * Widening = it becomes visible to the whole family (or, when `members` is
 * given, newly reaches more than half of them or all of them, however the
 * audience is spelled), or it becomes downloadable while visible to anyone.
 * These need the other guardian's approval. Restrictions never do.
 */
function isWideningPhotoChange(before, after, members) {
  const was = photoExposure(before);
  const now = photoExposure(after);
  if (now === 'family' && was !== 'family') {
    return true;
  }
  if (Array.isArray(members) && members.length > 0) {
    const wasIds = effectiveViewerIds(before, members);
    const nowIds = effectiveViewerIds(after, members);
    const added = [...nowIds].some((id) => !wasIds.has(id));
    const broad = nowIds.size === members.length || nowIds.size > members.length * BROAD_AUDIENCE_FRACTION;
    if (added && broad) {
      return true;
    }
    const wasDlIds = Boolean(before && before.downloadable === true && wasIds.size > 0);
    const nowDlIds = Boolean(after && after.downloadable === true && nowIds.size > 0);
    if (nowDlIds && !wasDlIds) {
      return true;
    }
  }
  const wasDl = Boolean(before && before.downloadable === true && was !== 'none');
  const nowDl = Boolean(after && after.downloadable === true && now !== 'none');
  return nowDl && !wasDl;
}

/**
 * Extract the permission subset an upload profile defines, shaped so it can be
 * spread straight into createPhoto/updatePhoto. This is what "applying" or
 * "moving a photo to" a profile copies onto the photo. The photo then owns its
 * own copy, so a per-photo override edits the photo without touching the
 * profile, and editing the profile never retroactively changes a photo.
 */
function profilePermissions(profile) {
  if (!profile) {
    return {};
  }
  return {
    downloadable: profile.downloadable === true,
    watermark: profile.watermark === true,
    audienceType: normalizePhotoAudience(profile.audienceType),
    audienceUserIds: Array.isArray(profile.audienceUserIds)
      ? [...profile.audienceUserIds]
      : [],
    audienceGroupIds: Array.isArray(profile.audienceGroupIds)
      ? [...profile.audienceGroupIds]
      : [],
    commentsEnabled: profile.commentsEnabled !== false,
    reactionsEnabled: profile.reactionsEnabled !== false,
  };
}

const config = require('./config');

/**
 * Elevated (dev) portal access is a development aid only. In production there
 * is no dev role on the family instance: safe boot refuses to start if a dev
 * account exists, and this returns false regardless.
 */
function canUseDevPrivileges(user) {
  if (!user) {
    return false;
  }
  if (user.role === ROLES.PARENT) {
    return true;
  }
  return user.role === ROLES.DEV && !config.isProduction;
}

module.exports = {
  ROLES,
  ROLE_VALUES,
  ROLE_LABELS,
  PHOTO_AUDIENCE,
  PHOTO_AUDIENCE_VALUES,
  REACTION_EMOJIS,
  isValidRole,
  normalizeRole,
  isValidPhotoAudience,
  normalizePhotoAudience,
  isValidReactionEmoji,
  isInPhotoAudience,
  canViewPhoto,
  canComment,
  canDeleteComment,
  canReact,
  photoExposure,
  effectiveViewerIds,
  isWideningPhotoChange,
  profilePermissions,
  portalCapabilities,
  photoCapabilities,
  canUseDevPrivileges,
};
