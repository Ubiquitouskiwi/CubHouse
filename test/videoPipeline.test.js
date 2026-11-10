'use strict';

/**
 * The real video pipeline, with real ffmpeg/ffprobe: a synthetic clip tagged
 * like a phone video (fake GPS, make, model, capture time, rotation) goes
 * through the upload routes and the worker, and the stored, decrypted output
 * is checked for every one of those tags.
 *
 * Skips with a clear message when ffmpeg is not installed. CI installs it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { startApp, seedFamily } = require('./helpers');
const { metadataReport } = require('../src/media/pipeline');
const {
  SKIP_FFMPEG,
  FFMPEG,
  FFPROBE,
  FAKE_GPS,
  FAKE_MAKE,
  FAKE_MODEL,
  makeClip,
  ffprobeJson,
  uploadVideo,
} = require('./fixtures/makeVideos');

if (SKIP_FFMPEG) {
  process.stdout.write(`${SKIP_FFMPEG}\n`);
}

const SENSITIVE_TAG = /location|iso6709|xyz|gps|make|model|creation_time|com\.apple|software|encoder_device/i;

async function setup(t) {
  const env = await startApp({ video: { ffmpegPath: FFMPEG, ffprobePath: FFPROBE, chunkBytes: 64 * 1024 } });
  t.after(env.close);
  await seedFamily(env);
  const parent = env.client();
  await parent.login('parent@test.com');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cubhouse-clip-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { env, parent, dir, queue: env.services.videoQueue };
}

/** Upload, process, then decrypt the stored video back to a file. */
async function processClip(ctx, clip) {
  const res = await uploadVideo(ctx.parent, fs.readFileSync(clip));
  assert.equal(res.status, 202, res.body);
  const outcome = await ctx.queue.runOnce();
  assert.equal(outcome.status, 'done', JSON.stringify(outcome));
  const video = await ctx.env.store.findPhotoById(outcome.photoId);
  const parts = [];
  for await (const p of ctx.env.services.media.readVideoRange(video, 0, video.video.byteLength - 1)) {
    parts.push(p);
  }
  const bytes = Buffer.concat(parts);
  const out = path.join(ctx.dir, `stored-${outcome.photoId}.mp4`);
  fs.writeFileSync(out, bytes);
  return { video, bytes, out, jobId: res.json.job.id };
}

test('metadata strip: GPS, device and capture time are gone from the processed video', { skip: SKIP_FFMPEG }, async (t) => {
  const ctx = await setup(t);
  const clip = makeClip(ctx.dir, { name: 'phone.mov', seconds: 1, width: 320, height: 240, rotate: 90 });

  // Sanity: the test clip really carries the fake location and device.
  const before = fs.readFileSync(clip).toString('latin1');
  assert.ok(before.includes(FAKE_GPS) || before.includes('40.6892'), 'clip carries GPS');
  assert.ok(before.includes(FAKE_MAKE), 'clip carries the device make');

  const { video, bytes, out, jobId } = await processClip(ctx, clip);
  const text = bytes.toString('latin1');
  for (const needle of [FAKE_GPS, '40.6892', '074.0445', FAKE_MAKE, FAKE_MODEL, '2024-05-01']) {
    assert.ok(!text.includes(needle), `processed video still contains ${needle}`);
  }
  const info = ffprobeJson(out);
  const tagKeys = [
    ...Object.keys((info.format && info.format.tags) || {}),
    ...info.streams.flatMap((s) => Object.keys(s.tags || {})),
  ];
  assert.deepEqual(tagKeys.filter((k) => SENSITIVE_TAG.test(k)), [], `sensitive tags left: ${tagKeys.join(', ')}`);
  // Only one video and one audio stream: no data/timed-metadata or subtitle tracks.
  assert.deepEqual(info.streams.map((s) => s.codec_type).sort(), ['audio', 'video']);

  // H.264 High + AAC, rotation baked into the pixels (320x240 turned 90 = 240x320).
  const v = info.streams.find((s) => s.codec_type === 'video');
  const a = info.streams.find((s) => s.codec_type === 'audio');
  assert.equal(v.codec_name, 'h264');
  assert.equal(v.profile, 'High');
  assert.equal(a.codec_name, 'aac');
  assert.equal(v.width, 240);
  assert.equal(v.height, 320);
  const rotation = (v.side_data_list || []).find((d) => d.rotation !== undefined);
  assert.ok(!rotation || Number(rotation.rotation) === 0, 'no display rotation left to apply');
  assert.ok(!(v.tags && v.tags.rotate && v.tags.rotate !== '0'), 'no rotate tag left');

  // +faststart: the index (moov) comes before the media data (mdat).
  assert.ok(bytes.indexOf('moov') < bytes.indexOf('mdat'), 'moov first, so playback starts at once');

  // The original upload is gone; only the processed, encrypted copy is kept.
  assert.equal(fs.existsSync(ctx.queue.jobFile(jobId, 'src')), false);
  assert.equal(fs.readdirSync(path.join(ctx.env.videoWorkDir, 'jobs')).length, 0);
  for (const [key, sealed] of ctx.env.mediaStorage.objects) {
    if (key.includes(video.mediaId)) {
      assert.equal(sealed.indexOf('ftyp'), -1, `${key} is ciphertext`);
    }
  }

  // The poster went through the photo pipeline: a JPEG with no metadata.
  const poster = await ctx.env.services.media.read(video, 'display');
  const report = await metadataReport(poster);
  assert.equal(report.format, 'jpeg');
  assert.equal(report.hasExif, false);
  assert.equal(report.hasXmp, false);
  assert.ok(video.video.durationMs >= 900 && video.video.durationMs <= 1300, `duration ${video.video.durationMs}`);
});

test('720p at most, aspect kept, never upscaled', { skip: SKIP_FFMPEG }, async (t) => {
  const ctx = await setup(t);
  const cases = [
    { width: 1920, height: 1080, expect: [1280, 720] },
    { width: 1080, height: 1920, expect: [720, 1280] },
    { width: 1440, height: 1080, expect: [960, 720] },
    { width: 320, height: 240, expect: [320, 240] },
  ];
  for (const c of cases) {
    const clip = makeClip(ctx.dir, { name: `s${c.width}x${c.height}.mp4`, seconds: 0.5, width: c.width, height: c.height, tagged: false });
    const { out } = await processClip(ctx, clip);
    const v = ffprobeJson(out).streams.find((s) => s.codec_type === 'video');
    assert.deepEqual([v.width, v.height], c.expect, `${c.width}x${c.height}`);
  }
});

test('duration limit with real ffprobe: a 3:02 clip is refused, nothing is queued', { skip: SKIP_FFMPEG }, async (t) => {
  const ctx = await setup(t);
  const clip = makeClip(ctx.dir, { name: 'long.mp4', seconds: 182, width: 64, height: 48, tagged: false });
  const res = await uploadVideo(ctx.parent, fs.readFileSync(clip));
  assert.equal(res.status, 422);
  assert.equal(res.json.error.code, 'too_long');
  assert.equal((await ctx.env.store.listVideoJobs()).length, 0);
  assert.deepEqual(fs.readdirSync(path.join(ctx.env.videoWorkDir, 'uploads')), []);
});
