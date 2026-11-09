'use strict';

const crypto = require('crypto');
const { createMediaStorage, createMemoryStorage } = require('./storage');
const { createKeyring } = require('./keyring');
const { sanitizeImage } = require('./pipeline');

/**
 * Media service: the only code that touches image bytes.
 *
 *   ingest(buffer)        -> sanitize, derive, encrypt, store; returns ids
 *   read(photo, variant)  -> decrypted bytes for an AUTHORIZED caller
 *   purge(photo)          -> hard delete every variant (and every version)
 *
 * Callers must run the permission check BEFORE `read`. The media route and
 * the download route are the only two callers.
 */

const VARIANT_NAMES = ['thumb', 'display', 'full'];

function objectKey(mediaId, variant) {
  return `photos/${mediaId}/${variant}`;
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

  async function ingest(buffer) {
    const { variants, width, height } = await sanitizeImage(buffer, {
      maxPixels: config.uploads.maxPixels,
      allowedFormats: config.uploads.allowedFormats,
    });
    const mediaId = crypto.randomUUID();
    const stored = {};
    for (const name of VARIANT_NAMES) {
      const key = objectKey(mediaId, name);
      await backend.put(key, await keyring.encrypt(key, variants[name]));
      stored[name] = key;
    }
    return { mediaId, variants: stored, width, height };
  }

  async function read(photo, variant) {
    if (!photo || !photo.mediaId || !VARIANT_NAMES.includes(variant)) {
      return null;
    }
    const key = objectKey(photo.mediaId, variant);
    const sealed = await backend.get(key);
    return sealed ? keyring.decrypt(key, sealed) : null;
  }

  async function purge(photo) {
    if (!photo || !photo.mediaId) {
      return [];
    }
    const removed = [];
    for (const name of VARIANT_NAMES) {
      const key = objectKey(photo.mediaId, name);
      await backend.remove(key);
      removed.push(key);
    }
    return removed;
  }

  return { ingest, read, purge, backendKind: backend.kind };
}

module.exports = { createMediaService, objectKey, VARIANT_NAMES };
