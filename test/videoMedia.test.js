'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const config = require('../src/config');
const { makeStore } = require('./storeFactory');
const { memoryMediaStorage } = require('./helpers');
const { createMediaService, segmentKey, SEGMENT_BYTES } = require('../src/media');
const { sniffVideo } = require('../src/media/sniff');
const { parseRange } = require('../src/media/range');
const { assertAcceptableProbe, formatDuration } = require('../src/media/video');
const { ftypHead } = require('./fixtures/makeVideos');
const { plainPng, plainJpeg } = require('./fixtures/makeImages');

// -- Magic bytes ------------------------------------------------------------

test('magic bytes: phone MP4 and MOV are recognized by their ftyp box, not their name', () => {
  assert.deepEqual(sniffVideo(ftypHead('isom', ['iso2', 'avc1', 'mp41'])), { container: 'mp4', brand: 'isom' });
  assert.deepEqual(sniffVideo(ftypHead('mp42', ['isom'])), { container: 'mp4', brand: 'mp42' });
  assert.deepEqual(sniffVideo(ftypHead('qt  ', ['qt  '])), { container: 'mov', brand: 'qt  ' });
  // Unknown major brand, but a known video brand among the compatible ones.
  assert.deepEqual(sniffVideo(ftypHead('abcd', ['isom'])), { container: 'mp4', brand: 'abcd' });
});

test('magic bytes: HEIC/AVIF stills, audio-only M4A, JPEG, HTML and junk are refused', async () => {
  assert.equal(sniffVideo(ftypHead('heic', ['mif1', 'heic'])), null);
  assert.equal(sniffVideo(ftypHead('mif1', ['heic'])), null);
  assert.equal(sniffVideo(ftypHead('avif', ['mif1'])), null);
  assert.equal(sniffVideo(ftypHead('M4A ', ['isom'])), null);
  assert.equal(sniffVideo(ftypHead('abcd', ['mif1', 'isom'])), null);
  assert.equal(sniffVideo((await plainJpeg()).subarray(0, 64)), null);
  assert.equal(sniffVideo(Buffer.from('<html><script>alert(1)</script></html>')), null);
  assert.equal(sniffVideo(crypto.randomBytes(64)), null);
  assert.equal(sniffVideo(Buffer.alloc(4)), null);
  // A box size that makes no sense.
  const bad = ftypHead('isom');
  bad.writeUInt32BE(1 << 30, 0);
  assert.equal(sniffVideo(bad), null);
});

// -- HTTP Range ---------------------------------------------------------------

test('range: first byte, middle, open-ended, suffix, and clamping past the end', () => {
  assert.deepEqual(parseRange('bytes=0-0', 1000), { start: 0, end: 0 });
  assert.deepEqual(parseRange('bytes=0-1', 1000), { start: 0, end: 1 });
  assert.deepEqual(parseRange('bytes=400-599', 1000), { start: 400, end: 599 });
  assert.deepEqual(parseRange('bytes=900-', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-100', 1000), { start: 900, end: 999 });
  assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=990-5000', 1000), { start: 990, end: 999 });
});

test('range: beyond the end is unsatisfiable; malformed or multi-range is ignored', () => {
  assert.equal(parseRange('bytes=1000-', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=5000-6000', 1000), 'unsatisfiable');
  assert.equal(parseRange('bytes=-0', 1000), 'unsatisfiable');
  assert.equal(parseRange(undefined, 1000), null);
  assert.equal(parseRange('bytes=5-1', 1000), null);
  assert.equal(parseRange('bytes=0-1,5-9', 1000), null);
  assert.equal(parseRange('items=0-1', 1000), null);
  assert.equal(parseRange('bytes=-', 1000), null);
});

// -- Probe rules --------------------------------------------------------------

const probe = (over = {}) => ({
  formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
  durationSec: 30,
  video: { codec: 'hevc', width: 1920, height: 1080, rotation: 90 },
  ...over,
});

test('duration limit: 3:00 plus a one-second rounding tolerance, measured by the server', () => {
  assert.equal(assertAcceptableProbe(probe({ durationSec: 180 }), config.video).durationMs, 180000);
  assert.equal(assertAcceptableProbe(probe({ durationSec: 180.9 }), config.video).durationMs, 180900);
  assert.throws(() => assertAcceptableProbe(probe({ durationSec: 181.2 }), config.video), { code: 'too_long' });
  assert.throws(() => assertAcceptableProbe(probe({ durationSec: 0 }), config.video), { code: 'unsupported_video' });
});

test('probe rules: only MP4/MOV with H.264 or HEVC, at most 4096 px a side', () => {
  assert.throws(() => assertAcceptableProbe(probe({ formatName: 'matroska,webm' }), config.video), { code: 'unsupported_video' });
  assert.throws(() => assertAcceptableProbe(probe({ video: { codec: 'vp9', width: 640, height: 480 } }), config.video), {
    code: 'unsupported_video',
  });
  assert.throws(() => assertAcceptableProbe(probe({ video: null }), config.video), { code: 'unsupported_video' });
  assert.throws(() => assertAcceptableProbe(probe({ video: { codec: 'h264', width: 7680, height: 4320 } }), config.video), {
    code: 'unsupported_video',
  });
  assert.equal(formatDuration(7400), '0:07');
  assert.equal(formatDuration(179600), '3:00');
});

// -- Segmented encryption -----------------------------------------------------

async function storedVideo(bytes) {
  const store = await makeStore();
  const storage = memoryMediaStorage();
  const media = createMediaService({
    store,
    storage,
    config: { ...config, encryptionKey: crypto.randomBytes(32).toString('base64') },
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cubhouse-vtest-'));
  const file = path.join(dir, 'out.mp4');
  fs.writeFileSync(file, bytes);
  const mediaId = crypto.randomUUID();
  const ingested = await media.ingestVideo({ mediaId, file, poster: await plainPng() });
  fs.rmSync(dir, { recursive: true, force: true });
  const photo = { kind: 'video', mediaId, video: ingested.video };
  const readAll = async (start, end) => {
    const parts = [];
    for await (const p of media.readVideoRange(photo, start, end)) {
      parts.push(p);
    }
    return Buffer.concat(parts);
  };
  return { media, storage, photo, ingested, readAll };
}

test('encryption: a video is stored as 1 MiB AES-GCM segments and reads back exactly, range by range', async () => {
  const bytes = crypto.randomBytes(SEGMENT_BYTES * 2 + 12345);
  const { storage, photo, ingested, readAll } = await storedVideo(bytes);
  assert.equal(ingested.video.segmentCount, 3);
  assert.equal(ingested.video.byteLength, bytes.length);
  // Ciphertext only: no stored segment contains a run of the plaintext.
  for (let i = 0; i < 3; i += 1) {
    const sealed = storage.objects.get(segmentKey(photo.mediaId, i));
    assert.ok(sealed, `segment ${i} stored`);
    assert.equal(sealed.indexOf(bytes.subarray(i * SEGMENT_BYTES + 100, i * SEGMENT_BYTES + 132)), -1);
  }
  assert.ok(storage.objects.has(`photos/${photo.mediaId}/thumb`), 'poster stored as photo variants');
  assert.deepEqual(await readAll(0, bytes.length - 1), bytes);
  assert.deepEqual(await readAll(0, 0), bytes.subarray(0, 1));
  // Across a segment boundary.
  const a = SEGMENT_BYTES - 10;
  assert.deepEqual(await readAll(a, a + 20), bytes.subarray(a, a + 21));
  assert.deepEqual(await readAll(bytes.length - 5, bytes.length - 1), bytes.subarray(bytes.length - 5));
  await assert.rejects(readAll(0, bytes.length), /invalid video range/);
});

test('encryption: an altered, swapped, missing or re-labelled segment is detected', async () => {
  const bytes = crypto.randomBytes(SEGMENT_BYTES * 2 + 100);
  const { storage, photo, readAll } = await storedVideo(bytes);
  const k0 = segmentKey(photo.mediaId, 0);
  const k1 = segmentKey(photo.mediaId, 1);
  const s0 = storage.objects.get(k0);
  const s1 = storage.objects.get(k1);

  // One flipped bit in the ciphertext.
  const flipped = Buffer.from(s0);
  flipped[flipped.length - 1] ^= 1;
  storage.objects.set(k0, flipped);
  await assert.rejects(readAll(0, 10));
  storage.objects.set(k0, s0);

  // Segments swapped between positions.
  storage.objects.set(k0, s1);
  storage.objects.set(k1, s0);
  await assert.rejects(readAll(0, 10));
  storage.objects.set(k0, s0);
  storage.objects.set(k1, s1);

  // Missing segment.
  storage.objects.delete(k1);
  await assert.rejects(readAll(SEGMENT_BYTES, SEGMENT_BYTES + 1), /segment missing/);
});

test('encryption: segments are bound to their video and count (moving one, or truncating, fails)', async () => {
  const store = await makeStore();
  const storage = memoryMediaStorage();
  const media = createMediaService({ store, storage, config: { ...config, encryptionKey: crypto.randomBytes(32).toString('base64') } });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cubhouse-vtest-'));
  const file = path.join(dir, 'out.mp4');
  fs.writeFileSync(file, crypto.randomBytes(5000));
  const a = await media.ingestVideo({ mediaId: crypto.randomUUID(), file, poster: await plainPng() });
  const b = await media.ingestVideo({ mediaId: crypto.randomUUID(), file, poster: await plainPng() });
  fs.rmSync(dir, { recursive: true, force: true });
  storage.objects.set(segmentKey(b.mediaId, 0), storage.objects.get(segmentKey(a.mediaId, 0)));
  const read = async (m) => {
    for await (const p of media.readVideoRange({ kind: 'video', mediaId: m.mediaId, video: m.video }, 0, 10)) {
      return p;
    }
    return null;
  };
  assert.equal((await read(a)).length, 11);
  await assert.rejects(read(b));
  // And a truncated record (fewer segments than were sealed) is refused too.
  const big = crypto.randomBytes(SEGMENT_BYTES + 10);
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cubhouse-vtest-'));
  fs.writeFileSync(path.join(d2, 'o.mp4'), big);
  const c = await media.ingestVideo({ mediaId: crypto.randomUUID(), file: path.join(d2, 'o.mp4'), poster: await plainPng() });
  fs.rmSync(d2, { recursive: true, force: true });
  assert.equal((await read(c)).length, 11);
  // Claim one segment instead of two: segment 0's AAD carries the real count.
  await assert.rejects(
    read({ mediaId: c.mediaId, video: { segmentBytes: SEGMENT_BYTES, segmentCount: 1, byteLength: SEGMENT_BYTES } })
  );
});

test('erasure: purge removes the poster and every segment of a video', async () => {
  const bytes = crypto.randomBytes(SEGMENT_BYTES * 3 + 1);
  const { media, storage, photo } = await storedVideo(bytes);
  const removed = await media.purge({ ...photo, kind: 'video' });
  assert.equal(removed.filter((k) => /\/v\d{6}$/.test(k)).length, 4);
  assert.equal([...storage.objects.keys()].filter((k) => k.includes(photo.mediaId)).length, 0);
});
