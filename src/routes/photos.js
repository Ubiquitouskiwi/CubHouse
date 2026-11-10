'use strict';

const Busboy = require('busboy');
const { createRouter } = require('../security/asyncRouter');
const { requireAuth, requireParent } = require('../auth');
const {
  photoCapabilities,
  canViewPhoto,
  canComment,
  canDeleteComment,
  canReact,
  profilePermissions,
  normalizePhotoAudience,
  isValidPhotoAudience,
  isValidReactionEmoji,
  isWideningPhotoChange,
  PHOTO_AUDIENCE,
  REACTION_EMOJIS,
  ROLES,
} = require('../permissions');
const { newTraceToken, renderDownload, readTraceToken, shortRef } = require('../phototrace');
const { UploadRejected } = require('../media/pipeline');
const { truncateIp, clientIp } = require('../security/clientInfo');
const { safeReturnPath } = require('../security/sessionGuard');
const { audit } = require('../audit');
const { str, strList, validateCaption } = require('../validation');

const UPLOAD_PATHS = ['/photos/upload', '/photos/trace'];

/**
 * The bulk uploader on Home sends each file with `Accept: application/json`
 * and reads back `{ ok, photo }` or `{ ok: false, error: { code, message } }`.
 * Plain form posts (no JavaScript) still get a flash message and a redirect.
 */
function wantsJson(req) {
  return req.accepts(['html', 'json']) === 'json';
}

function uploadError(code, message) {
  return { ok: false, error: { code, message } };
}

/**
 * Streaming multipart parser for the two routes that accept a file. Runs
 * BEFORE the CSRF check (so the token field can be read from the body) but
 * only for signed-in users, with a hard byte cap. The file is held in memory
 * only until the media pipeline re-encodes it; the original never reaches
 * storage.
 */
function createUploadParser({ config }) {
  return function uploadParser(req, res, next) {
    if (req.method !== 'POST' || !UPLOAD_PATHS.includes(req.path)) {
      return next();
    }
    if (!req.session || !req.session.userId) {
      if (wantsJson(req)) {
        return res.status(401).json(uploadError('signed_out', 'You were signed out. Please sign in again.'));
      }
      return res.redirect('/login');
    }
    if (!req.is('multipart/form-data')) {
      req.body = req.body || {};
      return next();
    }
    let busboy;
    try {
      busboy = Busboy({
        headers: req.headers,
        limits: { files: 1, fileSize: config.uploads.maxBytes, fields: 10, fieldSize: 4096 },
      });
    } catch (err) {
      return next(err);
    }
    const body = {};
    const chunks = [];
    let truncated = false;
    let gotFile = false;
    busboy.on('field', (name, value) => {
      if (!(name in body)) {
        body[name] = value;
      }
    });
    busboy.on('file', (name, stream) => {
      if (name !== 'image' || gotFile) {
        stream.resume();
        return;
      }
      gotFile = true;
      stream.on('data', (c) => chunks.push(c));
      stream.on('limit', () => {
        truncated = true;
      });
    });
    busboy.on('error', next);
    busboy.on('close', () => {
      req.body = body;
      req.uploadFile = truncated ? { tooLarge: true } : gotFile ? { buffer: Buffer.concat(chunks) } : null;
      next();
    });
    return req.pipe(busboy);
  };
}

function viewerFrom(user) {
  return { role: user.role, id: user.id, groupIds: user.groupIds || [], commentsMuted: user.commentsMuted };
}

const on = (v) => v === 'on' || v === 'true';

function notFound(res, what = 'photo') {
  return res.status(404).render('error', { title: 'Not Found', message: `That ${what} could not be found.` });
}

function photoRoutes(ctx) {
  const { store, config, media, governance, actions, notifier, limiters, requireStepUp } = ctx;
  const router = createRouter();

  /**
   * Apply the same permission changes to some photos. Restricting changes
   * apply immediately; if ANY photo would be widened (whole-family visibility
   * or newly downloadable), the change goes through two-guardian governance.
   * Returns a flash message.
   */
  async function applyPhotoChanges(req, photos, changes, summary) {
    const ids = photos.map((p) => p.id);
    if (ids.length === 0) {
      return { level: 'error', message: 'No photos were selected.' };
    }
    // Judge widening by who can actually see the photo, not by how the
    // audience is spelled (listing every member equals "everyone").
    const members = (await store.listUsers()).filter(
      (u) => !u.disabled && u.role !== ROLES.PARENT && u.role !== ROLES.OPERATOR
    );
    const widening = photos.some((p) => isWideningPhotoChange(p, { ...p, ...changes }, members));
    if (widening) {
      const outcome = await governance.requestAction(req, {
        type: 'photos.update',
        payload: { ids, changes },
        summary,
      });
      if (outcome.status === 'pending') {
        return {
          level: 'success',
          pending: true,
          message: 'This widens who can see or download photos, so it is waiting for guardian approval.',
        };
      }
      return { level: 'success', message: outcome.result.message };
    }
    const count = await store.bulkUpdatePhotos(ids, changes);
    await audit(store, req, 'photos.permissions_changed', {
      targetType: 'photo',
      targetId: ids.length === 1 ? ids[0] : null,
      details: { count, changes: Object.keys(changes) },
    });
    return { level: 'success', message: count === 1 ? 'Photo updated.' : `${count} photos updated.` };
  }

  // --- Gallery ---

  router.get('/photos', requireAuth, async (req, res) => {
    const viewer = viewerFrom(req.user);
    const visible = (await store.listPhotos()).filter((photo) => canViewPhoto(viewer, photo));
    const libraryCan = photoCapabilities(viewer);
    res.render('photos', {
      title: 'Photos',
      user: req.user,
      viewer,
      photos: visible,
      capFor: (photo) => photoCapabilities(viewer, photo),
      libraryCan,
      profiles: libraryCan.setPermissions ? await store.listUploadProfiles() : [],
    });
  });

  // --- App-gated media: every byte request is authorized ---

  router.get('/media/:photoId/:variant', requireAuth, async (req, res) => {
    const variant = req.params.variant;
    if (variant !== 'thumb' && variant !== 'display' && variant !== 'full') {
      return res.status(404).end();
    }
    const photo = await store.findPhotoById(req.params.photoId);
    const viewer = viewerFrom(req.user);
    if (!photo || !canViewPhoto(viewer, photo)) {
      return res.status(404).end();
    }
    // Viewing never hands out the full original. Members get it only through
    // the download route, which checks the download permission and traces it.
    if (variant === 'full' && req.user.role !== ROLES.PARENT) {
      return res.status(404).end();
    }
    const bytes = await media.read(photo, variant);
    if (!bytes) {
      return res.status(404).end();
    }
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(bytes);
  });

  // --- Contribute a photo ---

  router.post('/photos/upload', requireAuth, limiters.uploadLimiter, async (req, res) => {
    const user = req.user;
    const back = safeReturnPath(req, '/photos');
    const json = wantsJson(req);
    const fail = (status, code, message) => {
      if (json) {
        return res.status(status).json(uploadError(code, message));
      }
      req.flash('error', message);
      return res.redirect(back);
    };
    const done = (photo, sharing, message) => {
      if (json) {
        return res.status(201).json({
          ok: true,
          photo: {
            id: photo.id,
            pending: photo.pendingApproval === true,
            // Only a guardian can open a new photo; a contribution is hidden
            // from its sender until it is approved.
            url: user.role === ROLES.PARENT ? `/photos/${photo.id}` : null,
          },
          sharing,
          message,
        });
      }
      req.flash('success', message);
      return res.redirect(back);
    };
    const file = req.uploadFile;
    if (!file || (!file.buffer && !file.tooLarge)) {
      return fail(400, 'no_file', 'Choose a photo to upload.');
    }
    if (file.tooLarge) {
      const mb = Math.round(config.uploads.maxBytes / (1024 * 1024));
      return fail(413, 'too_large', `That photo is too large. Please keep uploads under ${mb} MB.`);
    }
    const captionCheck = validateCaption(req.body.caption);
    if (!captionCheck.ok) {
      return fail(400, 'bad_caption', captionCheck.error);
    }

    let ingested;
    try {
      ingested = await media.ingest(file.buffer);
    } catch (err) {
      if (err instanceof UploadRejected) {
        return fail(422, err.code, err.userMessage);
      }
      throw err;
    }

    const isParent = user.role === ROLES.PARENT;
    // Every photo starts PRIVATE (parents only). A contribution also waits for
    // approval. Nothing is shared until a guardian deliberately chooses.
    const photo = await store.createPhoto({
      caption: captionCheck.value,
      mediaId: ingested.mediaId,
      variants: ingested.variants,
      width: ingested.width,
      height: ingested.height,
      uploadedBy: user.id,
      uploadedByName: user.displayName,
      pendingApproval: !isParent,
      hidden: false,
      downloadable: false,
      watermark: true,
      audienceType: PHOTO_AUDIENCE.PARENTS,
    });
    await audit(store, req, 'photo.uploaded', { targetType: 'photo', targetId: photo.id, details: { pending: !isParent } });

    if (!isParent) {
      await notifier.notifyGuardians(store, {
        subject: 'A photo is waiting for approval',
        text: `${user.displayName} sent in a photo. It stays private until a guardian approves it.`,
      });
      return done(photo, 'awaiting_approval', 'Thanks! Your photo was sent to the parents for approval.');
    }

    // A parent may pick an upload profile to share it right away.
    const profileId = str(req.body.profileId, { field: 'profileId' });
    if (profileId) {
      const profile = await store.findUploadProfileById(profileId);
      if (profile) {
        const result = await applyPhotoChanges(
          req,
          [photo],
          { profileId: profile.id, publishedBy: user.id, ...profilePermissions(profile) },
          `Share a new photo using the "${profile.name}" profile`
        );
        if (!json) {
          req.flash(result.level, `Photo uploaded. ${result.message}`);
          return res.redirect(back);
        }
        return done(photo, result.pending ? 'awaiting_guardian' : 'shared', `Photo uploaded. ${result.message}`);
      }
    }
    return done(photo, 'private', 'Photo uploaded. It is private to parents until you share it.');
  });

  // --- Download history and leak tracing (parents) ---

  router.get('/photos/downloads', requireParent, async (req, res) => {
    const [downloads, photos] = await Promise.all([store.listDownloads(), store.listPhotos()]);
    const captions = new Map(photos.map((p) => [p.id, p.caption]));
    res.render('downloads', {
      title: 'Download history',
      user: req.user,
      downloads: downloads.map((d) => ({ ...d, ref: d.token ? shortRef(d.token) : '', caption: captions.get(d.photoId) || '' })),
      retentionDays: config.privacy.downloadRetentionDays,
      traceResult: null,
    });
  });

  // A guardian uploads a copy found elsewhere; the embedded reference token is
  // resolved against the ledger. Nothing about the file is stored.
  router.post('/photos/trace', requireParent, async (req, res) => {
    const file = req.uploadFile;
    let traceResult = { found: false, message: 'Choose the image file you found.' };
    if (file && file.buffer) {
      const token = await readTraceToken(file.buffer);
      const hit = token ? await store.findDownloadByToken(token) : null;
      traceResult = hit
        ? { found: true, download: { ...hit, ref: shortRef(hit.token) } }
        : {
            found: false,
            message: token
              ? 'This file has a reference, but it is not in the ledger (it may be older than the retention period).'
              : 'No reference was found in this file. It may have been screenshotted or re-saved; check for a visible reference code in the corner.',
          };
      await audit(store, req, 'photo.trace_lookup', { details: { found: Boolean(hit) } });
    }
    const downloads = await store.listDownloads();
    res.render('downloads', {
      title: 'Download history',
      user: req.user,
      downloads: downloads.map((d) => ({ ...d, ref: d.token ? shortRef(d.token) : '', caption: '' })),
      retentionDays: config.privacy.downloadRetentionDays,
      traceResult,
    });
  });

  // --- Single photo ---

  router.get('/photos/:id', requireAuth, async (req, res) => {
    const user = req.user;
    const viewer = viewerFrom(user);
    const photo = await store.findPhotoById(req.params.id);
    if (!photo || !canViewPhoto(viewer, photo)) {
      return notFound(res);
    }
    const cap = photoCapabilities(viewer, photo);
    let members = [];
    let groups = [];
    let downloads = [];
    let profiles = [];
    if (cap.setPermissions) {
      [members, groups, downloads, profiles] = await Promise.all([
        store.listUsers(),
        store.listGroups(),
        store.listDownloadsByPhoto(photo.id),
        store.listUploadProfiles(),
      ]);
      members = members.filter((m) => !m.disabled && m.role !== ROLES.OPERATOR);
    }
    const [albums, allComments, reactionSummary] = await Promise.all([
      store.listAlbumsByOwner(user.id),
      store.listCommentsByPhoto(photo.id),
      store.reactionSummary(photo.id, user.id),
    ]);
    // Members never see removed comments; guardians see them, marked.
    const comments = cap.setPermissions ? allComments : allComments.filter((c) => !c.deletedAt);

    return res.render('photo', {
      title: photo.caption || 'Photo',
      user,
      viewer,
      photo,
      cap,
      members,
      groups,
      downloads: downloads.map((d) => ({ ...d, ref: d.token ? shortRef(d.token) : '' })),
      profiles,
      albums,
      audiences: PHOTO_AUDIENCE,
      reactionEmojis: REACTION_EMOJIS,
      comments,
      reactionCounts: reactionSummary.counts,
      myReactions: reactionSummary.mine,
      canComment: canComment(viewer, photo),
      canReact: canReact(viewer, photo),
      canDeleteComment: (c) => !c.deletedAt && canDeleteComment(viewer, c),
    });
  });

  // --- Traced download ---

  router.get('/photos/:id/download', requireAuth, async (req, res) => {
    const user = req.user;
    const viewer = viewerFrom(user);
    const photo = await store.findPhotoById(req.params.id);
    if (!photo || !canViewPhoto(viewer, photo)) {
      return notFound(res);
    }
    const cap = photoCapabilities(viewer, photo);
    if (!cap.download) {
      req.flash('error', 'That photo is not available for download.');
      return res.redirect(`/photos/${photo.id}`);
    }
    const full = await media.read(photo, 'full');
    if (!full) {
      return notFound(res);
    }
    const token = newTraceToken();
    // Parents downloading their own photos are not watermarked.
    const watermark = user.role !== ROLES.PARENT && photo.watermark !== false;
    const traced = await renderDownload(full, { token, watermark });

    // The ledger row is written BEFORE any bytes are sent.
    await store.recordDownload({
      token,
      userId: user.id,
      userDisplayName: user.displayName,
      photoId: photo.id,
      ipNet: truncateIp(clientIp(req)),
      userAgent: config.privacy.ledgerStoresUserAgent ? String(req.get('user-agent') || '').slice(0, 200) : null,
      watermarked: traced.watermarkApplied,
      metadataEmbedded: traced.metadataEmbedded,
    });
    await audit(store, req, 'photo.downloaded', { targetType: 'photo', targetId: photo.id });

    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Content-Disposition', `attachment; filename="${config.app.slug}-${shortRef(token).toLowerCase()}.jpg"`);
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return res.send(traced.buffer);
  });

  // --- Parent-only changes ---

  function readAudience(body) {
    const raw = str(body.audienceType, { field: 'audienceType' });
    const audienceType = isValidPhotoAudience(raw) ? raw : PHOTO_AUDIENCE.PARENTS;
    return {
      audienceType,
      audienceUserIds: audienceType === PHOTO_AUDIENCE.USERS ? strList(body.audienceUserIds) : [],
      audienceGroupIds: audienceType === PHOTO_AUDIENCE.GROUPS ? strList(body.audienceGroupIds) : [],
    };
  }

  router.post('/photos/:id/permissions', requireParent, requireStepUp, async (req, res) => {
    const photo = await store.findPhotoById(req.params.id);
    if (!photo) {
      req.flash('error', 'That photo no longer exists.');
      return res.redirect('/photos');
    }
    const downloadable = on(req.body.downloadable);
    const changes = {
      hidden: on(req.body.hidden),
      downloadable,
      // Watermark defaults ON whenever download is enabled.
      watermark: downloadable ? req.body.watermarkOff !== 'on' : true,
      commentsEnabled: on(req.body.commentsEnabled),
      reactionsEnabled: on(req.body.reactionsEnabled),
      ...readAudience(req.body),
      publishedBy: req.user.id,
    };
    const result = await applyPhotoChanges(req, [photo], changes, `Change sharing on "${photo.caption || 'a photo'}"`);
    req.flash(result.level, result.message);
    return res.redirect(`/photos/${photo.id}`);
  });

  router.post('/photos/:id/toggle-hidden', requireParent, async (req, res) => {
    const photo = await store.findPhotoById(req.params.id);
    if (photo) {
      const result = await applyPhotoChanges(
        req,
        [photo],
        { hidden: !photo.hidden },
        `Show "${photo.caption || 'a photo'}" again`
      );
      req.flash(result.level, photo.hidden ? result.message : 'Photo hidden.');
    }
    return res.redirect(safeReturnPath(req, '/photos'));
  });

  router.post('/photos/:id/toggle-download', requireParent, async (req, res) => {
    const photo = await store.findPhotoById(req.params.id);
    if (photo) {
      const enabling = !photo.downloadable;
      const result = await applyPhotoChanges(
        req,
        [photo],
        enabling ? { downloadable: true, watermark: true } : { downloadable: false },
        `Allow downloading "${photo.caption || 'a photo'}"`
      );
      req.flash(result.level, enabling ? result.message : 'Download is now locked for this photo.');
    }
    return res.redirect(safeReturnPath(req, '/photos'));
  });

  // Approve a contribution. The guardian must choose who sees it; there is no
  // silent default to "everyone".
  router.post('/photos/:id/approve', requireParent, async (req, res) => {
    const photo = await store.findPhotoById(req.params.id);
    if (!photo || photo.pendingApproval !== true) {
      req.flash('error', 'That photo is not awaiting approval.');
      return res.redirect('/home');
    }
    const rawAudience = str(req.body.audienceType, { field: 'audienceType' });
    if (!isValidPhotoAudience(rawAudience)) {
      req.flash('error', 'Choose who should see this photo before approving it.');
      return res.redirect('/home');
    }
    const result = await applyPhotoChanges(
      req,
      [photo],
      { pendingApproval: false, hidden: false, ...readAudience(req.body), publishedBy: req.user.id },
      `Approve "${photo.caption || 'a contributed photo'}" for the whole family`
    );
    req.flash(result.level, result.message === 'Photo updated.' ? 'Photo approved.' : result.message);
    return res.redirect('/home');
  });

  router.post('/photos/:id/reject', requireParent, async (req, res) => {
    const photo = await store.findPhotoById(req.params.id);
    if (!photo || photo.pendingApproval !== true) {
      req.flash('error', 'That photo is not awaiting approval.');
      return res.redirect('/home');
    }
    const removed = await actions.deletePhotoCompletely(photo.id);
    await audit(store, req, 'photo.rejected', { targetType: 'photo', targetId: photo.id, details: { objects: removed.removedKeys.length } });
    req.flash('success', 'Photo rejected and permanently removed.');
    return res.redirect('/home');
  });

  // Deleting one photo reduces exposure, so one guardian may do it, but it is
  // permanent: step-up, audit, and tell the other guardian.
  router.post('/photos/:id/delete', requireParent, requireStepUp, async (req, res) => {
    const removed = await actions.deletePhotoCompletely(req.params.id);
    if (!removed) {
      req.flash('error', 'That photo no longer exists.');
      return res.redirect('/photos');
    }
    await audit(store, req, 'photo.deleted', { targetType: 'photo', targetId: req.params.id, details: { objects: removed.removedKeys.length } });
    await notifier.notifyGuardians(store, {
      subject: 'A photo was deleted',
      text: `${req.user.displayName} permanently deleted a photo.`,
      excludeUserId: req.user.id,
    });
    req.flash('success', 'Photo permanently deleted. Copies already downloaded by family cannot be recalled.');
    return res.redirect('/photos');
  });

  const BULK_ACTIONS = Object.freeze({
    hide: { changes: { hidden: true } },
    unhide: { changes: { hidden: false } },
    'lock-download': { changes: { downloadable: false } },
    'allow-download': { changes: { downloadable: true, watermark: true } },
    'watermark-on': { changes: { watermark: true } },
    'watermark-off': { changes: { watermark: false } },
  });

  router.post('/photos/bulk', requireParent, requireStepUp, async (req, res) => {
    const action = str(req.body.action, { field: 'action' });
    const ids = strList(req.body.photoIds);
    const photos = (await Promise.all(ids.map((id) => store.findPhotoById(id)))).filter(Boolean);
    if (photos.length === 0) {
      req.flash('error', 'No photos were selected.');
      return res.redirect('/photos');
    }

    if (action === 'delete') {
      const outcome = await governance.requestAction(req, {
        type: 'photos.delete',
        payload: { ids: photos.map((p) => p.id) },
        summary: `Permanently delete ${photos.length} photo(s)`,
      });
      req.flash(
        'success',
        outcome.status === 'pending' ? 'Bulk delete is waiting for guardian approval.' : outcome.result.message
      );
      return res.redirect('/photos');
    }

    if (action === 'move-to-profile') {
      const profileId = str(req.body.profileId, { field: 'profileId' });
      if (!profileId) {
        const count = await store.bulkUpdatePhotos(photos.map((p) => p.id), { profileId: null });
        req.flash('success', `${count} photo(s) detached from their profile.`);
        return res.redirect('/photos');
      }
      const profile = await store.findUploadProfileById(profileId);
      if (!profile) {
        req.flash('error', 'That upload profile no longer exists.');
        return res.redirect('/photos');
      }
      const result = await applyPhotoChanges(
        req,
        photos,
        { profileId: profile.id, publishedBy: req.user.id, ...profilePermissions(profile) },
        `Apply the "${profile.name}" profile to ${photos.length} photo(s)`
      );
      req.flash(result.level, result.message);
      return res.redirect('/photos');
    }

    const spec = BULK_ACTIONS[action];
    if (!spec) {
      req.flash('error', 'Unknown bulk action.');
      return res.redirect('/photos');
    }
    const result = await applyPhotoChanges(req, photos, spec.changes, `Bulk "${action}" on ${photos.length} photo(s)`);
    req.flash(result.level, result.message);
    return res.redirect('/photos');
  });

  router.post('/photos/:id/profile', requireParent, async (req, res) => {
    const photo = await store.findPhotoById(req.params.id);
    if (!photo) {
      req.flash('error', 'That photo no longer exists.');
      return res.redirect('/photos');
    }
    const profileId = str(req.body.profileId, { field: 'profileId' });
    if (!profileId) {
      await store.updatePhoto(photo.id, { profileId: null });
      req.flash('success', 'Photo detached from its upload profile.');
      return res.redirect(`/photos/${photo.id}`);
    }
    const profile = await store.findUploadProfileById(profileId);
    if (!profile) {
      req.flash('error', 'That upload profile no longer exists.');
      return res.redirect(`/photos/${photo.id}`);
    }
    const result = await applyPhotoChanges(
      req,
      [photo],
      { profileId: profile.id, publishedBy: req.user.id, ...profilePermissions(profile) },
      `Apply the "${profile.name}" profile`
    );
    req.flash(result.level, result.message);
    return res.redirect(`/photos/${photo.id}`);
  });

  // --- Comments ---

  router.post('/photos/:id/comments', requireAuth, limiters.commentLimiter, async (req, res) => {
    const user = req.user;
    const viewer = viewerFrom(user);
    const photo = await store.findPhotoById(req.params.id);
    if (!photo || !canViewPhoto(viewer, photo)) {
      return notFound(res);
    }
    if (!canComment(viewer, photo)) {
      req.flash('error', user.commentsMuted ? 'Commenting is paused on your account.' : 'Comments are turned off for this photo.');
      return res.redirect(`/photos/${photo.id}`);
    }
    const body = str(req.body.body, { field: 'body', max: 4000 });
    if (!body) {
      req.flash('error', 'Write something before posting.');
      return res.redirect(`/photos/${photo.id}`);
    }
    if (body.length > 2000) {
      req.flash('error', 'Comments must be 2000 characters or fewer.');
      return res.redirect(`/photos/${photo.id}`);
    }
    await store.createComment({
      photoId: photo.id,
      userId: user.id,
      userDisplayName: user.displayName,
      authorRole: user.role,
      body,
    });
    req.flash('success', 'Comment posted.');
    return res.redirect(`/photos/${photo.id}#comments`);
  });

  // Soft delete: hidden from members, kept for guardians as a record.
  router.post('/photos/:id/comments/:commentId/delete', requireAuth, async (req, res) => {
    const viewer = viewerFrom(req.user);
    const comment = await store.findCommentById(req.params.commentId);
    if (!comment || comment.photoId !== req.params.id || comment.deletedAt) {
      req.flash('error', 'That comment no longer exists.');
      return res.redirect(`/photos/${req.params.id}#comments`);
    }
    if (!canDeleteComment(viewer, comment)) {
      req.flash('error', 'You cannot delete that comment.');
      return res.redirect(`/photos/${req.params.id}#comments`);
    }
    await store.softDeleteComment(comment.id, req.user.id);
    await audit(store, req, 'comment.removed', { targetType: 'comment', targetId: comment.id });
    req.flash('success', 'Comment removed.');
    return res.redirect(`/photos/${req.params.id}#comments`);
  });

  router.post('/photos/:id/comments/:commentId/report', requireAuth, limiters.commentLimiter, async (req, res) => {
    const viewer = viewerFrom(req.user);
    const photo = await store.findPhotoById(req.params.id);
    const comment = await store.findCommentById(req.params.commentId);
    if (!photo || !canViewPhoto(viewer, photo) || !comment || comment.photoId !== photo.id) {
      return notFound(res, 'comment');
    }
    await store.createReport({
      photoId: photo.id,
      commentId: comment.id,
      reportedBy: req.user.id,
      reason: str(req.body.reason, { field: 'reason', max: 500 }),
    });
    await notifier.notifyGuardians(store, {
      subject: 'A comment was reported',
      text: 'A family member reported a comment. Review it in Admin, Reports.',
    });
    req.flash('success', 'Thanks. The parents will take a look.');
    return res.redirect(`/photos/${photo.id}#comments`);
  });

  // --- Reactions ---

  router.post('/photos/:id/react', requireAuth, limiters.commentLimiter, async (req, res) => {
    const viewer = viewerFrom(req.user);
    const photo = await store.findPhotoById(req.params.id);
    if (!photo || !canViewPhoto(viewer, photo)) {
      return notFound(res);
    }
    if (!canReact(viewer, photo)) {
      req.flash('error', 'Reactions are turned off for this photo.');
      return res.redirect(`/photos/${photo.id}`);
    }
    const emoji = str(req.body.emoji, { field: 'emoji', max: 16 });
    if (!isValidReactionEmoji(emoji)) {
      req.flash('error', 'That reaction is not available.');
      return res.redirect(`/photos/${photo.id}`);
    }
    await store.toggleReaction({ photoId: photo.id, userId: req.user.id, emoji });
    return res.redirect(`/photos/${photo.id}`);
  });

  void normalizePhotoAudience;
  return router;
}

module.exports = photoRoutes;
module.exports.createUploadParser = createUploadParser;
