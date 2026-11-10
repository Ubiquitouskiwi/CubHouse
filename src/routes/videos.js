'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');

const { createRouter } = require('../security/asyncRouter');
const { requireAuth } = require('../auth');
const { photoCapabilities, canViewPhoto, ROLES } = require('../permissions');
const { audit } = require('../audit');
const { validateCaption, str } = require('../validation');
const { logger, errorFields } = require('../logger');
const { videoManifest } = require('../media');
const { parseRange } = require('../media/range');
const { assertAcceptableProbe, VIDEO_MESSAGES } = require('../media/video');
const { UploadRejected } = require('../media/pipeline');
const { VideoUploadError } = require('../media/videoUploads');

/**
 * Video routes. Everything answers JSON (the bulk uploader on Home is the
 * only caller) except the stream, which answers bytes.
 *
 *   POST   /videos/uploads                  start an upload session
 *   GET    /videos/uploads/:id              which chunks arrived (to resume)
 *   PUT    /videos/uploads/:id/chunks/:n    one chunk (raw bytes)
 *   POST   /videos/uploads/:id/complete     probe it and queue processing
 *   DELETE /videos/uploads/:id              cancel
 *   GET    /videos/jobs/:id                 processing status (owner only)
 *   GET    /media/:photoId/video            the stream (HTTP Range)
 *
 * Every request: signed in (requireAuth: session checks, disabled accounts,
 * session version), CSRF token on every write (global middleware; header
 * X-CSRF-Token), allowed to contribute, and the session or job must be the
 * caller's own (anything else is a plain 404). The stream runs the same
 * audience check as photos BEFORE any byte is read.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function viewerFrom(user) {
  return { role: user.role, id: user.id, groupIds: user.groupIds || [], commentsMuted: user.commentsMuted };
}

function jsonError(res, status, code, message) {
  return res.status(status).json({ ok: false, error: { code, message } });
}

function waitDrainOrClose(res) {
  return new Promise((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

function videoRoutes(ctx) {
  const { store, videoConfig, media, limiters, videoUploads, videoQueue, ffmpeg } = ctx;
  const router = createRouter();

  const gone = (res) =>
    jsonError(res, 404, 'upload_gone', 'This upload expired or was cancelled. Select Retry to send the video again.');

  /** Signed in AND allowed to add photos/videos (parents, and members as contributions). */
  function mayContribute(req, res, next) {
    if (!photoCapabilities(viewerFrom(req.user)).contribute) {
      return jsonError(res, 403, 'not_allowed', 'Your account cannot add videos.');
    }
    return next();
  }

  function sessionFor(req) {
    const id = String(req.params.id || '');
    return UUID_RE.test(id) ? videoUploads.get(id, req.user.id) : null;
  }

  function sendUploadError(res, err) {
    if (err instanceof VideoUploadError) {
      if (err.status >= 400 && err.status !== 409) {
        // The rest of the body may still be arriving; do not keep the socket.
        res.setHeader('Connection', 'close');
      }
      return jsonError(res, err.status, err.code, err.userMessage);
    }
    throw err;
  }

  // --- Upload sessions ---

  router.post('/videos/uploads', requireAuth, limiters.videoUploadLimiter, mayContribute, async (req, res) => {
    const captionCheck = validateCaption(req.body.caption);
    if (!captionCheck.ok) {
      return jsonError(res, 400, 'bad_caption', captionCheck.error);
    }
    if (!(await ffmpeg.isAvailable())) {
      logger.error('video upload refused: ffmpeg/ffprobe are not installed');
      return jsonError(res, 503, 'video_unavailable', 'Videos cannot be added right now. Please tell a guardian.');
    }
    try {
      const s = await videoUploads.create(req.user, {
        size: str(req.body.size, { field: 'size', max: 20 }),
        durationMs: str(req.body.durationMs, { field: 'durationMs', max: 20 }) || undefined,
        caption: captionCheck.value,
      });
      return res.status(201).json({ ok: true, upload: videoUploads.view(s) });
    } catch (err) {
      return sendUploadError(res, err);
    }
  });

  router.get('/videos/uploads/:id', requireAuth, limiters.videoStatusLimiter, mayContribute, async (req, res) => {
    const s = sessionFor(req);
    return s ? res.json({ ok: true, upload: videoUploads.view(s) }) : gone(res);
  });

  router.put('/videos/uploads/:id/chunks/:index', requireAuth, limiters.videoUploadLimiter, mayContribute, async (req, res) => {
    const s = sessionFor(req);
    if (!s) {
      res.setHeader('Connection', 'close');
      return gone(res);
    }
    try {
      return res.json({ ok: true, upload: await videoUploads.writeChunk(s, req.params.index, req) });
    } catch (err) {
      return sendUploadError(res, err);
    }
  });

  router.delete('/videos/uploads/:id', requireAuth, limiters.videoUploadLimiter, mayContribute, async (req, res) => {
    const s = sessionFor(req);
    if (s) {
      await videoUploads.cancel(s);
    }
    return res.json({ ok: true });
  });

  router.post('/videos/uploads/:id/complete', requireAuth, limiters.videoUploadLimiter, mayContribute, async (req, res) => {
    const s = sessionFor(req);
    if (!s) {
      return gone(res);
    }
    let done;
    try {
      done = videoUploads.complete(s);
    } catch (err) {
      return sendUploadError(res, err);
    }
    // The server's own check, whatever the browser said: container, codec,
    // size on screen and, above all, the 3-minute limit.
    let probed;
    try {
      probed = assertAcceptableProbe(await ffmpeg.probe(done.file), videoConfig);
    } catch (err) {
      await fs.rm(done.file, { force: true });
      if (err instanceof UploadRejected) {
        return jsonError(res, 422, err.code, err.userMessage);
      }
      logger.warn(errorFields(err), 'ffprobe could not read an uploaded video');
      return jsonError(res, 422, 'unsupported_video', VIDEO_MESSAGES.unsupported_video);
    }

    const isParent = req.user.role === ROLES.PARENT;
    const jobId = crypto.randomUUID();
    // Move it into the queue's directory BEFORE the job exists, so the worker
    // never sees a job without its file.
    const src = videoQueue.jobFile(jobId, 'src');
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.rename(done.file, src);
    let job;
    try {
      job = await store.createVideoJob({
        id: jobId,
        ownerId: req.user.id,
        ownerName: req.user.displayName,
        bytes: done.size,
        durationMs: probed.durationMs,
        caption: done.caption,
        pendingApproval: !isParent,
      });
    } catch (err) {
      await fs.rm(src, { force: true });
      throw err;
    }
    videoUploads.settle(s.id);
    await audit(store, req, 'video.uploaded', {
      targetType: 'video_job',
      targetId: job.id,
      details: { pending: !isParent, megabytes: Math.ceil(done.size / (1024 * 1024)) },
    });
    return res.status(202).json({ ok: true, job: { id: job.id, status: 'processing' } });
  });

  // --- Processing status (the uploader only) ---

  router.get('/videos/jobs/:id', requireAuth, limiters.videoStatusLimiter, async (req, res) => {
    const id = String(req.params.id || '');
    const job = UUID_RE.test(id) ? await store.findVideoJob(id) : null;
    if (!job || job.ownerId !== req.user.id) {
      return jsonError(res, 404, 'not_found', 'That video could not be found.');
    }
    if (job.status === 'failed') {
      const code = VIDEO_MESSAGES[job.reason] ? job.reason : 'processing_failed';
      return res.json({ ok: true, job: { id: job.id, status: 'failed', code, message: VIDEO_MESSAGES[code] } });
    }
    if (job.status !== 'done') {
      return res.json({ ok: true, job: { id: job.id, status: job.status === 'running' ? 'processing' : 'waiting' } });
    }
    const photo = job.photoId ? await store.findPhotoById(job.photoId) : null;
    const isParent = req.user.role === ROLES.PARENT;
    return res.json({
      ok: true,
      job: {
        id: job.id,
        status: 'done',
        photo: photo
          ? { id: photo.id, kind: 'video', pending: photo.pendingApproval === true, url: isParent ? `/photos/${photo.id}` : null }
          : null,
        sharing: job.pendingApproval ? 'awaiting_approval' : 'private',
      },
    });
  });

  // --- The stream: Range-aware, decrypting only the segments it needs ---

  router.get('/media/:photoId/video', requireAuth, async (req, res) => {
    const photo = await store.findPhotoById(req.params.photoId);
    if (!photo || !canViewPhoto(viewerFrom(req.user), photo)) {
      return res.status(404).end();
    }
    const m = videoManifest(photo);
    if (!m) {
      return res.status(404).end();
    }
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Disposition', 'inline');
    res.setHeader('Cache-Control', 'private, no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const range = parseRange(req.get('range'), m.byteLength);
    if (range === 'unsatisfiable') {
      res.setHeader('Content-Range', `bytes */${m.byteLength}`);
      return res.status(416).end();
    }
    const start = range ? range.start : 0;
    const end = range ? range.end : m.byteLength - 1;
    res.status(range ? 206 : 200);
    if (range) {
      res.setHeader('Content-Range', `bytes ${start}-${end}/${m.byteLength}`);
    }
    res.setHeader('Content-Length', String(end - start + 1));
    if (req.method === 'HEAD') {
      return res.end();
    }
    try {
      for await (const part of media.readVideoRange(photo, start, end)) {
        if (res.destroyed) {
          return undefined;
        }
        if (!res.write(part)) {
          await waitDrainOrClose(res);
        }
      }
      return res.end();
    } catch (err) {
      logger.error({ ...errorFields(err), photoId: photo.id }, 'video stream failed');
      if (!res.headersSent) {
        res.removeHeader('Content-Range');
        res.removeHeader('Content-Length');
        return res.status(500).end();
      }
      return res.destroy();
    }
  });

  return router;
}

module.exports = videoRoutes;
