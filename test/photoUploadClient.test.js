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
