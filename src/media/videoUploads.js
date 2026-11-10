'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const fsSync = require('fs');
const path = require('path');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const { logger, errorFields } = require('../logger');
const { sniffVideo, SNIFF_BYTES } = require('./sniff');
const { maxDurationSec, VIDEO_MESSAGES } = require('./video');
const { workPaths } = require('../jobs/videoQueue');

/**
 * Chunked, resumable video upload sessions.
 *
 * The browser asks for a session (declaring the file size), then sends the
 * file as fixed-size chunks (PUT .../chunks/<n>, 8 MB by default), in any
 * order, each as its own authenticated, CSRF-checked request. A dropped
 * connection resumes from the chunks the server already has (GET the session
 * to see them). Bytes are streamed straight to a temp file at the chunk's
 * offset; a whole video is never held in memory.
 *
 *   - The declared size is capped (VIDEO_MAX_BYTES, 500 MB) and every chunk
 *     must be exactly its expected length, so the file can never grow past
 *     what was declared.
 *   - Chunk 0 is checked by magic bytes as soon as it lands; anything that is
 *     not an MP4/MOV ends the session and deletes the file.
 *   - A session with no chunk for VIDEO_SESSION_IDLE_MS (30 min) is dropped
 *     and its temp file deleted.
 *   - Per-person hourly limits on count AND bytes. Finished uploads are
 *     counted from the job table (shared by every instance, survives
 *     restarts); sessions still in progress are counted here.
 *
 * shortcut: sessions live in this process's memory, so a restart or release
 * swap ends uploads in progress (the browser then starts that video again).
 * Move session state to the database if uploads ever need to survive that.
 */

const HOUR = 60 * 60 * 1000;
const MAX_OPEN_SESSIONS = 3;
// Keep this much disk free beyond the upload itself (shared droplet).
const DISK_HEADROOM = 1024 * 1024 * 1024;

class VideoUploadError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = 'VideoUploadError';
    this.status = status;
    this.code = code;
    this.userMessage = message;
  }
}

/** Counts bytes through a chunk and stops it the moment it runs long. */
function byteCounter(limit) {
  let seen = 0;
  const t = new Transform({
    transform(chunk, _enc, cb) {
      seen += chunk.length;
      if (seen > limit) {
        cb(new VideoUploadError(413, 'bad_chunk', 'That piece of the video was larger than expected.'));
        return;
      }
      cb(null, chunk);
    },
  });
  t.bytes = () => seen;
  return t;
}

function createVideoUploads({ store, config, now = () => Date.now() }) {
  const vc = config.video;
  const dirs = workPaths(vc.workDir);
  const sessions = new Map();
  // Sessions opened in the last hour that have not become jobs yet.
  let recent = [];
  let timer = null;

  function view(s) {
    return {
      id: s.id,
      size: s.size,
      chunkBytes: s.chunkBytes,
      chunkCount: s.chunkCount,
      received: [...s.received].sort((a, b) => a - b),
    };
  }

  function expectedLength(s, index) {
    return Math.min(s.chunkBytes, s.size - index * s.chunkBytes);
  }

  async function quota(ownerId) {
    const since = now() - HOUR;
    recent = recent.filter((r) => r.at >= since);
    const jobs = await store.listVideoJobsByOwnerSince(ownerId, new Date(since).toISOString());
    const mine = recent.filter((r) => r.ownerId === ownerId);
    return {
      count: jobs.length + mine.length,
      bytes: jobs.reduce((n, j) => n + (Number(j.bytes) || 0), 0) + mine.reduce((n, r) => n + r.bytes, 0),
    };
  }

  async function freeBytes() {
    try {
      const st = await fs.statfs(dirs.uploads);
      return Number(st.bavail) * Number(st.bsize);
    } catch {
      return Infinity;
    }
  }

  async function create(user, { size, durationMs, caption }) {
    const bytes = Number(size);
    if (!Number.isSafeInteger(bytes) || bytes < 1) {
      throw new VideoUploadError(400, 'bad_request', 'That video could not be read. Try choosing it again.');
    }
    if (bytes > vc.maxBytes) {
      const mb = Math.round(vc.maxBytes / (1024 * 1024));
      throw new VideoUploadError(413, 'video_too_large', `This video is over ${mb} MB. Trim it on your phone, or share a smaller copy.`);
    }
    // The browser's own measurement, when it has one. ffprobe decides later.
    const hint = Number(durationMs);
    if (Number.isFinite(hint) && hint > maxDurationSec(vc) * 1000) {
      throw new VideoUploadError(422, 'too_long', VIDEO_MESSAGES.too_long);
    }
    const open = [...sessions.values()].filter((s) => s.ownerId === user.id).length;
    if (open >= MAX_OPEN_SESSIONS) {
      throw new VideoUploadError(429, 'video_rate_limited', 'A few videos are already uploading. Wait for one to finish.');
    }
    const used = await quota(user.id);
    if (used.count + 1 > vc.perHour || used.bytes + bytes > vc.bytesPerHour) {
      throw new VideoUploadError(
        429,
        'video_rate_limited',
        'Video upload limit reached for now. Please wait an hour, then select Retry.'
      );
    }
    if ((await freeBytes()) < bytes + DISK_HEADROOM) {
      logger.warn('video upload refused: video work directory is low on disk space');
      throw new VideoUploadError(503, 'video_busy', 'Cubhouse is short on room for videos right now. Please try later.');
    }
    const id = crypto.randomUUID();
    const file = path.join(dirs.uploads, `${id}.part`);
    // A new, empty, owner-only file; positional chunk writes fill it in.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const fh = await fs.open(file, 'wx', 0o600);
    await fh.close();
    const s = {
      id,
      ownerId: user.id,
      size: bytes,
      caption: caption || '',
      chunkBytes: vc.chunkBytes,
      chunkCount: Math.ceil(bytes / vc.chunkBytes),
      received: new Set(),
      inFlight: new Set(),
      file,
      createdAt: now(),
      lastActivity: now(),
    };
    sessions.set(id, s);
    recent.push({ sessionId: id, ownerId: user.id, at: s.createdAt, bytes });
    return s;
  }

  /** The session if it exists AND belongs to this person; otherwise null. */
  function get(id, ownerId) {
    const s = sessions.get(String(id));
    return s && s.ownerId === ownerId ? s : null;
  }

  async function drop(s, { refund = true } = {}) {
    sessions.delete(s.id);
    await fs.rm(s.file, { force: true }).catch(() => {});
    if (refund) {
      // Count only what was actually sent against the hourly byte limit.
      const r = recent.find((x) => x.sessionId === s.id);
      if (r) {
        r.bytes = Math.min(r.bytes, s.received.size * s.chunkBytes);
      }
    }
  }

  async function writeChunk(s, rawIndex, req) {
    const index = Number(rawIndex);
    if (!Number.isInteger(index) || index < 0 || index >= s.chunkCount) {
      throw new VideoUploadError(400, 'bad_chunk', 'That piece of the video is out of range.');
    }
    if (s.received.has(index)) {
      // A resend after a dropped answer: already stored, nothing to do.
      req.resume();
      return view(s);
    }
    if (s.inFlight.has(index)) {
      throw new VideoUploadError(409, 'chunk_busy', 'That piece of the video is already being sent.');
    }
    const expected = expectedLength(s, index);
    const declared = Number(req.get('content-length'));
    if (declared !== expected) {
      throw new VideoUploadError(declared > expected ? 413 : 400, 'bad_chunk', 'That piece of the video was the wrong size.');
    }
    s.inFlight.add(index);
    s.lastActivity = now();
    try {
      const counter = byteCounter(expected);
      // The path comes from the session (server-made UUID), never the request.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const out = fsSync.createWriteStream(s.file, { flags: 'r+', start: index * s.chunkBytes });
      try {
        await pipeline(req, counter, out);
      } catch (err) {
        if (err instanceof VideoUploadError) {
          throw err;
        }
        throw new VideoUploadError(400, 'incomplete', 'The connection dropped while sending the video.');
      }
      if (counter.bytes() !== expected) {
        throw new VideoUploadError(400, 'incomplete', 'The connection dropped while sending the video.');
      }
      if (index === 0) {
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        const fh = await fs.open(s.file, 'r');
        const head = Buffer.alloc(Math.min(SNIFF_BYTES, expected));
        try {
          await fh.read(head, 0, head.length, 0);
        } finally {
          await fh.close();
        }
        if (!sniffVideo(head)) {
          await drop(s);
          throw new VideoUploadError(415, 'unsupported_video', VIDEO_MESSAGES.unsupported_video);
        }
      }
      s.received.add(index);
      s.lastActivity = now();
      return view(s);
    } finally {
      s.inFlight.delete(index);
    }
  }

  /**
   * All chunks are in: hand the file to the caller and end the session. The
   * caller probes it, then either moves it into the job queue (settle) or
   * deletes it.
   */
  function complete(s) {
    if (s.inFlight.size > 0 || s.received.size !== s.chunkCount) {
      throw new VideoUploadError(409, 'incomplete', 'Some of the video has not arrived yet.');
    }
    sessions.delete(s.id);
    return { file: s.file, size: s.size, caption: s.caption };
  }

  /** The upload became a job: the job table counts it from now on. */
  function settle(sessionId) {
    recent = recent.filter((r) => r.sessionId !== sessionId);
  }

  async function cancel(s) {
    await drop(s);
  }

  /** Drop idle sessions and any stray temp file nobody owns. */
  async function sweep() {
    const cutoff = now() - vc.sessionIdleMs;
    let expired = 0;
    for (const s of [...sessions.values()]) {
      if (s.lastActivity < cutoff && s.inFlight.size === 0) {
        await drop(s);
        expired += 1;
      }
    }
    let names;
    try {
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      names = await fs.readdir(dirs.uploads);
    } catch {
      return expired;
    }
    const live = new Set([...sessions.values()].map((s) => path.basename(s.file)));
    for (const name of names) {
      if (live.has(name)) {
        continue;
      }
      const file = path.join(dirs.uploads, name);
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      const st = await fs.stat(file).catch(() => null);
      if (st && st.mtimeMs < cutoff) {
        await fs.rm(file, { force: true }).catch(() => {});
      }
    }
    return expired;
  }

  function start() {
    timer = setInterval(() => {
      sweep().catch((err) => logger.warn(errorFields(err), 'video upload sweep failed'));
    }, 60 * 1000);
    timer.unref();
  }

  function stop() {
    clearInterval(timer);
  }

  return { create, get, view, writeChunk, complete, settle, cancel, sweep, start, stop, sessions, dirs };
}

module.exports = { createVideoUploads, VideoUploadError };
