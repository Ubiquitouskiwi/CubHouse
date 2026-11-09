'use strict';

const crypto = require('crypto');
const { buildEvent } = require('../audit');
const { getPool } = require('./pgSupport');

/**
 * PostgreSQL data store for production. Same async interface and the same
 * behavior as MemoryStore (the whole test suite runs against both; see
 * test/storeFactory.js). Schema: deploy/sql/001_security.sql and
 * deploy/sql/002_data_store.sql.
 *
 * Each entity is one row with a JSON document shaped exactly like the
 * MemoryStore object, plus indexed columns where a unique constraint or a
 * lookup needs one. Every change that touches more than one row runs in one
 * transaction, and every exactly-once operation locks its row (FOR UPDATE).
 *
 * shortcut: list methods read whole tables and filter in the app, like the
 * memory store. Fine for one family; add SQL filters and paging before
 * hosting many families on one database.
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

const PHOTO_BOOL = ['hidden', 'downloadable', 'watermark', 'commentsEnabled', 'reactionsEnabled', 'pendingApproval'];

// One advisory-lock id serializes audit appends (the chain needs one writer).
const AUDIT_LOCK_ID = 7316001;

const UNIQUE_VIOLATION = '23505';

function exists(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function mapUniqueViolation(err) {
  if (err && err.code === UNIQUE_VIOLATION) {
    if (String(err.constraint || '').includes('username')) {
      return exists('USERNAME_EXISTS', 'A user with that username already exists.');
    }
    return exists('USER_EXISTS', 'A user with that email already exists.');
  }
  return err;
}

const byCreatedDesc = (a, b) => b.createdAt.localeCompare(a.createdAt);
const byCreatedAsc = (a, b) => a.createdAt.localeCompare(b.createdAt);
const byName = (a, b) => a.name.localeCompare(b.name);

class PgStore {
  constructor(databaseUrl, { pool } = {}) {
    this.kind = 'pg';
    this.pool = pool || getPool(databaseUrl);
  }

  /** Fail loudly at boot if the schema has not been applied. */
  async init() {
    try {
      await this.pool.query('SELECT 1 FROM app_users LIMIT 1');
      await this.pool.query('SELECT 1 FROM security_audit_events LIMIT 1');
    } catch (err) {
      throw new Error(
        'The Postgres schema is missing. Apply deploy/sql/001_security.sql and 002_data_store.sql first: ' +
          err.message,
        { cause: err }
      );
    }
  }

  /** Health check: one trivial round trip. */
  async ping() {
    await this.pool.query('SELECT 1');
    return true;
  }

  // --- Plumbing ---

  async tx(fn) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async all(table, q = this.pool) {
    // Table names are fixed literals from this file, never input.
    const { rows } = await q.query(`SELECT doc FROM ${table}`);
    return rows.map((r) => r.doc);
  }

  async one(table, id, q = this.pool, { lock = false } = {}) {
    if (id === undefined || id === null || id === '') {
      return null;
    }
    const { rows } = await q.query(`SELECT doc FROM ${table} WHERE id = $1${lock ? ' FOR UPDATE' : ''}`, [String(id)]);
    return rows.length ? rows[0].doc : null;
  }

  async put(table, doc, q = this.pool) {
    await q.query(`UPDATE ${table} SET doc = $2 WHERE id = $1`, [doc.id, doc]);
    return doc;
  }

  async insert(table, doc, q = this.pool) {
    await q.query(`INSERT INTO ${table} (id, doc) VALUES ($1, $2)`, [doc.id, doc]);
    return doc;
  }

  async groupIdSet(q = this.pool) {
    const { rows } = await q.query('SELECT id FROM app_groups');
    return new Set(rows.map((r) => r.id));
  }

  // --- Users ---

  async createUser({ email, passwordHash, displayName, username, role, theme, groupIds, privacyNoticeVersion }) {
    const normalizedEmail = email.trim().toLowerCase();
    const normalizedUsername = username ? username.trim().toLowerCase() : null;
    const now = new Date().toISOString();
    const groups = await this.groupIdSet();
    const user = {
      id: crypto.randomUUID(),
      email: normalizedEmail,
      username: normalizedUsername,
      passwordHash,
      displayName: displayName || normalizedEmail.split('@')[0],
      role: role || 'user',
      theme: theme || 'system',
      groupIds: Array.isArray(groupIds) ? groupIds.filter((g) => groups.has(g)) : [],
      disabled: false,
      sessionVersion: 1,
      mfaEnabled: false,
      mfaSecretSealed: null,
      mfaLastCounter: -1,
      mfaRecoveryCodes: [],
      knownDevices: [],
      privacyNoticeVersion: privacyNoticeVersion || null,
      privacyAcceptedAt: privacyNoticeVersion ? now : null,
      commentsMuted: false,
      mustChangePassword: false,
      createdAt: now,
    };
    try {
      await this.pool.query(
        'INSERT INTO app_users (id, email, username, created_at, doc) VALUES ($1, $2, $3, $4, $5)',
        [user.id, user.email, user.username, now, user]
      );
    } catch (err) {
      throw mapUniqueViolation(err);
    }
    return user;
  }

  async findUserByEmail(email) {
    const { rows } = await this.pool.query('SELECT doc FROM app_users WHERE email = $1', [
      String(email || '').trim().toLowerCase(),
    ]);
    return rows.length ? rows[0].doc : null;
  }

  async findUserByUsername(username) {
    if (!username) {
      return null;
    }
    const { rows } = await this.pool.query('SELECT doc FROM app_users WHERE username = $1', [
      username.trim().toLowerCase(),
    ]);
    return rows.length ? rows[0].doc : null;
  }

  async findUserById(id) {
    return this.one('app_users', id);
  }

  async updateUser(id, changes = {}) {
    try {
      return await this.tx(async (c) => {
        const user = await this.one('app_users', id, c, { lock: true });
        if (!user) {
          return null;
        }
        if (changes.email !== undefined) {
          user.email = changes.email.trim().toLowerCase();
        }
        if (changes.username !== undefined) {
          user.username = changes.username ? changes.username.trim().toLowerCase() : null;
        }
        for (const key of USER_MUTABLE) {
          if (changes[key] !== undefined) {
            user[key] = Array.isArray(changes[key]) ? [...changes[key]] : changes[key];
          }
        }
        if (changes.groupIds !== undefined) {
          const groups = await this.groupIdSet(c);
          user.groupIds = (Array.isArray(changes.groupIds) ? changes.groupIds : []).filter((g) => groups.has(g));
        }
        user.updatedAt = new Date().toISOString();
        await c.query('UPDATE app_users SET email = $2, username = $3, doc = $4 WHERE id = $1', [
          user.id,
          user.email,
          user.username,
          user,
        ]);
        return user;
      });
    } catch (err) {
      throw mapUniqueViolation(err);
    }
  }

  async bumpSessionVersion(id) {
    return this.tx(async (c) => {
      const user = await this.one('app_users', id, c, { lock: true });
      if (!user) {
        return null;
      }
      user.sessionVersion = (user.sessionVersion || 1) + 1;
      return this.put('app_users', user, c);
    });
  }

  async listUsers() {
    return (await this.all('app_users')).sort(byCreatedAsc);
  }

  async deleteUser(id, { contentMode = 'anonymize' } = {}) {
    return this.tx(async (c) => {
      const user = await this.one('app_users', id, c, { lock: true });
      if (!user) {
        return false;
      }
      await c.query('DELETE FROM app_users WHERE id = $1', [id]);
      await c.query('DELETE FROM app_albums WHERE owner_id = $1', [id]);
      for (const comment of await this.all('app_comments', c)) {
        if (comment.userId !== id) {
          continue;
        }
        if (contentMode === 'delete') {
          await c.query('DELETE FROM app_comments WHERE id = $1', [comment.id]);
        } else {
          Object.assign(comment, { userId: null, userDisplayName: 'Former member', authorRole: 'user' });
          await this.put('app_comments', comment, c);
        }
      }
      await c.query('DELETE FROM app_reactions WHERE user_id = $1', [id]);
      for (const photo of await this.all('app_photos', c)) {
        const ids = Array.isArray(photo.audienceUserIds) ? photo.audienceUserIds : [];
        if (photo.uploadedBy === id || ids.includes(id)) {
          if (photo.uploadedBy === id) {
            photo.uploadedBy = null;
            photo.uploadedByName = 'Former member';
          }
          photo.audienceUserIds = ids.filter((u) => u !== id);
          await this.put('app_photos', photo, c);
        }
      }
      for (const d of await this.all('app_downloads', c)) {
        if (d.userId === id) {
          Object.assign(d, { userId: null, userDisplayName: 'Former member' });
          await this.put('app_downloads', d, c);
        }
      }
      return true;
    });
  }

  // --- Access codes ---

  async createAccessCode({ code, createdBy, note, groupId, intendedEmail, expiresAt }) {
    const accessCode = {
      code,
      createdBy: createdBy || null,
      note: note || '',
      groupId: groupId || null,
      intendedEmail: intendedEmail ? intendedEmail.trim().toLowerCase() : null,
      expiresAt: expiresAt || null,
      revokedAt: null,
      revokedBy: null,
      claimedAt: null,
      usedBy: null,
      usedAt: null,
      createdAt: new Date().toISOString(),
    };
    await this.pool.query('INSERT INTO app_access_codes (id, doc) VALUES ($1, $2)', [code, accessCode]);
    return { ...accessCode };
  }

  async findAccessCode(code) {
    return this.one('app_access_codes', code);
  }

  async mutateCode(code, fn) {
    return this.tx(async (c) => {
      const ac = await this.one('app_access_codes', code, c, { lock: true });
      if (!ac) {
        return null;
      }
      const result = fn(ac);
      if (result) {
        await c.query('UPDATE app_access_codes SET doc = $2 WHERE id = $1', [code, ac]);
      }
      return result;
    });
  }

  async claimAccessCode(code, { email, now = Date.now() } = {}) {
    return this.mutateCode(code, (ac) => {
      if (ac.usedBy || ac.claimedAt || ac.revokedAt) {
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
    });
  }

  async releaseAccessCode(code) {
    await this.mutateCode(code, (ac) => {
      if (ac.usedBy) {
        return null;
      }
      ac.claimedAt = null;
      return ac;
    });
  }

  async consumeAccessCode(code, userId) {
    return this.mutateCode(code, (ac) => {
      if (ac.usedBy || ac.revokedAt) {
        return null;
      }
      ac.usedBy = userId;
      ac.usedAt = new Date().toISOString();
      return { ...ac };
    });
  }

  async revokeAccessCode(code, revokedBy) {
    return this.mutateCode(code, (ac) => {
      if (ac.usedBy || ac.revokedAt) {
        return null;
      }
      ac.revokedAt = new Date().toISOString();
      ac.revokedBy = revokedBy || null;
      return { ...ac };
    });
  }

  async revokeAccessCodesCreatedBy(userId, revokedBy) {
    return this.tx(async (c) => {
      const { rows } = await c.query('SELECT doc FROM app_access_codes FOR UPDATE');
      let count = 0;
      for (const { doc: ac } of rows) {
        if (ac.createdBy === userId && !ac.usedBy && !ac.revokedAt) {
          ac.revokedAt = new Date().toISOString();
          ac.revokedBy = revokedBy || null;
          await c.query('UPDATE app_access_codes SET doc = $2 WHERE id = $1', [ac.code, ac]);
          count += 1;
        }
      }
      return count;
    });
  }

  async listAccessCodes() {
    return (await this.all('app_access_codes')).sort(byCreatedDesc);
  }

  // --- Account reset codes (guardian-issued; stored only as a hash) ---

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
    await this.insert('app_reset_codes', doc);
    return { ...doc };
  }

  async revokeResetCodesForUser(userId) {
    return this.tx(async (c) => {
      let count = 0;
      for (const doc of await this.all('app_reset_codes', c)) {
        if (doc.userId === userId && !doc.usedAt && !doc.revokedAt) {
          doc.revokedAt = new Date().toISOString();
          await this.put('app_reset_codes', doc, c);
          count += 1;
        }
      }
      return count;
    });
  }

  async consumeResetCode(codeHash, { userId, now = Date.now() } = {}) {
    return this.tx(async (c) => {
      const doc = await this.one('app_reset_codes', codeHash, c, { lock: true });
      if (!doc || doc.usedAt || doc.revokedAt || doc.userId !== userId || Date.parse(doc.expiresAt) <= now ||
        (doc.notBefore && Date.parse(doc.notBefore) > now)) {
        return null;
      }
      doc.usedAt = new Date(now).toISOString();
      await this.put('app_reset_codes', doc, c);
      return { ...doc };
    });
  }

  // --- Groups ---

  async createGroup({ name, note }) {
    const group = { id: crypto.randomUUID(), name, note: note || '', createdAt: new Date().toISOString() };
    return this.insert('app_groups', group);
  }

  async findGroupById(id) {
    return this.one('app_groups', id);
  }

  async listGroups() {
    return (await this.all('app_groups')).sort(byName);
  }

  async deleteGroup(id) {
    return this.tx(async (c) => {
      const { rowCount } = await c.query('DELETE FROM app_groups WHERE id = $1', [String(id)]);
      if (rowCount === 0) {
        return false;
      }
      for (const user of await this.all('app_users', c)) {
        if (Array.isArray(user.groupIds) && user.groupIds.includes(id)) {
          user.groupIds = user.groupIds.filter((g) => g !== id);
          await this.put('app_users', user, c);
        }
      }
      for (const photo of await this.all('app_photos', c)) {
        if (Array.isArray(photo.audienceGroupIds) && photo.audienceGroupIds.includes(id)) {
          photo.audienceGroupIds = photo.audienceGroupIds.filter((g) => g !== id);
          await this.put('app_photos', photo, c);
        }
      }
      for (const profile of await this.all('app_upload_profiles', c)) {
        if ((profile.audienceGroupIds || []).includes(id)) {
          profile.audienceGroupIds = profile.audienceGroupIds.filter((g) => g !== id);
          await this.put('app_upload_profiles', profile, c);
        }
      }
      return true;
    });
  }

  async addUserToGroup(userId, groupId) {
    return this.tx(async (c) => {
      const user = await this.one('app_users', userId, c, { lock: true });
      const group = await this.one('app_groups', groupId, c);
      if (!user || !group) {
        return null;
      }
      if (!user.groupIds.includes(groupId)) {
        user.groupIds.push(groupId);
        await this.put('app_users', user, c);
      }
      return user;
    });
  }

  async removeUserFromGroup(userId, groupId) {
    return this.tx(async (c) => {
      const user = await this.one('app_users', userId, c, { lock: true });
      if (!user) {
        return null;
      }
      user.groupIds = user.groupIds.filter((g) => g !== groupId);
      return this.put('app_users', user, c);
    });
  }

  // --- Photos ---

  async createPhoto(fields) {
    const photo = {
      id: crypto.randomUUID(),
      caption: fields.caption || '',
      mediaId: fields.mediaId || null,
      variants: fields.variants ? { ...fields.variants } : {},
      width: fields.width || null,
      height: fields.height || null,
      uploadedBy: fields.uploadedBy || null,
      uploadedByName: fields.uploadedByName || null,
      publishedBy: fields.publishedBy || null,
      pendingApproval: fields.pendingApproval === true,
      hidden: fields.hidden === true,
      downloadable: fields.downloadable === true,
      watermark: fields.watermark === true,
      audienceType: fields.audienceType || 'parents',
      audienceUserIds: Array.isArray(fields.audienceUserIds) ? [...fields.audienceUserIds] : [],
      audienceGroupIds: Array.isArray(fields.audienceGroupIds) ? [...fields.audienceGroupIds] : [],
      commentsEnabled: fields.commentsEnabled !== false,
      reactionsEnabled: fields.reactionsEnabled !== false,
      profileId: fields.profileId || null,
      createdAt: new Date().toISOString(),
    };
    return this.insert('app_photos', photo);
  }

  async findPhotoById(id) {
    return this.one('app_photos', id);
  }

  async listPhotos() {
    return (await this.all('app_photos')).sort(byCreatedDesc);
  }

  async listPhotosByUploader(uploaderId) {
    return (await this.listPhotos()).filter((p) => p.uploadedBy === uploaderId);
  }

  async listPendingPhotos() {
    return (await this.listPhotos()).filter((p) => p.pendingApproval === true);
  }

  async updatePhoto(id, changes = {}) {
    return this.tx(async (c) => {
      const photo = await this.one('app_photos', id, c, { lock: true });
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
      return this.put('app_photos', photo, c);
    });
  }

  async deletePhoto(id) {
    return this.tx(async (c) => {
      const { rowCount } = await c.query('DELETE FROM app_photos WHERE id = $1', [String(id)]);
      if (rowCount === 0) {
        return false;
      }
      for (const album of await this.all('app_albums', c)) {
        if (album.photoIds.includes(id)) {
          album.photoIds = album.photoIds.filter((p) => p !== id);
          await this.put('app_albums', album, c);
        }
      }
      await c.query('DELETE FROM app_comments WHERE photo_id = $1', [id]);
      await c.query('DELETE FROM app_reactions WHERE photo_id = $1', [id]);
      for (const r of await this.all('app_reports', c)) {
        if (r.photoId === id) {
          await c.query('DELETE FROM app_reports WHERE id = $1', [r.id]);
        }
      }
      for (const d of await this.all('app_downloads', c)) {
        if (d.photoId === id) {
          Object.assign(d, { photoDeleted: true, ipNet: null });
          await this.put('app_downloads', d, c);
        }
      }
      return true;
    });
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

  // --- Download ledger ---

  async recordDownload({ token, userId, userDisplayName, photoId, ipNet, userAgent, watermarked, metadataEmbedded }) {
    const event = {
      id: crypto.randomUUID(),
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
    await this.pool.query('INSERT INTO app_downloads (id, token, downloaded_at, doc) VALUES ($1, $2, $3, $4)', [
      event.id,
      event.token,
      event.downloadedAt,
      event,
    ]);
    return { ...event };
  }

  async listDownloads() {
    return (await this.all('app_downloads')).sort((a, b) => b.downloadedAt.localeCompare(a.downloadedAt));
  }

  async listDownloadsByPhoto(photoId) {
    return (await this.listDownloads()).filter((d) => d.photoId === photoId);
  }

  async listDownloadsByUser(userId) {
    return (await this.listDownloads()).filter((d) => d.userId === userId);
  }

  async findDownloadByToken(token) {
    if (!token) {
      return null;
    }
    const { rows } = await this.pool.query('SELECT doc FROM app_downloads WHERE token = $1', [token]);
    return rows.length ? rows[0].doc : null;
  }

  async purgeDownloadsBefore(before) {
    const { rowCount } = await this.pool.query('DELETE FROM app_downloads WHERE downloaded_at < $1', [before]);
    return rowCount;
  }

  // --- Comments ---

  async createComment({ photoId, userId, userDisplayName, authorRole, body }) {
    const comment = {
      id: crypto.randomUUID(),
      photoId,
      userId: userId || null,
      userDisplayName: userDisplayName || null,
      authorRole: authorRole || 'user',
      body: body || '',
      deletedAt: null,
      deletedBy: null,
      createdAt: new Date().toISOString(),
    };
    await this.pool.query('INSERT INTO app_comments (id, photo_id, doc) VALUES ($1, $2, $3)', [
      comment.id,
      String(photoId),
      comment,
    ]);
    return { ...comment };
  }

  async findCommentById(id) {
    return this.one('app_comments', id);
  }

  async listCommentsByPhoto(photoId) {
    const { rows } = await this.pool.query('SELECT doc FROM app_comments WHERE photo_id = $1', [String(photoId)]);
    return rows.map((r) => r.doc).sort(byCreatedAsc);
  }

  async listCommentsByUser(userId) {
    return (await this.all('app_comments')).filter((c) => c.userId === userId);
  }

  async softDeleteComment(id, deletedBy) {
    return this.tx(async (c) => {
      const comment = await this.one('app_comments', id, c, { lock: true });
      if (!comment || comment.deletedAt) {
        return null;
      }
      comment.deletedAt = new Date().toISOString();
      comment.deletedBy = deletedBy || null;
      return this.put('app_comments', comment, c);
    });
  }

  // --- Reports ---

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
    return this.insert('app_reports', report);
  }

  async listReports({ includeResolved = false } = {}) {
    return (await this.all('app_reports')).filter((r) => includeResolved || !r.resolvedAt).sort(byCreatedDesc);
  }

  async resolveReport(id, resolvedBy) {
    return this.tx(async (c) => {
      const r = await this.one('app_reports', id, c, { lock: true });
      if (!r || r.resolvedAt) {
        return null;
      }
      r.resolvedAt = new Date().toISOString();
      r.resolvedBy = resolvedBy || null;
      return this.put('app_reports', r, c);
    });
  }

  // --- Reactions ---

  async toggleReaction({ photoId, userId, emoji }) {
    return this.tx(async (c) => {
      const { rowCount } = await c.query(
        'DELETE FROM app_reactions WHERE photo_id = $1 AND user_id = $2 AND emoji = $3',
        [String(photoId), String(userId), emoji]
      );
      if (rowCount > 0) {
        return { on: false, emoji };
      }
      const reaction = { id: crypto.randomUUID(), photoId, userId, emoji, createdAt: new Date().toISOString() };
      await c.query(
        'INSERT INTO app_reactions (id, photo_id, user_id, emoji, doc) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING',
        [reaction.id, String(photoId), String(userId), emoji, reaction]
      );
      return { on: true, emoji };
    });
  }

  async listReactionsByPhoto(photoId) {
    const { rows } = await this.pool.query('SELECT doc FROM app_reactions WHERE photo_id = $1', [String(photoId)]);
    return rows.map((r) => r.doc);
  }

  async listReactionsByUser(userId) {
    const { rows } = await this.pool.query('SELECT doc FROM app_reactions WHERE user_id = $1', [String(userId)]);
    return rows.map((r) => r.doc);
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
    return this.insert('app_upload_profiles', profile);
  }

  async findUploadProfileById(id) {
    return this.one('app_upload_profiles', id);
  }

  async listUploadProfiles() {
    return (await this.all('app_upload_profiles')).sort(byName);
  }

  async updateUploadProfile(id, changes = {}) {
    return this.tx(async (c) => {
      const profile = await this.one('app_upload_profiles', id, c, { lock: true });
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
      return this.put('app_upload_profiles', profile, c);
    });
  }

  async deleteUploadProfile(id) {
    return this.tx(async (c) => {
      const { rowCount } = await c.query('DELETE FROM app_upload_profiles WHERE id = $1', [String(id)]);
      if (rowCount === 0) {
        return false;
      }
      for (const photo of await this.all('app_photos', c)) {
        if (photo.profileId === id) {
          photo.profileId = null;
          await this.put('app_photos', photo, c);
        }
      }
      return true;
    });
  }

  // --- Albums ---

  async createAlbum({ ownerId, name }) {
    const album = { id: crypto.randomUUID(), ownerId, name, photoIds: [], createdAt: new Date().toISOString() };
    await this.pool.query('INSERT INTO app_albums (id, owner_id, doc) VALUES ($1, $2, $3)', [
      album.id,
      String(ownerId),
      album,
    ]);
    return { ...album, photoIds: [] };
  }

  async findAlbumById(id) {
    return this.one('app_albums', id);
  }

  async listAlbumsByOwner(ownerId) {
    const { rows } = await this.pool.query('SELECT doc FROM app_albums WHERE owner_id = $1', [String(ownerId)]);
    return rows.map((r) => r.doc).sort(byName);
  }

  async addPhotoToAlbum(albumId, photoId) {
    return this.tx(async (c) => {
      const album = await this.one('app_albums', albumId, c, { lock: true });
      const photo = await this.one('app_photos', photoId, c);
      if (!album || !photo) {
        return null;
      }
      if (!album.photoIds.includes(photoId)) {
        album.photoIds.push(photoId);
        await this.put('app_albums', album, c);
      }
      return album;
    });
  }

  async removePhotoFromAlbum(albumId, photoId) {
    return this.tx(async (c) => {
      const album = await this.one('app_albums', albumId, c, { lock: true });
      if (!album) {
        return null;
      }
      album.photoIds = album.photoIds.filter((p) => p !== photoId);
      return this.put('app_albums', album, c);
    });
  }

  async deleteAlbum(id) {
    const { rowCount } = await this.pool.query('DELETE FROM app_albums WHERE id = $1', [String(id)]);
    return rowCount > 0;
  }

  // --- Governance requests ---

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
    return this.insert('app_governance_requests', req);
  }

  async findGovernanceRequest(id) {
    return this.one('app_governance_requests', id);
  }

  async listGovernanceRequests({ status } = {}) {
    return (await this.all('app_governance_requests')).filter((r) => !status || r.status === status).sort(byCreatedDesc);
  }

  /** Move a pending request to a final status exactly once (row lock). */
  async decideGovernanceRequest(id, { status, decidedBy }) {
    return this.tx(async (c) => {
      const r = await this.one('app_governance_requests', id, c, { lock: true });
      if (!r || r.status !== 'pending') {
        return null;
      }
      r.status = status;
      r.decidedBy = decidedBy || null;
      r.decidedAt = new Date().toISOString();
      return this.put('app_governance_requests', r, c);
    });
  }

  // --- Settings ---

  async getSetting(key) {
    const { rows } = await this.pool.query('SELECT value FROM app_settings WHERE key = $1', [key]);
    return rows.length ? rows[0].value : null;
  }

  async setSettingIfAbsent(key, value) {
    await this.pool.query('INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [
      key,
      value,
    ]);
    return this.getSetting(key);
  }

  // --- Auth failure states ---

  async getAuthFailureState(key) {
    const { rows } = await this.pool.query('SELECT count, locked_until FROM app_auth_failures WHERE key = $1', [key]);
    return rows.length ? { count: rows[0].count, lockedUntil: Number(rows[0].locked_until) } : { count: 0, lockedUntil: 0 };
  }

  async setAuthFailureState(key, state) {
    await this.pool.query(
      `INSERT INTO app_auth_failures (key, count, locked_until) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET count = EXCLUDED.count, locked_until = EXCLUDED.locked_until`,
      [key, state.count || 0, state.lockedUntil || 0]
    );
    return state;
  }

  async clearAuthFailureState(key) {
    await this.pool.query('DELETE FROM app_auth_failures WHERE key = $1', [key]);
  }

  // Every counter for one sign-in identity: `acct:<id>` and each
  // `ip:<ip>:<id>`. Compared with right() rather than LIKE so an identity
  // holding % or _ cannot widen the match.
  async listAuthFailureStatesFor(identity) {
    const { rows } = await this.pool.query(
      `SELECT key, count, locked_until FROM app_auth_failures
       WHERE key = $1 OR (left(key, 3) = 'ip:' AND right(key, char_length($2)) = $2)`,
      [`acct:${identity}`, `:${identity}`]
    );
    return rows.map((r) => ({ key: r.key, count: r.count, lockedUntil: Number(r.locked_until) }));
  }

  async clearAuthFailureStatesFor(identity) {
    const { rowCount } = await this.pool.query(
      `DELETE FROM app_auth_failures
       WHERE key = $1 OR (left(key, 3) = 'ip:' AND right(key, char_length($2)) = $2)`,
      [`acct:${identity}`, `:${identity}`]
    );
    return rowCount;
  }

  // --- Security audit trail (append-only, hash-chained) ---

  static rowToEvent(row) {
    return {
      id: row.id,
      seq: Number(row.seq),
      at: new Date(row.at).toISOString(),
      type: row.type,
      actorId: row.actor_id,
      targetType: row.target_type,
      targetId: row.target_id,
      details: row.details,
      detailsHash: row.details_hash,
      prevHash: row.prev_hash,
      hash: row.hash,
      redacted: row.redacted === true,
    };
  }

  async appendSecurityAuditEvent(input) {
    return this.tx(async (c) => {
      // One writer at a time keeps seq and prev_hash a single unbroken chain.
      await c.query('SELECT pg_advisory_xact_lock($1)', [AUDIT_LOCK_ID]);
      const { rows } = await c.query('SELECT * FROM security_audit_events ORDER BY seq DESC LIMIT 1');
      const prev = rows.length ? PgStore.rowToEvent(rows[0]) : null;
      const e = buildEvent(prev, input);
      await c.query(
        `INSERT INTO security_audit_events
           (seq, id, at, type, actor_id, target_type, target_id, details, details_hash, prev_hash, hash, redacted)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, false)`,
        [
          e.seq,
          e.id,
          e.at,
          e.type,
          e.actorId,
          e.targetType,
          e.targetId === null || e.targetId === undefined ? null : String(e.targetId),
          e.details,
          e.detailsHash,
          e.prevHash,
          e.hash,
        ]
      );
      return { ...e };
    });
  }

  async listSecurityAuditEvents() {
    const { rows } = await this.pool.query('SELECT * FROM security_audit_events ORDER BY seq ASC');
    return rows.map(PgStore.rowToEvent);
  }

  async redactAuditDetailsBefore(before) {
    const { rows } = await this.pool.query('SELECT redact_audit_details_before($1) AS n', [before]);
    return Number(rows[0].n);
  }
}

module.exports = { PgStore };
