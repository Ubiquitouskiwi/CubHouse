'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const { logger, errorFields } = require('../logger');
const { audit } = require('../audit');
const { assertAcceptableProbe } = require('../media/video');
const { UploadRejected } = require('../media/pipeline');
const { PHOTO_AUDIENCE } = require('../permissions');

/**
 * Background video processing, persisted in the data store (app_video_jobs).
 *
 *   - ONE job at a time across every instance (the claim refuses while
 *     another job holds a live lease), polled every few seconds.
 *   - ffmpeg runs niced, with a thread cap and a timeout (src/media/ffmpeg.js).
 *   - A crash or restart mid-job leaves a lease that runs out; the job is then
 *     claimed again, up to VIDEO_MAX_ATTEMPTS runs, then marked failed with a
 *     reason. A clean shutdown hands the running job straight back.
 *   - After a successful transcode the ORIGINAL upload is deleted; only the
 *     processed, metadata-free MP4 is kept, encrypted in segments.
 *
 * Work files live in config.video.workDir (jobs/<jobId>.src and .mp4); the
 * job id is a server-made UUID, never a request value.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RETRY_DELAY_MS = 60 * 1000;
const FINISHED_KEEP_MS = 7 * 24 * 60 * 60 * 1000;
// Leftover work files older than this with no open job are removed.
const ORPHAN_AGE_MS = 10 * 60 * 1000;

function workPaths(workDir) {
  const root = path.resolve(workDir);
  return { root, uploads: path.join(root, 'uploads'), jobs: path.join(root, 'jobs') };
}

function jobFile(dirs, jobId, ext) {
  if (!UUID_RE.test(String(jobId))) {
    throw new Error('invalid video job id');
  }
  return path.join(dirs.jobs, `${jobId}.${ext}`);
}

async function removeQuietly(file) {
  await fs.rm(file, { force: true }).catch(() => {});
}

function createVideoQueue({ store, config, media, ffmpeg, notifier, now = () => Date.now() }) {
  const vc = config.video;
  const dirs = workPaths(vc.workDir);
  let timer = null;
  let current = null;
  let currentId = null;
  let stopped = false;
  let lastSweep = 0;

  async function ensureDirs() {
    // Fixed paths built from configuration, not from requests.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.mkdir(dirs.uploads, { recursive: true, mode: 0o700 });
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await fs.mkdir(dirs.jobs, { recursive: true, mode: 0o700 });
  }

  async function systemAudit(type, job, details) {
    try {
      await audit(store, null, type, { targetType: 'video_job', targetId: job.id, details });
    } catch (err) {
      logger.warn(errorFields(err), 'video audit failed');
    }
  }

  /** The photo already made from this job's media (a crash after createPhoto). */
  async function photoForMedia(mediaId) {
    if (!mediaId) {
      return null;
    }
    return (await store.listPhotos()).find((p) => p.mediaId === mediaId) || null;
  }

  async function fail(job, code) {
    await removeQuietly(jobFile(dirs, job.id, 'src'));
    await removeQuietly(jobFile(dirs, job.id, 'mp4'));
    if (job.mediaId && !(await photoForMedia(job.mediaId))) {
      await media.purgeMedia(job.mediaId, job.plannedSegments).catch((err) => {
        logger.warn(errorFields(err), 'could not remove a failed video\'s partial media');
      });
    }
    const updated = await store.updateVideoJob(job.id, {
      status: 'failed',
      reason: code,
      leaseUntil: null,
      finishedAt: new Date(now()).toISOString(),
    });
    await systemAudit('video.processing_failed', job, { reason: code, attempts: job.attempts });
    return updated;
  }

  async function finish(job, photo) {
    await removeQuietly(jobFile(dirs, job.id, 'src'));
    await removeQuietly(jobFile(dirs, job.id, 'mp4'));
    await store.updateVideoJob(job.id, {
      status: 'done',
      photoId: photo.id,
      leaseUntil: null,
      finishedAt: new Date(now()).toISOString(),
    });
  }

  async function processJob(job) {
    const src = jobFile(dirs, job.id, 'src');
    const out = jobFile(dirs, job.id, 'mp4');

    // A crash after the photo was created but before the job was marked done.
    const existing = await photoForMedia(job.mediaId);
    if (existing) {
      await finish(job, existing);
      return { id: job.id, status: 'done', photoId: existing.id };
    }
    // A crash part way through storing segments: start that part clean.
    if (job.mediaId) {
      await media.purgeMedia(job.mediaId, job.plannedSegments);
    }

    try {
      await fs.access(src);
    } catch {
      await fail(job, 'processing_failed');
      return { id: job.id, status: 'failed', reason: 'processing_failed' };
    }

    try {
      assertAcceptableProbe(await ffmpeg.probe(src), vc);
      await ffmpeg.transcode(src, out);
      const processed = await ffmpeg.probe(out);
      if (!processed.video || !(processed.durationSec > 0)) {
        throw new Error('transcode produced no playable video');
      }
      const poster = await ffmpeg.extractFrame(out, Math.min(1, processed.durationSec / 2));
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const size = (await fs.stat(out)).size;
      const mediaId = crypto.randomUUID();
      // Recorded BEFORE any segment is written, so a crash can be cleaned up.
      await store.updateVideoJob(job.id, { mediaId, plannedSegments: media.plannedSegments(size) });
      const ingested = await media.ingestVideo({ mediaId, file: out, poster });
      const photo = await store.createPhoto({
        kind: 'video',
        video: { ...ingested.video, durationMs: Math.round(processed.durationSec * 1000) },
        caption: job.caption,
        mediaId: ingested.mediaId,
        variants: ingested.variants,
        width: ingested.width,
        height: ingested.height,
        uploadedBy: job.ownerId,
        uploadedByName: job.ownerName,
        // Every video starts PRIVATE (parents only), like a photo, and a
        // member's contribution waits for a guardian's approval.
        pendingApproval: job.pendingApproval,
        hidden: false,
        downloadable: false,
        watermark: true,
        audienceType: PHOTO_AUDIENCE.PARENTS,
      });
      await finish(job, photo);
      await systemAudit('video.processed', job, { photoId: photo.id, pending: job.pendingApproval });
      if (job.pendingApproval && notifier) {
        await notifier.notifyGuardians(store, {
          subject: 'A video is waiting for approval',
          text: `${job.ownerName || 'A family member'} sent in a video. It stays private until a guardian approves it.`,
        });
      }
      return { id: job.id, status: 'done', photoId: photo.id };
    } catch (err) {
      await removeQuietly(out);
      if (err instanceof UploadRejected) {
        await fail(job, err.code);
        return { id: job.id, status: 'failed', reason: err.code };
      }
      logger.warn({ ...errorFields(err), jobId: job.id, attempt: job.attempts }, 'video processing attempt failed');
      if (job.attempts >= vc.maxAttempts) {
        await fail({ ...job, ...((await store.findVideoJob(job.id)) || {}) }, 'processing_failed');
        return { id: job.id, status: 'failed', reason: 'processing_failed' };
      }
      await store.updateVideoJob(job.id, {
        status: 'queued',
        leaseUntil: null,
        runAfter: new Date(now() + RETRY_DELAY_MS * job.attempts).toISOString(),
      });
      return { id: job.id, status: 'queued' };
    }
  }

  /** Claim and process at most one job. Returns its outcome, or null. */
  async function runOnce() {
    if (current) {
      return null;
    }
    const { job, exhausted } = await store.claimVideoJob({ now: now(), leaseMs: vc.leaseMs, maxAttempts: vc.maxAttempts });
    for (const dead of exhausted) {
      // Ran out of attempts while stuck (crashed every time): clean up.
      await fail(dead, 'processing_failed');
    }
    if (!job) {
      return null;
    }
    currentId = job.id;
    current = processJob(job);
    try {
      return await current;
    } finally {
      current = null;
      currentId = null;
    }
  }

  /**
   * Remove leftover work files: job files whose job is no longer open, and
   * anything else old. Upload sessions sweep their own files
   * (src/media/videoUploads.js); this catches what a crash left behind.
   */
  async function sweep() {
    const open = new Set(
      (await store.listVideoJobs()).filter((j) => j.status === 'queued' || j.status === 'running').map((j) => j.id)
    );
    let names;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      names = await fs.readdir(dirs.jobs);
    } catch {
      return 0;
    }
    let removed = 0;
    for (const name of names) {
      const id = name.replace(/\.(src|mp4)$/, '');
      if (open.has(id)) {
        continue;
      }
      const file = path.join(dirs.jobs, name);
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const st = await fs.stat(file).catch(() => null);
      if (st && now() - st.mtimeMs > ORPHAN_AGE_MS) {
        await removeQuietly(file);
        removed += 1;
      }
    }
    if (store.deleteVideoJobsFinishedBefore) {
      await store.deleteVideoJobsFinishedBefore(new Date(now() - FINISHED_KEEP_MS).toISOString());
    }
    return removed;
  }

  function tick() {
    if (stopped) {
      return;
    }
    const work = async () => {
      if (now() - lastSweep > ORPHAN_AGE_MS) {
        lastSweep = now();
        await sweep();
      }
      // Drain: keep going while there is work, one job at a time.
      while (!stopped && (await runOnce())) {
        // next job
      }
    };
    work()
      .catch((err) => logger.error(errorFields(err), 'video queue tick failed'))
      .finally(() => {
        if (!stopped) {
          timer = setTimeout(tick, vc.pollMs);
          timer.unref();
        }
      });
  }

  async function start() {
    await ensureDirs();
    stopped = false;
    timer = setTimeout(tick, Math.min(vc.pollMs, 2000));
    timer.unref();
  }

  /** Stop polling. A job still running is handed back so another instance can take it at once. */
  async function stop() {
    stopped = true;
    clearTimeout(timer);
    if (currentId) {
      // Only this instance's job; attempts are kept, so a clip that crashes
      // ffmpeg every time still runs out of attempts.
      await store.updateVideoJob(currentId, { status: 'queued', leaseUntil: null }).catch(() => {});
    }
  }

  return { start, stop, runOnce, sweep, ensureDirs, dirs, jobFile: (id, ext) => jobFile(dirs, id, ext) };
}

module.exports = { createVideoQueue, workPaths, jobFile };
