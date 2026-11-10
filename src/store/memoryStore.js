'use strict';

const crypto = require('crypto');
const { buildEvent } = require('../audit');

/**
 * In-memory data store for development and testing.
 *
 * Holds everything in plain Maps. Data does NOT persist across restarts, and
 * safe boot refuses to run production on it. Implements the same async
 * interface a PgStore must implement, so application code is identical.
 *
 * Privacy notes baked into this layer:
 *   - New photos default to the PARENTS-ONLY audience (private by default).
 *   - The download ledger stores no email, no caption, a truncated network
 *     prefix, and an opaque per-download token; it has a retention purge.
 *   - Deleted comments are soft-deleted (history kept for guardians only).
 *   - The audit trail is hash-chained; only details can be redacted (by the
 *     retention job), never events removed or reordered.
 */

const USER_MUTABLE = [
  'displayName',
  'passwordHash',
  'theme',
  'role',
  'disabled',
  'disabledAt',
  'disabledBy',
  'sessionVersion',
  'mfaEnabled',
  'mfaSecretSealed',
  'mfaLastCounter',
  'mfaRecoveryCodes',
  'knownDevices',
  'privacyNoticeVersion',
  'privacyAcceptedAt',
  'commentsMuted',
  'mustChangePassword',
  // Support operator actions (see src/routes/support.js).
  'tempPasswordExpiresAt',
  'mustEnrollMfa',
  'supportNotices',
  'lastLoginAt',
];

const PHOTO_BOOL = [
  'hidden',
  'downloadable',
  'watermark',
  'commentsEnabled',
  'reactionsEnabled',
  'pendingApproval',
];

function copyUser(u) {
  return u
    ? { ...u, groupIds: [...(u.groupIds || [])], knownDevices: [...(u.knownDevices || [])] }
    : null;
}

function copyPhoto(p) {
  return p
    ? {
        ...p,
        audienceUserIds: [...(p.audienceUserIds || [])],
        audienceGroupIds: [...(p.audienceGroupIds || [])],
        variants: p.variants ? { ...p.variants } : {},
      }
    : null;
}

class MemoryStore {
  constructor() {
    this.kind = 'memory';
    // The account UUID (`id`) is the stable primary key. Email and username
    // are mutable attributes indexed for lookup, NOT identity.
    this.users = new Map();
    this.usersByEmail = new Map();
    this.usersByUsername = new Map();
    this.accessCodes = new Map();
    this.groups = new Map();
    this.photos = new Map();
    this.albums = new Map();
    this.downloads = new Map();
    this.comments = new Map();
    this.reactions = new Map();
    this.reports = new Map();
    this.uploadProfiles = new Map();
    this.governanceRequests = new Map();
    this.settings = new Map();
    this.siteSettings = new Map();
    this.authFailureStates = new Map();
    this.resetCodes = new Map();
    this.securityAuditEvents = [];
    // Usage rollups: `${day}|${metric}` -> count. Aggregates only.
    this.usageDaily = new Map();
    this.ready = Promise.resolve();
  }

  async init() {
    return this.ready;
  }

  /** Health check: is the store reachable? */
  async ping() {
    return true;
  }

  // --- Users ---

  async createUser({ email, passwordHash, displayName, username, role, theme, groupIds, privacyNoticeVersion }) {
    const normalizedEmail = email.trim().toLowerCase();
    if (this.usersByEmail.has(normalizedEmail)) {
      const err = new Error('A user with that email already exists.');
      err.code = 'USER_EXISTS';
      throw err;
    }
    const normalizedUsername = username ? username.trim().toLowerCase() : null;
    if (normalizedUsername && this.usersByUsername.has(normalizedUsername)) {
      const err = new Error('A user with that username already exists.');
      err.code = 'USERNAME_EXISTS';
      throw err;
    }
    const now = new Date().toISOString();
    const user = {
      id: crypto.randomUUID(),
      email: normalizedEmail,
      username: normalizedUsername,
      passwordHash,
      displayName: displayName || normalizedEmail.split('@')[0],
      role: role || 'user',
      theme: theme || 'system',
      groupIds: Array.isArray(groupIds) ? groupIds.filter((g) => this.groups.has(g)) : [],
      // Revocation: a disabled account is refused on its very next request,
      // and bumping sessionVersion ends every existing session at once.
      disabled: false,
      sessionVersion: 1,
      mfaEnabled: false,
      mfaSecretSealed: null,
      mfaLastCounter: -1,
      // SHA-256 hashes of unused one-time 2FA recovery codes.
      mfaRecoveryCodes: [],
      knownDevices: [],
      privacyNoticeVersion: privacyNoticeVersion || null,
      privacyAcceptedAt: privacyNoticeVersion ? now : null,
      commentsMuted: false,
      mustChangePassword: false,
      createdAt: now,
    };
    this.users.set(user.id, user);
    this.usersByEmail.set(normalizedEmail, user);
    if (normalizedUsername) {
      this.usersByUsername.set(normalizedUsername, user);
    }
    return copyUser(user);
  }

  async findUserByEmail(email) {
    return copyUser(this.usersByEmail.get(String(email || '').trim().toLowerCase()));
  }

  async findUserByUsername(username) {
    if (!username) {
      return null;
    }
    return copyUser(this.usersByUsername.get(username.trim().toLowerCase()));
  }

  async findUserById(id) {
    return copyUser(this.users.get(id));
  }

  /**
   * Update a user by UUID. Email/username uniqueness is enforced and indexes
   * remapped. Throws USER_EXISTS / USERNAME_EXISTS on collision.
   */
  async updateUser(id, changes = {}) {
    const user = this.users.get(id);
    if (!user) {
      return null;
    }
    if (changes.email !== undefined) {
      const normalizedEmail = changes.email.trim().toLowerCase();
      const holder = this.usersByEmail.get(normalizedEmail);
      if (holder && holder.id !== id) {
        const err = new Error('A user with that email already exists.');
        err.code = 'USER_EXISTS';
        throw err;
      }
      if (normalizedEmail !== user.email) {
        this.usersByEmail.delete(user.email);
        this.usersByEmail.set(normalizedEmail, user);
        user.email = normalizedEmail;
      }
    }
    if (changes.username !== undefined) {
      const normalizedUsername = changes.username ? changes.username.trim().toLowerCase() : null;
      if (normalizedUsername) {
        const holder = this.usersByUsername.get(normalizedUsername);
        if (holder && holder.id !== id) {
          const err = new Error('A user with that username already exists.');
          err.code = 'USERNAME_EXISTS';
          throw err;
        }
      }
      if (normalizedUsername !== user.username) {
        if (user.username) {
          this.usersByUsername.delete(user.username);
        }
        if (normalizedUsername) {
          this.usersByUsername.set(normalizedUsername, user);
        }
        user.username = normalizedUsername;
      }
    }
    for (const key of USER_MUTABLE) {
      if (changes[key] !== undefined) {
        user[key] = Array.isArray(changes[key]) ? [...changes[key]] : changes[key];
      }
    }
    if (changes.groupIds !== undefined) {
      user.groupIds = (Array.isArray(changes.groupIds) ? changes.groupIds : []).filter((gid) =>
        this.groups.has(gid)
      );
    }
    user.updatedAt = new Date().toISOString();
    return copyUser(user);
  }

  /** End every session of a user (sessions compare this on each request). */
  async bumpSessionVersion(id) {
    const user = this.users.get(id);
    if (!user) {
      return null;
    }
    user.sessionVersion = (user.sessionVersion || 1) + 1;
    return copyUser(user);
  }

  async listUsers() {
    return [...this.users.values()]
      .map(copyUser)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  /**
   * Permanently delete an account. `contentMode`:
   *   'anonymize' - comments stay, attributed to "Former member"
   *   'delete'    - the member's comments and reactions are removed
   * Albums (personal) are always removed. Photos they contributed stay, since
   * the parents own the library, but lose the uploader link. Ledger rows lose
   * the user link (the event remains for the parents' leak history).
   */
  async deleteUser(id, { contentMode = 'anonymize' } = {}) {
    const user = this.users.get(id);
    if (!user) {
      return false;
    }
    this.users.delete(id);
    this.usersByEmail.delete(user.email);
    if (user.username) {
      this.usersByUsername.delete(user.username);
    }
    for (const [aid, album] of this.albums) {
      if (album.ownerId === id) {
        this.albums.delete(aid);
      }
    }
    for (const [cid, c] of this.comments) {
      if (c.userId === id) {
        if (contentMode === 'delete') {
          this.comments.delete(cid);
        } else {
          c.userId = null;
          c.userDisplayName = 'Former member';
          c.authorRole = 'user';
        }
      }
    }
    for (const [rid, r] of this.reactions) {
      if (r.userId === id) {
        this.reactions.delete(rid);
      }
    }
    for (const photo of this.photos.values()) {
      if (photo.uploadedBy === id) {
        photo.uploadedBy = null;
        photo.uploadedByName = 'Former member';
      }
      if (Array.isArray(photo.audienceUserIds)) {
        photo.audienceUserIds = photo.audienceUserIds.filter((u) => u !== id);
      }
    }
    for (const d of this.downloads.values()) {
      if (d.userId === id) {
        d.userId = null;
        d.userDisplayName = 'Former member';
      }
    }
    return true;
  }

  // --- Access codes ---

  async createAccessCode({ code, createdBy, note, groupId, intendedEmail, expiresAt }) {
    const accessCode = {
      code,
      createdBy: createdBy || null,
      note: note || '',
      groupId: groupId || null,
      // Optional binding: only this email may redeem the code.
      intendedEmail: intendedEmail ? intendedEmail.trim().toLowerCase() : null,
      expiresAt: expiresAt || null,
      revokedAt: null,
      revokedBy: null,
      claimedAt: null,
      usedBy: null,
      usedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.accessCodes.set(code, accessCode);
    return { ...accessCode };
  }

  async findAccessCode(code) {
    const ac = this.accessCodes.get(code);
    return ac ? { ...ac } : null;
  }

  /**
   * Atomically claim a code for redemption. Succeeds only if the code exists,
   * is unused, unclaimed, unrevoked, unexpired, and (when bound) matches the
   * email. A claimed code cannot be claimed again until released, so parallel
   * registrations with one code create at most one account.
   */
  async claimAccessCode(code, { email, now = Date.now() } = {}) {
    const ac = this.accessCodes.get(code);
    if (!ac || ac.usedBy || ac.claimedAt || ac.revokedAt) {
      return null;
    }
    if (ac.expiresAt && Date.parse(ac.expiresAt) <= now) {
      return null;
    }
    if (ac.intendedEmail && ac.intendedEmail !== String(email || '').trim().toLowerCase()) {
      return null;
    }
    ac.claimedAt = new Date(now).toISOString();
    return { ...ac };
  }

  async releaseAccessCode(code) {
    const ac = this.accessCodes.get(code);
    if (ac && !ac.usedBy) {
      ac.claimedAt = null;
    }
  }

  async consumeAccessCode(code, userId) {
    const ac = this.accessCodes.get(code);
    if (!ac || ac.usedBy || ac.revokedAt) {
      return null;
    }
    ac.usedBy = userId;
    ac.usedAt = new Date().toISOString();
    return { ...ac };
  }

  async revokeAccessCode(code, revokedBy) {
    const ac = this.accessCodes.get(code);
    if (!ac || ac.usedBy || ac.revokedAt) {
      return null;
    }
    ac.revokedAt = new Date().toISOString();
    ac.revokedBy = revokedBy || null;
    return { ...ac };
  }

  async revokeAccessCodesCreatedBy(userId, revokedBy) {
    let count = 0;
    for (const ac of this.accessCodes.values()) {
      if (ac.createdBy === userId && !ac.usedBy && !ac.revokedAt) {
        ac.revokedAt = new Date().toISOString();
        ac.revokedBy = revokedBy || null;
        count += 1;
      }
    }
    return count;
  }

  async listAccessCodes() {
    return [...this.accessCodes.values()]
      .map((ac) => ({ ...ac }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  // --- Account reset codes (guardian-issued; stored only as a SHA-256 hash) ---

  async createResetCode({ codeHash, userId, createdBy, notBefore, expiresAt }) {
    const doc = {
      id: codeHash,
      userId,
      createdBy: createdBy || null,
      notBefore: notBefore || null,
      expiresAt,
      usedAt: null,
      revokedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.resetCodes.set(codeHash, doc);
    return { ...doc };
  }

  async revokeResetCodesForUser(userId) {
    let count = 0;
    for (const doc of this.resetCodes.values()) {
      if (doc.userId === userId && !doc.usedAt && !doc.revokedAt) {
        doc.revokedAt = new Date().toISOString();
        count += 1;
      }
    }
    return count;
  }

  /** Use a reset code exactly once, only for the account it was issued to. */
  async consumeResetCode(codeHash, { userId, now = Date.now() } = {}) {
    const doc = this.resetCodes.get(codeHash);
    if (!doc || doc.usedAt || doc.revokedAt || doc.userId !== userId || Date.parse(doc.expiresAt) <= now ||
        (doc.notBefore && Date.parse(doc.notBefore) > now)) {
      return null;
    }
    doc.usedAt = new Date(now).toISOString();
    return { ...doc };
  }

  // --- Groups ---

  async createGroup({ name, note }) {
    const group = {
      id: crypto.randomUUID(),
      name,
      note: note || '',
      createdAt: new Date().toISOString(),
    };
    this.groups.set(group.id, group);
    return { ...group };
  }

  async findGroupById(id) {
    const group = this.groups.get(id);
    return group ? { ...group } : null;
  }

  async listGroups() {
    return [...this.groups.values()].map((g) => ({ ...g })).sort((a, b) => a.name.localeCompare(b.name));
  }

  async deleteGroup(id) {
    if (!this.groups.has(id)) {
      return false;
    }
    this.groups.delete(id);
    for (const user of this.users.values()) {
      if (Array.isArray(user.groupIds) && user.groupIds.includes(id)) {
        user.groupIds = user.groupIds.filter((gid) => gid !== id);
      }
    }
    for (const photo of this.photos.values()) {
      if (Array.isArray(photo.audienceGroupIds) && photo.audienceGroupIds.includes(id)) {
        photo.audienceGroupIds = photo.audienceGroupIds.filter((gid) => gid !== id);
      }
    }
    for (const profile of this.uploadProfiles.values()) {
      profile.audienceGroupIds = (profile.audienceGroupIds || []).filter((gid) => gid !== id);
    }
    return true;
  }

  async addUserToGroup(userId, groupId) {
    const user = this.users.get(userId);
    if (!user || !this.groups.has(groupId)) {
      return null;
    }
    if (!user.groupIds.includes(groupId)) {
      user.groupIds.push(groupId);
    }
    return copyUser(user);
  }

  async removeUserFromGroup(userId, groupId) {
    const user = this.users.get(userId);
    if (!user) {
      return null;
    }
    user.groupIds = user.groupIds.filter((gid) => gid !== groupId);
    return copyUser(user);
  }

  // --- Photos ---
  //
  // A photo record holds metadata and storage keys only. Image bytes live in
  // the media storage backend, encrypted, under random object keys.

  async createPhoto({
    caption,
    mediaId,
    variants,
    width,
    height,
    uploadedBy,
    uploadedByName,
    publishedBy,
    pendingApproval,
    hidden,
    downloadable,
    watermark,
    audienceType,
    audienceUserIds,
    audienceGroupIds,
    commentsEnabled,
    reactionsEnabled,
    profileId,
  }) {
    const photo = {
      id: crypto.randomUUID(),
      caption: caption || '',
      mediaId: mediaId || null,
      variants: variants ? { ...variants } : {},
      width: width || null,
      height: height || null,
      uploadedBy: uploadedBy || null,
      uploadedByName: uploadedByName || null,
      // Which guardian made this photo visible to others (accountability).
      publishedBy: publishedBy || null,
      pendingApproval: pendingApproval === true,
      hidden: hidden === true,
      downloadable: downloadable === true,
      watermark: watermark === true,
      // Private by default: only parents see a photo until they choose.
      audienceType: audienceType || 'parents',
      audienceUserIds: Array.isArray(audienceUserIds) ? [...audienceUserIds] : [],
      audienceGroupIds: Array.isArray(audienceGroupIds) ? [...audienceGroupIds] : [],
      commentsEnabled: commentsEnabled !== false,
      reactionsEnabled: reactionsEnabled !== false,
      profileId: profileId || null,
      createdAt: new Date().toISOString(),
    };
    this.photos.set(photo.id, photo);
    return copyPhoto(photo);
  }

  async findPhotoById(id) {
    return copyPhoto(this.photos.get(id));
  }

  async listPhotos() {
    return [...this.photos.values()].map(copyPhoto).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async listPhotosByUploader(uploaderId) {
    return (await this.listPhotos()).filter((p) => p.uploadedBy === uploaderId);
  }

  async listPendingPhotos() {
    return (await this.listPhotos()).filter((p) => p.pendingApproval === true);
  }

  async updatePhoto(id, changes = {}) {
    const photo = this.photos.get(id);
    if (!photo) {
      return null;
    }
    if (changes.caption !== undefined) {
      photo.caption = changes.caption;
    }
    for (const key of PHOTO_BOOL) {
      if (changes[key] !== undefined) {
        photo[key] = changes[key] === true;
      }
    }
    if (changes.audienceType !== undefined) {
      photo.audienceType = changes.audienceType;
    }
    if (changes.audienceUserIds !== undefined) {
      photo.audienceUserIds = Array.isArray(changes.audienceUserIds) ? [...changes.audienceUserIds] : [];
    }
    if (changes.audienceGroupIds !== undefined) {
      photo.audienceGroupIds = Array.isArray(changes.audienceGroupIds) ? [...changes.audienceGroupIds] : [];
    }
    if (changes.profileId !== undefined) {
      photo.profileId = changes.profileId || null;
    }
    if (changes.publishedBy !== undefined) {
      photo.publishedBy = changes.publishedBy || null;
    }
    photo.updatedAt = new Date().toISOString();
    return copyPhoto(photo);
  }

  /**
   * Delete a photo record and everything that references it. The ledger keeps
   * the event (who downloaded, when) for the parents' leak history, but loses
   * any content about the photo. Media objects are removed by the caller via
   * the media service, which also returns the removed keys for the audit log.
   */
  async deletePhoto(id) {
    if (!this.photos.has(id)) {
      return false;
    }
    this.photos.delete(id);
    for (const album of this.albums.values()) {
      album.photoIds = album.photoIds.filter((pid) => pid !== id);
    }
    for (const [cid, c] of this.comments) {
      if (c.photoId === id) {
        this.comments.delete(cid);
      }
    }
    for (const [rid, r] of this.reactions) {
      if (r.photoId === id) {
        this.reactions.delete(rid);
      }
    }
    for (const [rid, r] of this.reports) {
      if (r.photoId === id) {
        this.reports.delete(rid);
      }
    }
    for (const d of this.downloads.values()) {
      if (d.photoId === id) {
        d.photoDeleted = true;
        d.ipNet = null;
      }
    }
    return true;
  }

  async bulkUpdatePhotos(ids, changes = {}) {
    let updated = 0;
    for (const id of ids || []) {
      if (await this.updatePhoto(id, changes)) {
        updated += 1;
      }
    }
    return updated;
  }

  // --- Download ledger (minimized) ---

  async recordDownload({ token, userId, userDisplayName, photoId, ipNet, userAgent, watermarked, metadataEmbedded }) {
    const event = {
      id: crypto.randomUUID(),
      // Opaque value embedded in the downloaded file; resolves to this row.
      token: token || null,
      userId: userId || null,
      userDisplayName: userDisplayName || null,
      photoId: photoId || null,
      photoDeleted: false,
      ipNet: ipNet || null,
      userAgent: userAgent || null,
      watermarked: watermarked === true,
      metadataEmbedded: metadataEmbedded === true,
      downloadedAt: new Date().toISOString(),
    };
    this.downloads.set(event.id, event);
    return { ...event };
  }

  async listDownloads() {
    return [...this.downloads.values()]
      .map((d) => ({ ...d }))
      .sort((a, b) => b.downloadedAt.localeCompare(a.downloadedAt));
  }

  async listDownloadsByPhoto(photoId) {
    return (await this.listDownloads()).filter((d) => d.photoId === photoId);
  }

  async listDownloadsByUser(userId) {
    return (await this.listDownloads()).filter((d) => d.userId === userId);
  }

  async findDownloadByToken(token) {
    for (const d of this.downloads.values()) {
      if (d.token && d.token === token) {
        return { ...d };
      }
    }
    return null;
  }

  /** Retention: remove ledger rows older than `before` (ISO string). */
  async purgeDownloadsBefore(before) {
    let removed = 0;
    for (const [id, d] of this.downloads) {
      if (d.downloadedAt < before) {
        this.downloads.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  // --- Comments (soft delete) ---

  async createComment({ photoId, userId, userDisplayName, authorRole, body }) {
    const comment = {
      id: crypto.randomUUID(),
      photoId,
      userId: userId || null,
      userDisplayName: userDisplayName || null,
      // Shown as a badge so a member cannot pass themselves off as a parent.
      authorRole: authorRole || 'user',
      body: body || '',
      deletedAt: null,
      deletedBy: null,
      createdAt: new Date().toISOString(),
    };
    this.comments.set(comment.id, comment);
    return { ...comment };
  }

  async findCommentById(id) {
    const comment = this.comments.get(id);
    return comment ? { ...comment } : null;
  }

  /** All comments for a photo, oldest first, INCLUDING soft-deleted ones. */
  async listCommentsByPhoto(photoId) {
    return [...this.comments.values()]
      .filter((c) => c.photoId === photoId)
      .map((c) => ({ ...c }))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async listCommentsByUser(userId) {
    return [...this.comments.values()].filter((c) => c.userId === userId).map((c) => ({ ...c }));
  }

  /** Soft delete: hidden from members, kept for guardians as evidence. */
  async softDeleteComment(id, deletedBy) {
    const c = this.comments.get(id);
    if (!c || c.deletedAt) {
      return null;
    }
    c.deletedAt = new Date().toISOString();
    c.deletedBy = deletedBy || null;
    return { ...c };
  }

  // --- Reports (comment / photo moderation) ---

  async createReport({ photoId, commentId, reportedBy, reason }) {
    const report = {
      id: crypto.randomUUID(),
      photoId: photoId || null,
      commentId: commentId || null,
      reportedBy: reportedBy || null,
      reason: reason || '',
      resolvedAt: null,
      resolvedBy: null,
      createdAt: new Date().toISOString(),
    };
    this.reports.set(report.id, report);
    return { ...report };
  }

  async listReports({ includeResolved = false } = {}) {
    return [...this.reports.values()]
      .filter((r) => includeResolved || !r.resolvedAt)
      .map((r) => ({ ...r }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async resolveReport(id, resolvedBy) {
    const r = this.reports.get(id);
    if (!r || r.resolvedAt) {
      return null;
    }
    r.resolvedAt = new Date().toISOString();
    r.resolvedBy = resolvedBy || null;
    return { ...r };
  }

  // --- Reactions ---

  async toggleReaction({ photoId, userId, emoji }) {
    for (const [rid, r] of this.reactions) {
      if (r.photoId === photoId && r.userId === userId && r.emoji === emoji) {
        this.reactions.delete(rid);
        return { on: false, emoji };
      }
    }
    const reaction = {
      id: crypto.randomUUID(),
      photoId,
      userId,
      emoji,
      createdAt: new Date().toISOString(),
    };
    this.reactions.set(reaction.id, reaction);
    return { on: true, emoji };
  }

  async listReactionsByPhoto(photoId) {
    return [...this.reactions.values()].filter((r) => r.photoId === photoId).map((r) => ({ ...r }));
  }

  async listReactionsByUser(userId) {
    return [...this.reactions.values()].filter((r) => r.userId === userId).map((r) => ({ ...r }));
  }

  async reactionSummary(photoId, viewerId) {
    const rows = await this.listReactionsByPhoto(photoId);
    const counts = {};
    const mine = [];
    for (const r of rows) {
      counts[r.emoji] = (counts[r.emoji] || 0) + 1;
      if (viewerId && r.userId === viewerId && !mine.includes(r.emoji)) {
        mine.push(r.emoji);
      }
    }
    return { counts, mine };
  }

  // --- Upload profiles ---

  async createUploadProfile(fields) {
    const profile = {
      id: crypto.randomUUID(),
      name: fields.name,
      downloadable: fields.downloadable === true,
      watermark: fields.watermark === true,
      audienceType: fields.audienceType || 'parents',
      audienceUserIds: Array.isArray(fields.audienceUserIds) ? [...fields.audienceUserIds] : [],
      audienceGroupIds: Array.isArray(fields.audienceGroupIds) ? [...fields.audienceGroupIds] : [],
      commentsEnabled: fields.commentsEnabled !== false,
      reactionsEnabled: fields.reactionsEnabled !== false,
      createdAt: new Date().toISOString(),
    };
    this.uploadProfiles.set(profile.id, profile);
    return this.findUploadProfileById(profile.id);
  }

  async findUploadProfileById(id) {
    const p = this.uploadProfiles.get(id);
    return p ? { ...p, audienceUserIds: [...p.audienceUserIds], audienceGroupIds: [...p.audienceGroupIds] } : null;
  }

  async listUploadProfiles() {
    const all = await Promise.all([...this.uploadProfiles.keys()].map((id) => this.findUploadProfileById(id)));
    return all.sort((a, b) => a.name.localeCompare(b.name));
  }

  async updateUploadProfile(id, changes = {}) {
    const profile = this.uploadProfiles.get(id);
    if (!profile) {
      return null;
    }
    if (changes.name !== undefined) {
      profile.name = changes.name;
    }
    for (const key of ['downloadable', 'watermark', 'commentsEnabled', 'reactionsEnabled']) {
      if (changes[key] !== undefined) {
        profile[key] = changes[key] === true;
      }
    }
    if (changes.audienceType !== undefined) {
      profile.audienceType = changes.audienceType;
    }
    if (changes.audienceUserIds !== undefined) {
      profile.audienceUserIds = Array.isArray(changes.audienceUserIds) ? [...changes.audienceUserIds] : [];
    }
    if (changes.audienceGroupIds !== undefined) {
      profile.audienceGroupIds = Array.isArray(changes.audienceGroupIds) ? [...changes.audienceGroupIds] : [];
    }
    profile.updatedAt = new Date().toISOString();
    return this.findUploadProfileById(id);
  }

  async deleteUploadProfile(id) {
    if (!this.uploadProfiles.has(id)) {
      return false;
    }
    this.uploadProfiles.delete(id);
    for (const photo of this.photos.values()) {
      if (photo.profileId === id) {
        photo.profileId = null;
      }
    }
    return true;
  }

  // --- Albums ---

  async createAlbum({ ownerId, name }) {
    const album = { id: crypto.randomUUID(), ownerId, name, photoIds: [], createdAt: new Date().toISOString() };
    this.albums.set(album.id, album);
    return { ...album, photoIds: [] };
  }

  async findAlbumById(id) {
    const album = this.albums.get(id);
    return album ? { ...album, photoIds: [...album.photoIds] } : null;
  }

  async listAlbumsByOwner(ownerId) {
    return [...this.albums.values()]
      .filter((a) => a.ownerId === ownerId)
      .map((a) => ({ ...a, photoIds: [...a.photoIds] }))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async addPhotoToAlbum(albumId, photoId) {
    const album = this.albums.get(albumId);
    if (!album || !this.photos.has(photoId)) {
      return null;
    }
    if (!album.photoIds.includes(photoId)) {
      album.photoIds.push(photoId);
    }
    return { ...album, photoIds: [...album.photoIds] };
  }

  async removePhotoFromAlbum(albumId, photoId) {
    const album = this.albums.get(albumId);
    if (!album) {
      return null;
    }
    album.photoIds = album.photoIds.filter((pid) => pid !== photoId);
    return { ...album, photoIds: [...album.photoIds] };
  }

  async deleteAlbum(id) {
    return this.albums.delete(id);
  }

  // --- Governance requests (two-guardian approval) ---

  async createGovernanceRequest({ type, payload, summary, requestedBy, executeAfter, expiresAt }) {
    const req = {
      id: crypto.randomUUID(),
      type,
      payload: payload || {},
      summary: summary || type,
      requestedBy,
      status: 'pending',
      executeAfter: executeAfter || null,
      expiresAt: expiresAt || null,
      decidedBy: null,
      decidedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.governanceRequests.set(req.id, req);
    return { ...req };
  }

  async findGovernanceRequest(id) {
    const r = this.governanceRequests.get(id);
    return r ? { ...r } : null;
  }

  async listGovernanceRequests({ status } = {}) {
    return [...this.governanceRequests.values()]
      .filter((r) => !status || r.status === status)
      .map((r) => ({ ...r }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** Move a pending request to a final status exactly once. */
  async decideGovernanceRequest(id, { status, decidedBy }) {
    const r = this.governanceRequests.get(id);
    if (!r || r.status !== 'pending') {
      return null;
    }
    r.status = status;
    r.decidedBy = decidedBy || null;
    r.decidedAt = new Date().toISOString();
    return { ...r };
  }

  // --- Settings (small key/value, e.g. the wrapped media data key) ---

  async getSetting(key) {
    return this.settings.has(key) ? this.settings.get(key) : null;
  }

  async setSettingIfAbsent(key, value) {
    if (!this.settings.has(key)) {
      this.settings.set(key, value);
    }
    return this.settings.get(key);
  }

  // --- Site settings (editable JSON values, e.g. the family time zone) ---
  // Separate from the insert-once settings above: these can be changed and
  // reset by a guardian, so they never hold keys or secrets.

  async getSiteSetting(key) {
    return this.siteSettings.has(key) ? structuredClone(this.siteSettings.get(key)) : null;
  }

  async putSiteSetting(key, value) {
    this.siteSettings.set(key, structuredClone(value));
    return structuredClone(value);
  }

  async deleteSiteSetting(key) {
    return this.siteSettings.delete(key);
  }

  // --- Auth failure states ---

  async getAuthFailureState(key) {
    return this.authFailureStates.get(key) || { count: 0, lockedUntil: 0 };
  }

  async setAuthFailureState(key, state) {
    this.authFailureStates.set(key, state);
    return state;
  }

  async clearAuthFailureState(key) {
    this.authFailureStates.delete(key);
  }

  /** Every counter for one sign-in identity: `acct:<id>` and each `ip:<ip>:<id>`. */
  async listAuthFailureStatesFor(identity) {
    const out = [];
    for (const [key, state] of this.authFailureStates) {
      if (key === `acct:${identity}` || (key.startsWith('ip:') && key.endsWith(`:${identity}`))) {
        out.push({ key, count: state.count || 0, lockedUntil: state.lockedUntil || 0 });
      }
    }
    return out;
  }

  async clearAuthFailureStatesFor(identity) {
    const states = await this.listAuthFailureStatesFor(identity);
    for (const s of states) {
      this.authFailureStates.delete(s.key);
    }
    return states.length;
  }

  // --- Security audit trail (append-only, hash-chained) ---

  async appendSecurityAuditEvent(input) {
    const prev = this.securityAuditEvents[this.securityAuditEvents.length - 1] || null;
    const event = buildEvent(prev, input);
    this.securityAuditEvents.push(event);
    return { ...event };
  }

  async listSecurityAuditEvents() {
    return this.securityAuditEvents.map((e) => ({ ...e, details: e.details ? { ...e.details } : null }));
  }

  /**
   * Retention: drop the DETAILS of events older than `before`, keeping the
   * event, its type, and its hashes so the chain still verifies.
   */
  async redactAuditDetailsBefore(before) {
    let redacted = 0;
    for (const e of this.securityAuditEvents) {
      if (e.at < before && !e.redacted) {
        e.details = null;
        e.redacted = true;
        redacted += 1;
      }
    }
    return redacted;
  }

  // --- Usage rollups (aggregate counts per UTC day; see src/usage.js) ---

  /** Add to counters: `counts` is { metric: n }. */
  async addUsageCounts(day, counts) {
    for (const [metric, n] of Object.entries(counts)) {
      const key = `${day}|${metric}`;
      this.usageDaily.set(key, (this.usageDaily.get(key) || 0) + n);
    }
  }

  /** Overwrite snapshot values: `values` is { metric: n }. */
  async setUsageValues(day, values) {
    for (const [metric, n] of Object.entries(values)) {
      this.usageDaily.set(`${day}|${metric}`, n);
    }
  }

  /** Every row on or after `sinceDay` (YYYY-MM-DD), oldest first. */
  async listUsageSince(sinceDay) {
    const rows = [];
    for (const [key, value] of this.usageDaily) {
      const [day, metric] = key.split('|');
      if (day >= sinceDay) {
        rows.push({ day, metric, value });
      }
    }
    return rows.sort((a, b) => a.day.localeCompare(b.day) || a.metric.localeCompare(b.metric));
  }

  async purgeUsageBefore(beforeDay) {
    let removed = 0;
    for (const key of [...this.usageDaily.keys()]) {
      if (key.split('|')[0] < beforeDay) {
        this.usageDaily.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}

module.exports = { MemoryStore };
