'use strict';

const crypto = require('crypto');
const { deriveKey, seal, open } = require('../security/secretBox');

/**
 * Envelope encryption for the family's media.
 *
 * One random 256-bit DATA key encrypts every media object. That data key is
 * stored only in WRAPPED form (sealed with the key-encryption key from
 * APP_ENCRYPTION_KEY), in the data store's settings. Consequences:
 *   - Someone holding only the bucket credentials sees ciphertext.
 *   - Someone holding only a database dump sees a wrapped key it cannot use.
 *   - Rotating APP_ENCRYPTION_KEY means re-wrapping one small value, not
 *     re-encrypting every photo.
 *
 * Each object is sealed with its object key as AAD, so ciphertext cannot be
 * swapped between photos or variants without detection.
 */

const SETTING_KEY = 'media.dataKey.v1';

/**
 * `mayCreateKey()` decides whether a MISSING wrapped key may be created. In
 * production it only may on an empty archive (a true first boot). If photos
 * exist but the key is gone, the database was restored without its settings
 * row, or pointed at the wrong database: creating a new key would silently
 * orphan every stored photo, so refuse and say why.
 */
function createKeyring({ store, encryptionKey, mayCreateKey = async () => true }) {
  const kek = deriveKey(encryptionKey);
  let dataKeyPromise = null;

  async function loadDataKey() {
    let wrapped = await store.getSetting(SETTING_KEY);
    if (!wrapped) {
      if (!(await mayCreateKey())) {
        throw new Error(
          `The wrapped media data key (${SETTING_KEY}) is missing but photos exist. ` +
            'Restore the app_settings table from backup (docs/RUNBOOK.md, Restore). Refusing to create a new key.'
        );
      }
      const fresh = seal(kek, crypto.randomBytes(32), SETTING_KEY).toString('base64');
      // setIfAbsent so two instances booting at once agree on one key.
      wrapped = await store.setSettingIfAbsent(SETTING_KEY, fresh);
    }
    return open(kek, Buffer.from(wrapped, 'base64'), SETTING_KEY);
  }

  function dataKey() {
    if (!dataKeyPromise) {
      dataKeyPromise = loadDataKey().catch((err) => {
        dataKeyPromise = null;
        throw err;
      });
    }
    return dataKeyPromise;
  }

  return {
    async encrypt(objectKey, bytes) {
      return seal(await dataKey(), bytes, objectKey);
    },
    async decrypt(objectKey, sealedBytes) {
      return open(await dataKey(), sealedBytes, objectKey);
    },
  };
}

module.exports = { createKeyring, SETTING_KEY };
