'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const crypto = require('node:crypto');

const { startApp, seedFamily, rawRequest } = require('./helpers');
const { makeStore } = require('./storeFactory');
const { planClaim, newVideoJob } = require('../src/store/videoJobs');
const { fakeMp4, fakeFfmpeg, api, uploadVideo } = require('./fixtures/makeVideos');

const CHUNK = 1024;
const LEASE = 60 * 1000;

async function setup(t, { video = {}, ffmpeg: over = {} } = {}) {
  const ffmpeg = await fakeFfmpeg(over);
  const env = await startApp({ ffmpeg, video: { chunkBytes: CHUNK, maxBytes: 1024 * 1024 * 8, maxAttempts: 3, ...video } });
  t.after(env.close);
  const people = await seedFamily(env);
  const parent = env.client();
  const member = env.client();
  await parent.login('parent@test.com');
  await member.login('member@test.com');
  return { ...people, env, ffmpeg, parent, member, queue: env.services.videoQueue };
}

// -- Claim rules (pure) --------------------------------------------------------

test('queue: one job at a time; a live lease blocks every other claim', () => {
  const now = Date.now();
  const a = newVideoJob({ ownerId: 'u1' }, now - 2000);
  const b = newVideoJob({ ownerId: 'u2' }, now - 1000);
  const first = planClaim([a, b], { now, leaseMs: LEASE, maxAttempts: 3 });
  assert.equal(first.claim.id, a.id, 'oldest first');
  assert.equal(a.status, 'running');
  assert.equal(a.attempts, 1);
  const second = planClaim([a, b], { now: now + 1000, leaseMs: LEASE, maxAttempts: 3 });
  assert.equal(second.claim, null, 'b waits while a holds its lease');
});

test('queue: restart recovery: a running job whose lease ran out is claimed again; after the limit it fails', () => {
  const now = Date.now();
  const job = newVideoJob({ ownerId: 'u1' }, now - 10000);
  planClaim([job], { now: now - 9000, leaseMs: 1000, maxAttempts: 2 });
  assert.equal(job.attempts, 1);
  // The process died: the lease expires and the job is taken again.
  const again = planClaim([job], { now, leaseMs: 1000, maxAttempts: 2 });
  assert.equal(again.claim.id, job.id);
  assert.equal(job.attempts, 2);
  // Died again: no attempts left, so it is failed with a reason, not retried.
  const last = planClaim([job], { now: now + 5000, leaseMs: 1000, maxAttempts: 2 });
  assert.equal(last.claim, null);
  assert.equal(last.exhausted.length, 1);
  assert.equal(job.status, 'failed');
  assert.equal(job.reason, 'processing_failed');
});

test('queue: the store persists claims (memory and Postgres share the rules)', async () => {
  const store = await makeStore();
  const job = await store.createVideoJob({ id: crypto.randomUUID(), ownerId: 'u1', bytes: 10 });
  const { job: claimed } = await store.claimVideoJob({ now: Date.now(), leaseMs: LEASE, maxAttempts: 3 });
  assert.equal(claimed.id, job.id);
  assert.equal((await store.findVideoJob(job.id)).status, 'running');
  const { job: none } = await store.claimVideoJob({ now: Date.now(), leaseMs: LEASE, maxAttempts: 3 });
  assert.equal(none, null);
});

// -- The worker ----------------------------------------------------------------

test('worker: processes a member\'s video into a pending, private, non-downloadable item; the original is deleted', async (t) => {
  const { env, member, ffmpeg, queue } = await setup(t);
  const done = await uploadVideo(member, fakeMp4(CHUNK * 3 + 7), { caption: 'First swim' });
  const jobId = done.json.job.id;
  const src = queue.jobFile(jobId, 'src');
  assert.ok(fs.existsSync(src));

  const outcome = await queue.runOnce();
  assert.equal(outcome.status, 'done');
  assert.deepEqual(ffmpeg.calls, ['transcode']);
  assert.equal(fs.existsSync(src), false, 'original upload deleted after a successful transcode');
  assert.equal(fs.existsSync(queue.jobFile(jobId, 'mp4')), false, 'scratch output deleted');

  const video = await env.store.findPhotoById(outcome.photoId);
  assert.equal(video.kind, 'video');
  assert.equal(video.pendingApproval, true);
  assert.equal(video.audienceType, 'parents');
  assert.equal(video.downloadable, false);
  assert.equal(video.caption, 'First swim');
  assert.equal(video.video.durationMs, 2000);
  assert.equal(video.video.byteLength, CHUNK * 3 + 7);

  const status = await api(member, 'GET', `/videos/jobs/${jobId}`);
  assert.equal(status.json.job.status, 'done');
  assert.equal(status.json.job.sharing, 'awaiting_approval');
  assert.equal(status.json.job.photo.url, null, 'a member cannot open it until approved');
  // Guardians were told, and the audit trail has it.
  assert.ok(env.notifier.sent.some((m) => /video is waiting for approval/.test(m.subject)));
  const types = (await env.store.listSecurityAuditEvents()).map((e) => e.type);
  assert.ok(types.includes('video.uploaded') && types.includes('video.processed'));
});

test('worker: a failing transcode is retried a limited number of times, then failed with a plain reason', async (t) => {
  let runs = 0;
  const { env, member, queue } = await setup(t, {
    video: { maxAttempts: 2 },
    ffmpeg: {
      async transcode() {
        runs += 1;
        throw new Error('ffmpeg failed (exit 1)');
      },
    },
  });
  const done = await uploadVideo(member, fakeMp4(CHUNK));
  const jobId = done.json.job.id;
  assert.equal((await queue.runOnce()).status, 'queued');
  // Retry is delayed; make it due now.
  await env.store.updateVideoJob(jobId, { runAfter: new Date(Date.now() - 1).toISOString() });
  assert.equal((await queue.runOnce()).status, 'failed');
  assert.equal(runs, 2);
  const job = await env.store.findVideoJob(jobId);
  assert.equal(job.status, 'failed');
  assert.equal(job.reason, 'processing_failed');
  assert.equal(fs.existsSync(queue.jobFile(jobId, 'src')), false, 'original removed on final failure');
  const status = await api(member, 'GET', `/videos/jobs/${jobId}`);
  assert.equal(status.json.job.status, 'failed');
  assert.match(status.json.job.message, /couldn't process this video/);
  assert.equal((await env.store.listPhotos()).length, 0);
});

test('worker: a job left running by a crash is picked up after its lease, and partial media is cleaned first', async (t) => {
  const { env, member, queue } = await setup(t, { video: { leaseMs: 50 } });
  const done = await uploadVideo(member, fakeMp4(CHUNK * 2));
  const jobId = done.json.job.id;
  // Simulate a crash mid-store: claimed, mediaId recorded, one segment written.
  await env.store.claimVideoJob({ now: Date.now(), leaseMs: 50, maxAttempts: 3 });
  const stale = crypto.randomUUID();
  await env.store.updateVideoJob(jobId, { mediaId: stale, plannedSegments: 1 });
  env.mediaStorage.objects.set(`photos/${stale}/v000000`, Buffer.from('partial'));
  assert.equal(await queue.runOnce(), null, 'lease still live');
  await new Promise((r) => setTimeout(r, 80));
  const outcome = await queue.runOnce();
  assert.equal(outcome.status, 'done');
  assert.equal(env.mediaStorage.objects.has(`photos/${stale}/v000000`), false, 'partial segment removed');
  assert.equal((await env.store.findVideoJob(jobId)).attempts, 2);
  assert.equal((await env.store.listPhotos()).length, 1, 'exactly one video made');
});

test('worker: a clean shutdown hands the running job straight back', async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { env, member, queue } = await setup(t, {
    ffmpeg: {
      async transcode(input, output) {
        await gate;
        fs.copyFileSync(input, output);
      },
    },
  });
  const done = await uploadVideo(member, fakeMp4(CHUNK));
  const running = queue.runOnce();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal((await env.store.findVideoJob(done.json.job.id)).status, 'running');
  await queue.stop();
  assert.equal((await env.store.findVideoJob(done.json.job.id)).status, 'queued');
  release();
  await running;
});

test('worker sweep: leftover work files with no open job are removed', async (t) => {
  const { queue } = await setup(t);
  const orphan = queue.jobFile(crypto.randomUUID(), 'src');
  fs.writeFileSync(orphan, 'x');
  const past = new Date(Date.now() - 60 * 60 * 1000);
  fs.utimesSync(orphan, past, past);
  assert.equal(await queue.sweep(), 1);
  assert.equal(fs.existsSync(orphan), false);
});

// -- Playback, download refusal, approval, erasure --------------------------

async function readyVideo(t, opts) {
  const ctx = await setup(t, opts);
  const bytes = fakeMp4(CHUNK * 5 + 321);
  // A parent's upload: added straight away, private to parents.
  const done = await uploadVideo(ctx.parent, bytes, { caption: 'Garden run' });
  const outcome = await ctx.queue.runOnce();
  return { ...ctx, bytes, videoId: outcome.photoId, jobId: done.json.job.id };
}

function get(client, p, headers = {}) {
  return rawRequest(client.base, p, { headers: { cookie: client.cookieHeader(), ...headers } });
}

test('stream: Range edge cases (first byte, middle, suffix, beyond the end) and the headers Safari needs', async (t) => {
  const { parent, bytes, videoId } = await readyVideo(t);
  const url = `/media/${videoId}/video`;
  const size = bytes.length;

  const whole = await get(parent, url);
  assert.equal(whole.status, 200);
  assert.deepEqual(whole.buffer, bytes);
  assert.equal(whole.headers['accept-ranges'], 'bytes');
  assert.equal(whole.headers['content-type'], 'video/mp4');
  assert.match(whole.headers['cache-control'], /private/);
  assert.match(whole.headers['cache-control'], /no-store/);
  assert.equal(whole.headers['x-content-type-options'], 'nosniff');

  const first = await get(parent, url, { range: 'bytes=0-1' });
  assert.equal(first.status, 206);
  assert.equal(first.headers['content-range'], `bytes 0-1/${size}`);
  assert.equal(first.headers['content-length'], '2');
  assert.deepEqual(first.buffer, bytes.subarray(0, 2));

  const oneByte = await get(parent, url, { range: 'bytes=0-0' });
  assert.deepEqual(oneByte.buffer, bytes.subarray(0, 1));

  const middle = await get(parent, url, { range: 'bytes=1000-3100' });
  assert.equal(middle.status, 206);
  assert.equal(middle.headers['content-range'], `bytes 1000-3100/${size}`);
  assert.deepEqual(middle.buffer, bytes.subarray(1000, 3101));

  const open = await get(parent, url, { range: `bytes=${size - 10}-` });
  assert.deepEqual(open.buffer, bytes.subarray(size - 10));

  const suffix = await get(parent, url, { range: 'bytes=-500' });
  assert.equal(suffix.status, 206);
  assert.equal(suffix.headers['content-range'], `bytes ${size - 500}-${size - 1}/${size}`);
  assert.deepEqual(suffix.buffer, bytes.subarray(size - 500));

  const beyond = await get(parent, url, { range: `bytes=${size}-` });
  assert.equal(beyond.status, 416);
  assert.equal(beyond.headers['content-range'], `bytes */${size}`);
  assert.equal(beyond.buffer.length, 0);

  const head = await rawRequest(parent.base, url, { method: 'HEAD', headers: { cookie: parent.cookieHeader(), range: 'bytes=0-9' } });
  assert.equal(head.status, 206);
  assert.equal(head.buffer.length, 0);
});

test('stream: the same permission check as photos runs before any byte; never public', async (t) => {
  const { env, member, parent, videoId } = await readyVideo(t);
  const url = `/media/${videoId}/video`;
  // Private to parents: a member gets nothing.
  const denied = await get(member, url, { range: 'bytes=0-1' });
  assert.equal(denied.status, 404);
  assert.equal(denied.buffer.length, 0);
  // Signed out: sent to sign in, no bytes.
  const anon = await get(env.client(), url);
  assert.equal(anon.status, 302);
  assert.match(anon.location, /\/login/);
  // Shared with everyone: the member can play it.
  await env.store.updatePhoto(videoId, { audienceType: 'everyone' });
  assert.equal((await get(member, url, { range: 'bytes=0-1' })).status, 206);
  void parent;
});

test('downloads are off for videos: no button, a friendly note, and the server refuses', async (t) => {
  const { env, member, parent, videoId } = await readyVideo(t);
  // Even a store caller asking for downloadable gets a non-downloadable video.
  await env.store.updatePhoto(videoId, { audienceType: 'everyone', downloadable: true });
  assert.equal((await env.store.findPhotoById(videoId)).downloadable, false);

  for (const client of [parent, member]) {
    const page = await client.get(`/photos/${videoId}`);
    assert.equal(page.status, 200);
    assert.match(page.body, /<video[^>]*controls[^>]*playsinline[^>]*preload="metadata"/);
    assert.ok(!page.body.includes(`/photos/${videoId}/download`), 'no download link');
    assert.match(page.body, /Videos stay snug inside Cubhouse for now, to keep them private\. Downloads may come later\./);

    const dl = await client.get(`/photos/${videoId}/download`);
    assert.equal(dl.status, 403);
    assert.ok(!/video\/mp4|attachment/.test(`${dl.headers['content-type']} ${dl.headers['content-disposition'] || ''}`));
    assert.match(dl.body, /Videos stay snug inside Cubhouse/);
  }
  assert.equal((await env.store.listDownloads()).length, 0);
  // The gallery shows a poster with a play badge and the duration, no Download link.
  const gallery = await parent.get('/photos');
  assert.match(gallery.body, /video-play-badge/);
  assert.match(gallery.body, /class="video-duration"[^>]*>0:02</);
  assert.ok(!gallery.body.includes(`/photos/${videoId}/download`));
});

test('approval queue: a guardian can watch a member\'s video before approving it', async (t) => {
  const { env, member, parent, queue } = await setup(t);
  const bytes = fakeMp4(CHUNK * 2);
  await uploadVideo(member, bytes);
  const { photoId } = await queue.runOnce();
  const home = await parent.get('/home');
  assert.match(home.body, /Waiting for your approval/);
  assert.ok(home.body.includes(`/photos/${photoId}`));
  const watch = await get(parent, `/media/${photoId}/video`, { range: 'bytes=0-99' });
  assert.equal(watch.status, 206);
  assert.deepEqual(watch.buffer, bytes.subarray(0, 100));
  // Approve for the whole family (needs the other guardian only when there is one).
  const res = await parent.post(`/photos/${photoId}/approve`, { audienceType: 'everyone' });
  assert.equal(res.status, 302);
  const after = await env.store.findPhotoById(photoId);
  assert.equal(after.pendingApproval, false);
});

test('erasure: deleting a video, or erasing the archive, removes every stored segment', async (t) => {
  const { env, parent, queue, videoId } = await readyVideo(t);
  // A second video for the archive-wide erase.
  await uploadVideo(parent, fakeMp4(CHUNK * 2));
  await queue.runOnce();
  const v = await env.store.findPhotoById(videoId);
  const keysFor = (id) => [...env.mediaStorage.objects.keys()].filter((k) => k.includes(id));
  assert.equal(keysFor(v.mediaId).length, 3 + v.video.segmentCount);

  const removed = await env.services.actions.deletePhotoCompletely(videoId);
  assert.equal(removed.removedKeys.filter((k) => /\/v\d{6}$/.test(k)).length, v.video.segmentCount);
  assert.equal(keysFor(v.mediaId).length, 0);
  assert.equal(await env.store.findPhotoById(videoId), null);

  await env.services.actions.executors['archive.erase']({});
  assert.equal(env.mediaStorage.objects.size, 0, 'nothing left in the bucket');
});

test('archive export lists videos as not included and carries none of their bytes', async (t) => {
  const { parent, bytes } = await readyVideo(t);
  const res = await parent.post('/admin/archive/export');
  assert.equal(res.headers['content-type'], 'application/zip');
  const text = res.buffer.toString('latin1');
  assert.match(text, /"kind": "video"/);
  assert.match(text, /"included": false/);
  assert.match(text, /"caption": "Garden run"/);
  assert.equal(res.buffer.indexOf(bytes.subarray(64, 128)), -1, 'no video bytes in the export');
  assert.equal((text.match(/\xff\xd8\xff/g) || []).length, 0, 'not even the poster, as a stand-in photo');
});

test('member data export lists the videos they sent in; usage counts a video upload once', async (t) => {
  const { env, member, queue } = await setup(t);
  await uploadVideo(member, fakeMp4(CHUNK * 3), { caption: 'Sandcastle' });
  await queue.runOnce();
  await env.services.usage.flush();
  const rows = await env.store.listUsageSince('2000-01-01');
  const uploads = rows.filter((r) => r.metric === 'section.uploads').reduce((n, r) => n + r.value, 0);
  assert.equal(uploads, 1, 'one start request, not one per chunk');

  const res = await member.post('/settings/export', {});
  assert.equal(res.status, 200);
  // The zip stores entries uncompressed, so the JSON is readable in place.
  const text = res.buffer.toString('utf8');
  assert.match(text, /"kind": "video"/);
  assert.match(text, /"caption": "Sandcastle"/);
});
