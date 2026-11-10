'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const upload = require('../public/photo-upload');

// -- checkFile ---------------------------------------------------------------

test('checkFile rejects videos by type and extension', () => {
  assert.equal(upload.checkFile({ type: 'video/mp4', size: 1000, name: 'a.mp4' }, 15e6), 'video');
  assert.equal(upload.checkFile({ type: '', size: 1000, name: 'a.mov' }, 15e6), 'video');
});

test('checkFile rejects HEIC by type and extension', () => {
  assert.equal(upload.checkFile({ type: 'image/heic', size: 1000, name: 'a.heic' }, 15e6), 'heic');
  assert.equal(upload.checkFile({ type: '', size: 1000, name: 'a.HEIF' }, 15e6), 'heic');
});

test('checkFile rejects oversized files', () => {
  assert.equal(upload.checkFile({ type: 'image/jpeg', size: 16e6, name: 'a.jpg' }, 15e6), 'too_large');
});

test('checkFile rejects empty files', () => {
  assert.equal(upload.checkFile({ type: 'image/jpeg', size: 0, name: 'a.jpg' }, 15e6), 'empty');
});

test('checkFile rejects unsupported types', () => {
  assert.equal(upload.checkFile({ type: 'application/pdf', size: 1000, name: 'a.pdf' }, 15e6), 'unsupported_type');
});

test('checkFile accepts JPEG, PNG, WebP, AVIF', () => {
  for (const type of ['image/jpeg', 'image/png', 'image/webp', 'image/avif']) {
    assert.equal(upload.checkFile({ type, size: 1000, name: 'a.jpg' }, 15e6), null);
  }
});

test('checkFile accepts a typeless file with a known extension', () => {
  assert.equal(upload.checkFile({ type: '', size: 1000, name: 'photo.jpg' }, 15e6), null);
  assert.equal(upload.checkFile({ type: '', size: 1000, name: 'shot.PNG' }, 15e6), null);
});

// -- messageFor --------------------------------------------------------------

test('messageFor returns a plain-language reason for each code', () => {
  for (const code of ['too_large', 'video', 'heic', 'empty', 'unsupported_type', 'duplicate',
    'network', 'rate_limited', 'signed_out', 'expired', 'cancelled', 'server_error']) {
    const msg = upload.messageFor(code);
    assert.ok(msg.length > 5, `${code} -> "${msg}"`);
  }
});

test('messageFor passes through server-worded messages for recognized codes', () => {
  assert.equal(
    upload.messageFor('unreadable', { serverMessage: 'Custom server text.' }),
    'Custom server text.'
  );
});

// -- interpretResponse -------------------------------------------------------

test('interpretResponse: success', () => {
  const r = upload.interpretResponse(201, { ok: true, photo: { id: '1' }, sharing: 'private' });
  assert.equal(r.ok, true);
  assert.equal(r.photo.id, '1');
});

test('interpretResponse: error with code', () => {
  const r = upload.interpretResponse(422, { ok: false, error: { code: 'unsupported_type', message: 'Not a photo.' } });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'unsupported_type');
});

test('interpretResponse: 403 with no JSON', () => {
  const r = upload.interpretResponse(403, null);
  assert.equal(r.code, 'expired');
});

test('interpretResponse: 0 (network)', () => {
  const r = upload.interpretResponse(0, null);
  assert.equal(r.code, 'network');
});

test('interpretResponse: redirect to login', () => {
  const r = upload.interpretResponse(200, null, true);
  assert.equal(r.code, 'signed_out');
});

// -- createQueue -------------------------------------------------------------

function fakeSend(results) {
  let calls = 0;
  return function (item, onProgress) {
    const idx = calls;
    calls += 1;
    return {
      promise: new Promise((resolve) => {
        setImmediate(() => {
          onProgress(item.size, item.size);
          resolve(results[idx] || { ok: true, photo: { id: 'p' + idx } });
        });
      }),
      abort() {},
    };
  };
}

function fakeFile(name, size, type) {
  return { name, size: size || 1000, type: type || 'image/jpeg', lastModified: 0 };
}

test('queue: basic add-start-finish flow', async () => {
  const changes = [];
  const q = upload.createQueue({
    send: fakeSend([{ ok: true, photo: { id: '1' } }]),
    maxBytes: 15e6,
    onChange: (item) => changes.push({ id: item.id, state: item.state }),
    onFinish: (c) => changes.push({ finish: true, done: c.done }),
  });
  q.add([fakeFile('a.jpg')]);
  assert.equal(q.counts().queued, 1);
  q.start();
  // Wait for the event loop to run the fake send.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(q.counts().done, 1);
  assert.ok(changes.some((c) => c.finish && c.done === 1));
});

test('queue: never more than 3 uploads at once, and one failure does not stop the rest', async () => {
  let inFlight = 0;
  let peak = 0;
  let n = 0;
  const send = () => {
    inFlight += 1;
    peak = Math.max(peak, inFlight);
    const idx = n;
    n += 1;
    return {
      promise: new Promise((resolve) =>
        setTimeout(() => {
          inFlight -= 1;
          resolve(idx === 2 ? { ok: false, code: 'server_error' } : { ok: true, photo: { id: String(idx) } });
        }, 5)
      ),
      abort() {},
    };
  };
  let finished = null;
  const q = upload.createQueue({ send, maxBytes: 15e6, onFinish: (c) => (finished = c) });
  q.add(Array.from({ length: 10 }, (_, i) => fakeFile(`p${i}.jpg`)));
  q.start();
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(peak, upload.CONCURRENCY);
  assert.equal(finished.done, 9);
  assert.equal(finished.failed, 1);
});

test('queue: client-side failures are instant and not retryable', async () => {
  const q = upload.createQueue({ send: fakeSend([]), maxBytes: 15e6 });
  q.add([fakeFile('clip.mp4', 2000, 'video/mp4')]);
  assert.equal(q.counts().failed, 1);
  assert.equal(q.items()[0].retryable, false);
});

test('queue: duplicates are skipped', () => {
  const q = upload.createQueue({ send: fakeSend([]), maxBytes: 15e6 });
  q.add([fakeFile('a.jpg')]);
  q.add([fakeFile('a.jpg')]);
  assert.equal(q.counts().skipped, 1);
  assert.equal(q.counts().queued, 1);
});

test('queue: a rate_limited response holds remaining queued items', async () => {
  const q = upload.createQueue({
    send: fakeSend([{ ok: false, code: 'rate_limited', serverMessage: 'Try later.' }]),
    maxBytes: 15e6,
    concurrency: 1,
  });
  q.add([fakeFile('a.jpg'), fakeFile('b.jpg', 1000, 'image/png')]);
  q.start();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(q.counts().failed, 2, 'both should be failed');
  // They're retryable (server failures are), so retry works.
  assert.ok(q.items().every((it) => it.retryable));
});

test('queue: retryFailed re-queues failed-and-retryable items', async () => {
  const attempt = { n: 0 };
  const send = function (item, onProgress) {
    attempt.n += 1;
    return {
      promise: new Promise((resolve) => setImmediate(() => {
        onProgress(item.size, item.size);
        resolve(attempt.n > 1 ? { ok: true, photo: { id: '1' } } : { ok: false, code: 'server_error' });
      })),
      abort() {},
    };
  };
  const q = upload.createQueue({ send, maxBytes: 15e6 });
  q.add([fakeFile('a.jpg')]);
  q.start();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(q.counts().failed, 1);
  q.retryFailed();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(q.counts().done, 1);
});

test('queue: cancel stops a queued item', () => {
  const q = upload.createQueue({ send: fakeSend([]), maxBytes: 15e6 });
  q.add([fakeFile('a.jpg')]);
  q.cancel(q.items()[0].id);
  assert.equal(q.counts().cancelled, 1);
});

test('queue: clearFinished removes finished, keeps active', async () => {
  const q = upload.createQueue({ send: fakeSend([{ ok: true, photo: { id: '1' } }]), maxBytes: 15e6 });
  q.add([fakeFile('a.jpg')]);
  q.start();
  await new Promise((r) => setTimeout(r, 50));
  const removed = q.clearFinished();
  assert.equal(removed.length, 1);
  assert.equal(q.items().length, 0);
});

// -- summarize ---------------------------------------------------------------

test('summarize: parent success', () => {
  const s = upload.summarize({ done: 3, failed: 0, cancelled: 0, skipped: 0, awaitingGuardian: 0, total: 3 }, 'parent');
  assert.equal(s.tone, 'success');
  assert.ok(s.headline.includes('3 photos'));
  assert.equal(s.link.href, '/photos');
});

test('summarize: member with failures', () => {
  const s = upload.summarize({ done: 2, failed: 1, cancelled: 0, skipped: 0, awaitingGuardian: 0, total: 3 }, 'member');
  assert.equal(s.tone, 'mixed');
  assert.equal(s.headline, '2 photos sent, 1 failed');
  assert.ok(s.lines.some((l) => /once a parent approves/.test(l)));
  assert.equal(s.link.href, '/home?uploaded=1#my-uploads');
});

test('overallText counts only photos actually sent, not files refused up front', () => {
  // 7 sent (4 queued + 3 uploading); the 2 failures were refused before sending.
  const c = { total: 9, queued: 4, uploading: 3, processing: 0, done: 0, failed: 2, cancelled: 0, skipped: 0, rejected: 2 };
  assert.match(upload.overallText(c, { percent: 20, eta: NaN }), /^Uploading: 0 of 7 finished, 20%$/);
});

// -- Videos ---------------------------------------------------------------------

const VIDEO = { maxBytes: 500 * 1024 * 1024 };

test('checkFile with videos on: MP4/MOV accepted by type or name, others refused, size capped', () => {
  assert.equal(upload.checkFile({ type: 'video/mp4', size: 1000, name: 'a.mp4' }, 15e6, VIDEO), null);
  assert.equal(upload.checkFile({ type: 'video/quicktime', size: 1000, name: 'IMG_0001.MOV' }, 15e6, VIDEO), null);
  assert.equal(upload.checkFile({ type: '', size: 1000, name: 'clip.mov' }, 15e6, VIDEO), null);
  assert.equal(upload.checkFile({ type: 'video/webm', size: 1000, name: 'a.webm' }, 15e6, VIDEO), 'unsupported_video');
  assert.equal(upload.checkFile({ type: '', size: 1000, name: 'a.avi' }, 15e6, VIDEO), 'unsupported_video');
  assert.equal(upload.checkFile({ type: 'video/mp4', size: 501 * 1024 * 1024, name: 'a.mp4' }, 15e6, VIDEO), 'video_too_large');
  assert.equal(upload.checkFile({ type: 'video/mp4', size: 0, name: 'a.mp4' }, 15e6, VIDEO), 'empty');
  // A big video is fine even though photos stop at 15 MB.
  assert.equal(upload.checkFile({ type: 'video/mp4', size: 200e6, name: 'a.mp4' }, 15e6, VIDEO), null);
});

test('messages: video reasons are plain and specific', () => {
  assert.match(upload.messageFor('too_long', { videoMaxSeconds: 180 }), /Longer than 3 minutes/);
  assert.match(upload.messageFor('video_too_large'), /Too big: over 500 MB/);
  assert.match(upload.messageFor('unsupported_video'), /MP4 or MOV/);
  assert.match(upload.messageFor('processing_failed'), /couldn't process this video/);
  assert.equal(upload.itemsText(3, 1), '2 photos and 1 video');
  assert.equal(upload.itemsText(1, 1), '1 video');
  assert.equal(upload.itemsText(2, 0), '2 photos');
});

/** A fake server for the chunked sender, with switchable network failures. */
function fakeServer({ chunkBytes = 4, failPuts = [], jobStates = ['waiting', 'processing', 'done'] } = {}) {
  const calls = [];
  const sessions = {};
  let nextId = 1;
  let polls = 0;
  const failing = failPuts.slice();
  function reply(status, json) {
    return { promise: Promise.resolve({ status, json, toLogin: false }), abort() {} };
  }
  return {
    calls,
    sessions,
    request(method, url, opts) {
      calls.push(`${method} ${url}`);
      let m;
      if (method === 'POST' && url === '/videos/uploads') {
        const size = Number(new URLSearchParams(opts.body).get('size'));
        const id = `s${nextId++}`;
        sessions[id] = { size, received: [] };
        return reply(201, { ok: true, upload: { id, size, chunkBytes, chunkCount: Math.ceil(size / chunkBytes), received: [] } });
      }
      if ((m = /^\/videos\/uploads\/(\w+)$/.exec(url)) && method === 'GET') {
        const s = sessions[m[1]];
        if (!s) {
          return reply(404, { ok: false, error: { code: 'upload_gone', message: 'gone' } });
        }
        return reply(200, { ok: true, upload: { id: m[1], size: s.size, chunkBytes, chunkCount: Math.ceil(s.size / chunkBytes), received: s.received.slice() } });
      }
      if ((m = /^\/videos\/uploads\/(\w+)\/chunks\/(\d+)$/.exec(url))) {
        const idx = Number(m[2]);
        if (failing.length && failing[0] === idx) {
          failing.shift();
          return reply(0, null); // the connection dropped mid-chunk
        }
        if (opts.onProgress) {
          opts.onProgress(opts.body.length);
        }
        sessions[m[1]].received.push(idx);
        return reply(200, { ok: true, upload: {} });
      }
      if (/^\/videos\/uploads\/(\w+)\/complete$/.test(url)) {
        return reply(202, { ok: true, job: { id: 'j1', status: 'processing' } });
      }
      if (url === '/videos/jobs/j1') {
        const status = jobStates[Math.min(polls, jobStates.length - 1)];
        polls += 1;
        return reply(200, {
          ok: true,
          job: status === 'done'
            ? { id: 'j1', status, photo: { id: 'v1', url: '/photos/v1' }, sharing: 'private' }
            : status === 'failed'
              ? { id: 'j1', status, code: 'processing_failed', message: 'We couldn\'t process this video.' }
              : { id: 'j1', status },
        });
      }
      if (method === 'DELETE') {
        delete sessions[url.split('/').pop()];
        return reply(200, { ok: true });
      }
      return reply(500, null);
    },
  };
}

function videoFile(size) {
  const bytes = Buffer.alloc(size, 1);
  return { name: 'clip.mov', type: 'video/quicktime', size, lastModified: 1, slice: (a, b) => bytes.subarray(a, b) };
}

const noWait = () => Promise.resolve();

test('video sender: chunks, finish, then polls Processing until Added', async () => {
  const server = fakeServer();
  const send = upload.createVideoSender({ request: server.request, csrf: 't', wait: noWait });
  const item = { file: videoFile(10), size: 10, fields: { caption: 'Hi' } };
  const progress = [];
  const phases = [];
  const res = await send(item, (l, tot) => progress.push([l, tot]), (p) => phases.push(p)).promise;
  assert.equal(res.ok, true);
  assert.equal(res.photo.id, 'v1');
  assert.deepEqual(server.calls.filter((c) => c.includes('/chunks/')), [
    'PUT /videos/uploads/s1/chunks/0', 'PUT /videos/uploads/s1/chunks/1', 'PUT /videos/uploads/s1/chunks/2',
  ]);
  // "All bytes in" is reported only after the server accepted the finish.
  assert.ok(progress.slice(0, -1).every(([l, tot]) => l < tot));
  assert.deepEqual(progress[progress.length - 1], [10, 10]);
  assert.deepEqual(phases, ['waiting', 'waiting', 'processing']);
});

test('video sender: a dropped connection resends that chunk only; a later Retry resumes from what arrived', async () => {
  // Chunk 1 drops once (retried in place).
  const server = fakeServer({ failPuts: [1] });
  const send = upload.createVideoSender({ request: server.request, csrf: 't', wait: noWait });
  const item = { file: videoFile(12), size: 12, fields: {} };
  assert.equal((await send(item, () => {}).promise).ok, true);
  const puts = server.calls.filter((c) => c.includes('/chunks/'));
  assert.deepEqual(puts, [
    'PUT /videos/uploads/s1/chunks/0', 'PUT /videos/uploads/s1/chunks/1', 'PUT /videos/uploads/s1/chunks/1',
    'PUT /videos/uploads/s1/chunks/2',
  ]);

  // Out of in-place retries: the item fails as "network", keeps its session,
  // and Retry continues from chunk 2 instead of starting over.
  const flaky = fakeServer({ failPuts: [2, 2, 2] });
  const sendFlaky = upload.createVideoSender({ request: flaky.request, csrf: 't', wait: noWait, chunkRetries: 2 });
  const it2 = { file: videoFile(16), size: 16, fields: {} };
  const first = await sendFlaky(it2, () => {}).promise;
  assert.equal(first.ok, false);
  assert.equal(first.code, 'network');
  assert.equal(it2.upload.id, 's1');
  flaky.calls.length = 0;
  const second = await sendFlaky(it2, () => {}).promise;
  assert.equal(second.ok, true);
  assert.deepEqual(flaky.calls.slice(0, 3), [
    'GET /videos/uploads/s1', 'PUT /videos/uploads/s1/chunks/2', 'PUT /videos/uploads/s1/chunks/3',
  ]);
});

test('video sender: over 3 minutes by the browser\'s own reading fails before any upload', async () => {
  const server = fakeServer();
  const send = upload.createVideoSender({ request: server.request, csrf: 't', wait: noWait, videoMaxSeconds: 180 });
  const item = { file: videoFile(10), size: 10, fields: {}, durationPromise: Promise.resolve(185000), retryable: true };
  const res = await send(item, () => {}).promise;
  assert.equal(res.code, 'too_long');
  assert.equal(item.retryable, false);
  assert.equal(server.calls.length, 0);
});

test('video sender: a processing failure comes back with the server\'s plain reason', async () => {
  const server = fakeServer({ jobStates: ['processing', 'failed'] });
  const send = upload.createVideoSender({ request: server.request, csrf: 't', wait: noWait });
  const res = await send({ file: videoFile(4), size: 4, fields: {} }, () => {}).promise;
  assert.equal(res.ok, false);
  assert.equal(res.code, 'processing_failed');
  assert.match(res.serverMessage, /couldn't process/);
});

test('video sender: cancel aborts and tells the server to drop the partial upload', async () => {
  const server = fakeServer();
  let handle;
  const slowRequest = (method, url, opts) => {
    if (url.includes('/chunks/1')) {
      // Never answers until aborted.
      let resolve;
      const promise = new Promise((r) => (resolve = r));
      return { promise, abort: () => resolve({ status: 0, json: null }) };
    }
    return server.request(method, url, opts);
  };
  const send = upload.createVideoSender({ request: slowRequest, csrf: 't', wait: noWait });
  const item = { file: videoFile(12), size: 12, fields: {} };
  handle = send(item, () => {});
  await new Promise((r) => setTimeout(r, 10));
  handle.abort();
  const res = await handle.promise;
  assert.equal(res.code, 'cancelled');
  assert.ok(server.calls.includes('DELETE /videos/uploads/s1'));
  assert.equal(server.sessions.s1, undefined);
});

test('queue: mixed photo and video batch; one video sends at a time; summary names both', async () => {
  let videoInFlight = 0;
  let videoPeak = 0;
  const sendVideo = (item, onProgress) => {
    videoInFlight += 1;
    videoPeak = Math.max(videoPeak, videoInFlight);
    return {
      promise: new Promise((resolve) => setTimeout(() => {
        videoInFlight -= 1;
        onProgress(item.size, item.size);
        resolve({ ok: true, photo: { id: 'v' }, sharing: 'private' });
      }, 10)),
      abort() {},
    };
  };
  let finished = null;
  const q = upload.createQueue({
    send: fakeSend([]),
    sendVideo,
    video: VIDEO,
    maxBytes: 15e6,
    onFinish: (c) => (finished = c),
  });
  q.add([
    fakeFile('a.jpg'),
    { name: 'one.mov', size: 5e6, type: 'video/quicktime', lastModified: 1 },
    fakeFile('b.jpg'),
    { name: 'two.mp4', size: 6e6, type: 'video/mp4', lastModified: 2 },
  ]);
  assert.deepEqual(q.items().map((it) => it.kind), ['photo', 'video', 'photo', 'video']);
  q.start();
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(videoPeak, 1);
  assert.equal(finished.done, 4);
  assert.equal(finished.doneVideos, 2);
  const s = upload.summarize(finished, 'parent');
  assert.equal(s.headline, '2 photos and 2 videos added');
  assert.ok(s.lines.some((l) => /photos and videos are private/.test(l)));
});

test('queue: a video found too long after picking is failed at once and cannot be retried', () => {
  const q = upload.createQueue({ send: fakeSend([]), sendVideo: fakeSend([]), video: VIDEO, maxBytes: 15e6 });
  const [item] = q.add([{ name: 'long.mov', size: 5e6, type: 'video/quicktime', lastModified: 1 }]);
  assert.equal(q.reject(item.id, 'too_long'), true);
  assert.equal(q.items()[0].state, 'failed');
  assert.equal(q.retry(item.id), false);
});

test('stateText: video rows say Processing, then Added or Sent for approval', () => {
  const base = { kind: 'video', size: 10, loaded: 10 };
  assert.match(upload.stateText({ ...base, state: 'processing', phase: 'waiting' }, 'parent'), /^Processing/);
  assert.match(upload.stateText({ ...base, state: 'processing', phase: 'processing' }, 'parent'), /removing location/);
  assert.match(upload.stateText({ ...base, state: 'done' }, 'parent'), /^Added/);
  assert.equal(upload.stateText({ ...base, state: 'done' }, 'member'), 'Sent for approval');
});
