'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const { createMediaStorage, createMemoryStorage } = require('./storage');
const { createKeyring } = require('./keyring');
const { sanitizeImage } = require('./pipeline');

/**
 * Media service: the only code that touches media bytes.
 *
 *   ingest(buffer)        -> sanitize, derive, encrypt, store; returns ids
 *   read(photo, variant)  -> decrypted bytes for an AUTHORIZED caller
 *   ingestVideo(...)      -> encrypt a processed MP4 as numbered segments,
 *                            plus a poster through the photo pipeline
 *   readVideoRange(...)   -> decrypt only the segments a byte range needs
 *   purge(photo)          -> hard delete every variant and every segment
 *
 * Callers must run the permission check BEFORE `read`/`readVideoRange`. The
 * media route, the video stream route and the download route are the only
 * callers.
 *
 * Video format (v1). A processed MP4 is split into fixed 1 MiB plaintext
 * segments. Segment i is sealed on its own with AES-256-GCM under the same
 * data key as photos (fresh random 96-bit nonce per segment, see
 * security/secretBox.js), with additional authenticated data
 * "video.v1|<mediaId>|<i>|<count>". So a segment cannot be moved to another
 * video or another position, and dropping trailing segments is detected
 * (the count is in every segment's AAD and in the database record). Each
 * segment is its own object, photos/<mediaId>/v000000..., so a Range request
 * fetches and decrypts only what it needs.
 */

const VARIANT_NAMES = ['thumb', 'display', 'full'];
const SEGMENT_BYTES = 1024 * 1024;
const MAX_SEGMENT_INDEX = 999999;

function objectKey(mediaId, variant) {
  return `photos/${mediaId}/${variant}`;
}

function segmentKey(mediaId, index) {
  return `photos/${mediaId}/v${String(index).padStart(6, '0')}`;
}

function segmentAad(mediaId, index, count) {
  return `video.v1|${mediaId}|${index}|${count}`;
}

/** The stored manifest, or null if the record does not describe a usable video. */
function videoManifest(photo) {
  const v = photo && photo.kind === 'video' ? photo.video : null;
  if (
    !v ||
    !photo.mediaId ||
    !Number.isInteger(v.segmentBytes) ||
    v.segmentBytes < 64 * 1024 ||
    v.segmentBytes > 16 * 1024 * 1024 ||
    !Number.isInteger(v.byteLength) ||
    v.byteLength < 1 ||
    !Number.isInteger(v.segmentCount) ||
    v.segmentCount !== Math.ceil(v.byteLength / v.segmentBytes) ||
    v.segmentCount - 1 > MAX_SEGMENT_INDEX
  ) {
    return null;
  }
  return { mediaId: photo.mediaId, segmentBytes: v.segmentBytes, segmentCount: v.segmentCount, byteLength: v.byteLength };
}

function createMediaService({ store, config, storage }) {
  // The memory data store keeps the media data key in memory only, so pair
  // it with memory media: nothing is written to disk that a restart would
  // make undecryptable.
  const backend =
    storage ||
    (store.kind === 'memory' && config.media.backend === 'local'
      ? createMemoryStorage()
      : createMediaStorage(config.media));
  const keyring = createKeyring({
    store,
    encryptionKey: config.encryptionKey,
    // Production creates a data key only for an empty archive (first boot).
    mayCreateKey: async () => !config.isProduction || (await store.listPhotos()).length === 0,
  });

  async function putImageVariants(mediaId, variants) {
    const stored = {};
    for (const name of VARIANT_NAMES) {
      const key = objectKey(mediaId, name);
      await backend.put(key, await keyring.encrypt(key, variants[name]));
      stored[name] = key;
    }
    return stored;
  }

  async function ingest(buffer) {
    const { variants, width, height } = await sanitizeImage(buffer, {
      maxPixels: config.uploads.maxPixels,
      allowedFormats: config.uploads.allowedFormats,
    });
    const mediaId = crypto.randomUUID();
    const stored = await putImageVariants(mediaId, variants);
    return { mediaId, variants: stored, width, height };
  }

  /** How many segments a processed file of `byteLength` bytes becomes. */
  function plannedSegments(byteLength) {
    return Math.ceil(byteLength / SEGMENT_BYTES);
  }

  /**
   * Encrypt and store a PROCESSED (already stripped) MP4 from disk, reading
   * one segment at a time, plus its poster (a PNG frame, re-encoded by the
   * photo pipeline so it carries no metadata either). `mediaId` is chosen by
   * the caller and recorded first, so a crash half way can be cleaned up.
   */
  async function ingestVideo({ mediaId, file, poster }) {
    const { variants, width, height } = await sanitizeImage(poster, {
      maxPixels: config.uploads.maxPixels,
      allowedFormats: ['png', 'jpeg'],
    });
    // The path is the worker's own scratch file, never a request value.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const handle = await fs.open(file, 'r');
    let byteLength;
    let segmentCount;
    try {
      byteLength = (await handle.stat()).size;
      if (byteLength < 1) {
        throw new Error('processed video is empty');
      }
      segmentCount = plannedSegments(byteLength);
      if (segmentCount - 1 > MAX_SEGMENT_INDEX) {
        throw new Error('processed video is too large');
      }
      const buf = Buffer.alloc(SEGMENT_BYTES);
      for (let i = 0; i < segmentCount; i += 1) {
        const want = Math.min(SEGMENT_BYTES, byteLength - i * SEGMENT_BYTES);
        const { bytesRead } = await handle.read(buf, 0, want, i * SEGMENT_BYTES);
        if (bytesRead !== want) {
          throw new Error('processed video changed while it was stored');
        }
        const sealed = await keyring.encrypt(segmentAad(mediaId, i, segmentCount), buf.subarray(0, want));
        await backend.put(segmentKey(mediaId, i), sealed);
      }
    } finally {
      await handle.close();
    }
    const stored = await putImageVariants(mediaId, variants);
    return {
      mediaId,
      variants: stored,
      width,
      height,
      video: { segmentBytes: SEGMENT_BYTES, segmentCount, byteLength },
    };
  }

  async function read(photo, variant) {
    if (!photo || !photo.mediaId || !VARIANT_NAMES.includes(variant)) {
      return null;
    }
    const key = objectKey(photo.mediaId, variant);
    const sealed = await backend.get(key);
    return sealed ? keyring.decrypt(key, sealed) : null;
  }

  /**
   * Yield the plaintext bytes start..end (inclusive) of a stored video,
   * decrypting only the segments that overlap the range. Any missing,
   * swapped, truncated or altered segment throws (GCM authentication).
   */
  async function* readVideoRange(photo, start, end) {
    const m = videoManifest(photo);
    if (!m || !Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end >= m.byteLength) {
      throw new Error('invalid video range');
    }
    const first = Math.floor(start / m.segmentBytes);
    const last = Math.floor(end / m.segmentBytes);
    for (let i = first; i <= last; i += 1) {
      const sealed = await backend.get(segmentKey(m.mediaId, i));
      if (!sealed) {
        throw new Error('video segment missing');
      }
      const plain = await keyring.decrypt(segmentAad(m.mediaId, i, m.segmentCount), sealed);
      const expected = Math.min(m.segmentBytes, m.byteLength - i * m.segmentBytes);
      if (plain.length !== expected) {
        throw new Error('video segment has the wrong length');
      }
      const segStart = i * m.segmentBytes;
      const from = Math.max(start, segStart) - segStart;
      const to = Math.min(end, segStart + expected - 1) - segStart + 1;
      yield plain.subarray(from, to);
    }
  }

  /** Remove the segments 0..count-1 of a video (also used for partial writes). */
  async function purgeSegments(mediaId, count) {
    const removed = [];
    const n = Math.min(Number(count) || 0, MAX_SEGMENT_INDEX + 1);
    for (let i = 0; i < n; i += 1) {
      const key = segmentKey(mediaId, i);
      await backend.remove(key);
      removed.push(key);
    }
    return removed;
  }

  async function purgeMedia(mediaId, segmentCount) {
    const removed = [];
    for (const name of VARIANT_NAMES) {
      const key = objectKey(mediaId, name);
      await backend.remove(key);
      removed.push(key);
    }
    return removed.concat(await purgeSegments(mediaId, segmentCount));
  }

  async function purge(photo) {
    if (!photo || !photo.mediaId) {
      return [];
    }
    const segments = photo.kind === 'video' && photo.video ? photo.video.segmentCount : 0;
    return purgeMedia(photo.mediaId, segments);
  }

  return {
    ingest,
    ingestVideo,
    plannedSegments,
    read,
    readVideoRange,
    purge,
    purgeMedia,
    backendKind: backend.kind,
  };
}

module.exports = {
  createMediaService,
  objectKey,
  segmentKey,
  segmentAad,
  videoManifest,
  VARIANT_NAMES,
  SEGMENT_BYTES,
};
