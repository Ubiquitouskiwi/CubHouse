'use strict';

/**
 * Restore-drill verifier: proves a backup is USABLE, not just present.
 *
 * Point it at a SCRATCH database restored from a backup dump and at a local
 * directory mirrored from the backup bucket, with the offline copy of
 * APP_ENCRYPTION_KEY in the environment. It checks the audit chain, then
 * decrypts a sample of photos end to end (wrapped data key from the DB,
 * ciphertext from the backup, KEK from escrow) and confirms each is a JPEG.
 *
 *   DATABASE_URL=postgres://...scratch... \
 *   APP_ENCRYPTION_KEY=<offline copy> \
 *   node scripts/verify-restore.js /path/to/media-mirror [sampleSize]
 *
 * Read-only: it never writes to the database or the media directory.
 * Never run it against the live database; deploy/restore-drill.sh creates
 * the scratch database for you.
 */

const path = require('path');
const { createKeyring } = require('../src/media/keyring');
const { objectKey } = require('../src/media');
const { createLocalStorage } = require('../src/media/storage');
const { verifyChain } = require('../src/audit');

async function verifyRestore({ store, storage, encryptionKey, sampleSize = 3 }) {
  const report = { photos: 0, checked: 0, decrypted: 0, failures: [], auditChainOk: false, auditEvents: 0 };
  const events = await store.listSecurityAuditEvents();
  const chain = verifyChain(events);
  report.auditChainOk = chain.ok;
  report.auditEvents = events.length;
  if (!chain.ok) {
    report.failures.push(`audit chain broken at seq ${chain.brokenAt}`);
  }
  const photos = await store.listPhotos();
  report.photos = photos.length;
  // Never create a key during a drill: a missing key IS the failure.
  const keyring = createKeyring({ store, encryptionKey, mayCreateKey: async () => false });
  // Spread the sample across the archive (oldest, middle, newest...).
  const step = Math.max(1, Math.floor(photos.length / Math.max(1, sampleSize)));
  const sample = photos.filter((_, i) => i % step === 0).slice(0, sampleSize);
  for (const photo of sample) {
    report.checked += 1;
    const key = objectKey(photo.mediaId, 'full');
    try {
      const sealed = await storage.get(key);
      if (!sealed) {
        report.failures.push(`${key}: missing from the backup`);
        continue;
      }
      const bytes = await keyring.decrypt(key, sealed);
      if (bytes.subarray(0, 3).toString('hex') !== 'ffd8ff') {
        report.failures.push(`${key}: decrypted but is not a JPEG`);
        continue;
      }
      report.decrypted += 1;
    } catch (err) {
      report.failures.push(`${key}: ${err.message}`);
    }
  }
  if (photos.length === 0) {
    report.failures.push('the restored database has no photos');
  }
  report.ok = report.failures.length === 0;
  return report;
}

async function main(argv) {
  const mirror = argv[2];
  if (!mirror || !process.env.DATABASE_URL || !process.env.APP_ENCRYPTION_KEY) {
    process.stderr.write('usage: DATABASE_URL=<scratch> APP_ENCRYPTION_KEY=<escrow> node scripts/verify-restore.js <media-mirror-dir> [n]\n');
    return 2;
  }
  const { PgStore } = require('../src/store/pgStore');
  const store = new PgStore(process.env.DATABASE_URL);
  const storage = createLocalStorage({ dir: path.resolve(mirror) });
  const report = await verifyRestore({
    store,
    storage,
    encryptionKey: process.env.APP_ENCRYPTION_KEY,
    sampleSize: Number(argv[3]) || 3,
  });
  // Counts and object keys only: no captions, names, or emails.
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.ok ? 0 : 1;
}

if (require.main === module) {
  main(process.argv).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`restore verification failed: ${err.message}\n`);
      process.exit(1);
    }
  );
}

module.exports = { verifyRestore };
