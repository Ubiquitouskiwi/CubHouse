'use strict';

const fs = require('fs/promises');
const path = require('path');

/**
 * Media object storage backends. Both store opaque, already-encrypted bytes
 * under random keys like `photos/<uuid>/<variant>`. Keys never contain a
 * caption, a name, or anything else about the child.
 *
 *   local  - a directory OUTSIDE public/ (default data/media). Zero cost,
 *            development only; safe boot refuses it in production.
 *   spaces - a PRIVATE DigitalOcean Spaces bucket (S3 API). Configure the
 *            bucket per deploy/SPACES.md: no public ACL, anonymous access
 *            denied by policy, versioning on, noncurrent versions expiring.
 *
 * Bytes are always served through the app (/media/...), after an
 * authorization check, never by handing a browser a bucket URL.
 */

// Photo variants, plus numbered encrypted segments of a video (v000000...).
// Videos keep the photos/ prefix so backups and the bucket's version-expiry
// rule (deploy/SPACES.md) cover them with no change.
const KEY_RE = /^photos\/[0-9a-f-]{36}\/(thumb|display|full|v\d{6})$/;

function assertKey(key) {
  if (!KEY_RE.test(key)) {
    throw new Error('invalid media object key');
  }
}

function createLocalStorage({ dir }) {
  const root = path.resolve(dir);
  const fileFor = (key) => {
    assertKey(key);
    const full = path.resolve(root, key);
    if (!full.startsWith(root + path.sep)) {
      throw new Error('media key escapes storage root');
    }
    return full;
  };
  return {
    kind: 'local',
    // fileFor() only returns paths built from a validated key (KEY_RE: a UUID
    // and a fixed variant name) that resolve inside the storage root, so the
    // non-literal fs paths below cannot be steered by a caller.
    async put(key, bytes) {
      const file = fileFor(key);
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await fs.writeFile(file, bytes, { mode: 0o600 });
    },
    async get(key) {
      try {
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        return await fs.readFile(fileFor(key));
      } catch (err) {
        if (err.code === 'ENOENT') {
          return null;
        }
        throw err;
      }
    },
    async remove(key) {
      await fs.rm(fileFor(key), { force: true });
      // Remove the now-empty photo directory, if any.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      await fs.rmdir(path.dirname(fileFor(key))).catch(() => {});
    },
  };
}

function createSpacesStorage({ endpoint, region, bucket, key, secret }) {
  // Lazy: development never loads the AWS SDK.
  const {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
    ListObjectVersionsCommand,
    DeleteObjectsCommand,
  } = require('@aws-sdk/client-s3');
  const client = new S3Client({
    endpoint: endpoint.startsWith('http') ? endpoint : `https://${endpoint}`,
    region,
    forcePathStyle: false,
    credentials: { accessKeyId: key, secretAccessKey: secret },
  });

  return {
    kind: 'spaces',
    async put(objectKey, bytes) {
      assertKey(objectKey);
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          Body: bytes,
          ACL: 'private',
          ContentType: 'application/octet-stream',
          CacheControl: 'private, no-store',
        })
      );
    },
    async get(objectKey) {
      assertKey(objectKey);
      try {
        const res = await client.send(new GetObjectCommand({ Bucket: bucket, Key: objectKey }));
        return Buffer.from(await res.Body.transformToByteArray());
      } catch (err) {
        if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
          return null;
        }
        throw err;
      }
    },
    // Hard delete: remove the current object AND every noncurrent version,
    // so versioning cannot quietly keep a deleted photo of the child.
    async remove(objectKey) {
      assertKey(objectKey);
      const listed = await client.send(
        new ListObjectVersionsCommand({ Bucket: bucket, Prefix: objectKey })
      );
      const targets = [...(listed.Versions || []), ...(listed.DeleteMarkers || [])]
        .filter((v) => v.Key === objectKey)
        .map((v) => ({ Key: v.Key, VersionId: v.VersionId }));
      if (targets.length > 0) {
        await client.send(
          new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: targets, Quiet: true } })
        );
      } else {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: objectKey }));
      }
    },
  };
}

/**
 * Process memory. Used with the in-memory data store in development: both
 * vanish together on restart, so local disk never holds ciphertext whose
 * (memory-only) data key is gone.
 */
function createMemoryStorage() {
  const objects = new Map();
  return {
    kind: 'memory',
    objects,
    async put(key, bytes) {
      assertKey(key);
      objects.set(key, Buffer.from(bytes));
    },
    async get(key) {
      return objects.has(key) ? Buffer.from(objects.get(key)) : null;
    },
    async remove(key) {
      objects.delete(key);
    },
  };
}

function createMediaStorage(mediaConfig) {
  if (mediaConfig.backend === 'spaces') {
    return createSpacesStorage(mediaConfig.spaces);
  }
  if (mediaConfig.backend === 'local') {
    return createLocalStorage({ dir: mediaConfig.localDir });
  }
  throw new Error(`unknown MEDIA_BACKEND "${mediaConfig.backend}"`);
}

module.exports = { createMediaStorage, createLocalStorage, createMemoryStorage, assertKey };
