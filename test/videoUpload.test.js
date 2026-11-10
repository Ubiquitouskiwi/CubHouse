'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { startApp, seedFamily } = require('./helpers');
const { fakeMp4, fakeFfmpeg, api, startUpload, putChunk, uploadVideo } = require('./fixtures/makeVideos');

const CHUNK = 1024;

async function setup(t, video = {}, ffmpegOverrides = {}) {
  const ffmpeg = await fakeFfmpeg(ffmpegOverrides);
  const env = await startApp({ ffmpeg, video: { chunkBytes: CHUNK, maxBytes: 64 * 1024, ...video } });
  t.after(env.close);
  const people = await seedFamily(env);
  const parent = env.client();
  const member = env.client();
  await parent.login('parent@test.com');
  await member.login('member@test.com');
  return { ...people, env, ffmpeg, parent, member };
}

const uploadsDir = (env) => path.join(env.videoWorkDir, 'uploads');
const jobsDir = (env) => path.join(env.videoWorkDir, 'jobs');

test('upload session: chunks may arrive out of order and twice; the file is exactly what was sent', async (t) => {
  const { env, member } = await setup(t);
  const bytes = fakeMp4(CHUNK * 3 + 100);
  const start = await startUpload(member, bytes.length, { caption: 'Splash time' });
  assert.equal(start.status, 201);
  const { id, chunkCount, chunkBytes } = start.json.upload;
  assert.equal(chunkCount, 4);
  assert.equal(chunkBytes, CHUNK);
  const piece = (i) => bytes.subarray(i * CHUNK, (i + 1) * CHUNK);

  for (const i of [2, 0, 3]) {
    const r = await putChunk(member, id, i, piece(i));
    assert.equal(r.status, 200, `chunk ${i}`);
  }
  // A resend after a lost answer is accepted and changes nothing.
  const dup = await putChunk(member, id, 2, piece(2));
  assert.equal(dup.status, 200);
  // Resume: the session says which pieces it has.
  const state = await api(member, 'GET', `/videos/uploads/${id}`);
  assert.deepEqual(state.json.upload.received, [0, 2, 3]);
  // Finishing early is refused.
  const early = await api(member, 'POST', `/videos/uploads/${id}/complete`, { fields: {} });
  assert.equal(early.status, 409);
  assert.equal((await putChunk(member, id, 1, piece(1))).status, 200);

  const done = await api(member, 'POST', `/videos/uploads/${id}/complete`, { fields: {} });
  assert.equal(done.status, 202, done.body);
  const jobId = done.json.job.id;
  const job = await env.store.findVideoJob(jobId);
  assert.equal(job.status, 'queued');
  assert.equal(job.pendingApproval, true, 'a member upload waits for approval');
  assert.equal(job.caption, 'Splash time');
  // The temp file moved into the queue, byte for byte.
  assert.deepEqual(fs.readFileSync(path.join(jobsDir(env), `${jobId}.src`)), bytes);
  assert.deepEqual(fs.readdirSync(uploadsDir(env)), []);
  const events = await env.store.listSecurityAuditEvents();
  assert.ok(events.some((e) => e.type === 'video.uploaded' && e.targetId === jobId));
});

test('upload session: wrong-size and out-of-range chunks are refused; nothing can grow past the declared size', async (t) => {
  const { member } = await setup(t);
  const bytes = fakeMp4(CHUNK * 2 + 10);
  const { id } = (await startUpload(member, bytes.length)).json.upload;
  const tooBig = await putChunk(member, id, 0, Buffer.concat([bytes.subarray(0, CHUNK), Buffer.alloc(50)]));
  assert.equal(tooBig.status, 413);
  const tooSmall = await putChunk(member, id, 0, bytes.subarray(0, 100));
  assert.equal(tooSmall.status, 400);
  // The last chunk is only the remainder.
  const lastWrong = await putChunk(member, id, 2, bytes.subarray(0, CHUNK));
  assert.equal(lastWrong.status, 413);
  const outOfRange = await putChunk(member, id, 3, bytes.subarray(0, 10));
  assert.equal(outOfRange.status, 400);
  assert.equal((await putChunk(member, id, 2, bytes.subarray(2 * CHUNK))).status, 200);
});

test('upload session: over the size cap is refused before any bytes are sent', async (t) => {
  const { member, env } = await setup(t);
  const r = await startUpload(member, 64 * 1024 + 1);
  assert.equal(r.status, 413);
  assert.equal(r.json.error.code, 'video_too_large');
  assert.equal(fs.readdirSync(uploadsDir(env)).length, 0);
  assert.equal((await startUpload(member, 0)).status, 400);
  assert.equal((await startUpload(member, 'lots')).status, 400);
});

test('upload session: the first chunk is checked by magic bytes; a renamed non-video ends the session', async (t) => {
  const { member, env } = await setup(t);
  const fake = Buffer.alloc(CHUNK * 2, 0x41); // "AAAA...", named clip.mp4 by the browser
  const { id } = (await startUpload(member, fake.length)).json.upload;
  // Chunk 1 first: not checked yet.
  assert.equal((await putChunk(member, id, 1, fake.subarray(CHUNK))).status, 200);
  const r = await putChunk(member, id, 0, fake.subarray(0, CHUNK));
  assert.equal(r.status, 415);
  assert.equal(r.json.error.code, 'unsupported_video');
  assert.equal(fs.readdirSync(uploadsDir(env)).length, 0, 'temp file deleted');
  assert.equal((await api(member, 'GET', `/videos/uploads/${id}`)).status, 404);
});

test('every chunk is checked: signed out, missing CSRF token, someone else\'s session, the support operator', async (t) => {
  const { env, member, parent } = await setup(t);
  const bytes = fakeMp4(CHUNK * 2);
  const { id } = (await startUpload(member, bytes.length)).json.upload;

  // No CSRF token.
  const noCsrf = await putChunk(member, id, 0, bytes.subarray(0, CHUNK), { 'x-csrf-token': '' });
  assert.equal(noCsrf.status, 403);
  // Another signed-in person cannot write to (or even see) this session.
  assert.equal((await putChunk(parent, id, 0, bytes.subarray(0, CHUNK))).status, 404);
  assert.equal((await api(parent, 'GET', `/videos/uploads/${id}`)).status, 404);
  assert.equal((await api(parent, 'POST', `/videos/uploads/${id}/complete`, { fields: {} })).status, 404);
  // Signed out: no cookie at all.
  const anon = env.client();
  const out = await putChunk(anon, id, 0, bytes.subarray(0, CHUNK));
  assert.notEqual(out.status, 200);
  assert.equal((await api(member, 'GET', `/videos/uploads/${id}`)).json.upload.received.length, 0);
  // Signed out mid-upload: the next chunk is refused.
  await member.post('/logout', {});
  const after = await putChunk(member, id, 0, bytes.subarray(0, CHUNK));
  assert.notEqual(after.status, 200);
});

test('duration limit: the browser hint over 3:00 is refused at once; the server probe has the final word', async (t) => {
  const { member, env, ffmpeg } = await setup(t);
  const hinted = await startUpload(member, 5000, { durationMs: String(200 * 1000) });
  assert.equal(hinted.status, 422);
  assert.equal(hinted.json.error.code, 'too_long');

  // The browser said nothing (or lied); ffprobe measures 3:05.
  ffmpeg.probeResult = { ...ffmpeg.probeResult, durationSec: 185 };
  const r = await uploadVideo(member, fakeMp4(CHUNK + 5), { durationMs: '1000' });
  assert.equal(r.status, 422);
  assert.equal(r.json.error.code, 'too_long');
  assert.match(r.json.error.message, /longer than 3 minutes/);
  assert.equal(fs.readdirSync(uploadsDir(env)).length, 0);
  assert.equal(fs.readdirSync(jobsDir(env)).length, 0);
  assert.equal((await env.store.listVideoJobs()).length, 0);

  // 3:00.4 (container rounding) is fine.
  ffmpeg.probeResult = { ...ffmpeg.probeResult, durationSec: 180.4 };
  assert.equal((await uploadVideo(member, fakeMp4(CHUNK + 5))).status, 202);
});

test('unsupported codec or container (by ffprobe) is refused with a plain reason', async (t) => {
  const { member, ffmpeg } = await setup(t);
  ffmpeg.probeResult = { ...ffmpeg.probeResult, video: { codec: 'vp9', width: 640, height: 480 } };
  const r = await uploadVideo(member, fakeMp4(CHUNK));
  assert.equal(r.status, 422);
  assert.equal(r.json.error.code, 'unsupported_video');
});

test('hourly limits: count and bytes per person, from finished jobs plus uploads in progress', async (t) => {
  const { member, parent } = await setup(t, { perHour: 2, bytesPerHour: CHUNK * 5 });
  assert.equal((await uploadVideo(member, fakeMp4(CHUNK))).status, 202);
  // Bytes: 1 KiB used, a 5 KiB video would go over 5 KiB.
  const big = await startUpload(member, CHUNK * 5);
  assert.equal(big.status, 429);
  assert.equal(big.json.error.code, 'video_rate_limited');
  // An unfinished upload counts too.
  assert.equal((await startUpload(member, CHUNK)).status, 201);
  const third = await startUpload(member, CHUNK);
  assert.equal(third.status, 429);
  // Limits are per person.
  assert.equal((await startUpload(parent, CHUNK)).status, 201);
});

test('idle sessions expire and their temp files are deleted', async (t) => {
  const { env, member } = await setup(t, { sessionIdleMs: 50 });
  const bytes = fakeMp4(CHUNK * 2);
  const { id } = (await startUpload(member, bytes.length)).json.upload;
  assert.equal((await putChunk(member, id, 0, bytes.subarray(0, CHUNK))).status, 200);
  assert.equal(fs.readdirSync(uploadsDir(env)).length, 1);
  // A stray temp file nobody owns (a crash), old enough to go.
  const stray = path.join(uploadsDir(env), 'stray.part');
  fs.writeFileSync(stray, 'x');
  const past = new Date(Date.now() - 60 * 1000);
  fs.utimesSync(stray, past, past);
  await new Promise((r) => setTimeout(r, 80));
  const expired = await env.services.videoUploads.sweep();
  assert.equal(expired, 1);
  assert.deepEqual(fs.readdirSync(uploadsDir(env)), []);
  const gone = await putChunk(member, id, 1, bytes.subarray(CHUNK));
  assert.equal(gone.status, 404);
  assert.equal(gone.json.error.code, 'upload_gone');
});

test('cancel deletes the temp file at once', async (t) => {
  const { env, member } = await setup(t);
  const bytes = fakeMp4(CHUNK * 2);
  const { id } = (await startUpload(member, bytes.length)).json.upload;
  await putChunk(member, id, 0, bytes.subarray(0, CHUNK));
  assert.equal((await api(member, 'DELETE', `/videos/uploads/${id}`)).status, 200);
  assert.deepEqual(fs.readdirSync(uploadsDir(env)), []);
});

test('processing status is for the uploader only', async (t) => {
  const { member, parent } = await setup(t);
  const done = await uploadVideo(member, fakeMp4(CHUNK));
  const jobId = done.json.job.id;
  const mine = await api(member, 'GET', `/videos/jobs/${jobId}`);
  assert.equal(mine.status, 200);
  assert.equal(mine.json.job.status, 'waiting');
  assert.equal((await api(parent, 'GET', `/videos/jobs/${jobId}`)).status, 404);
  assert.equal((await api(member, 'GET', '/videos/jobs/not-a-uuid')).status, 404);
});

test('a video posted to the photo route (no JavaScript) gets a plain pointer to the uploader', async (t) => {
  const { parent } = await setup(t);
  const res = await parent.postMultipart('/photos/upload', {}, { buffer: fakeMp4(2048), filename: 'clip.mp4', type: 'video/mp4' }, {
    headers: { accept: 'application/json' },
  });
  assert.equal(res.status, 415);
  assert.equal(JSON.parse(res.body).error.code, 'video');
});

test('no ffmpeg on the server: video uploads say so instead of failing later', async (t) => {
  const { member } = await setup(t, {}, { isAvailable: async () => false });
  const r = await startUpload(member, 1000);
  assert.equal(r.status, 503);
  assert.equal(r.json.error.code, 'video_unavailable');
});
