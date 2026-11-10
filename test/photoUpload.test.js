'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const config = require('../src/config');
const { startApp, seedFamily } = require('./helpers');
const { jpegWithGps, plainPng, plainJpeg } = require('./fixtures/makeImages');
const { sanitizeImage, metadataReport } = require('../src/media/pipeline');

const LIMITS = { maxPixels: 50e6, allowedFormats: ['jpeg', 'png', 'webp', 'heif', 'avif'] };

async function setup(t) {
  const env = await startApp();
  t.after(env.close);
  const people = await seedFamily(env);
  const parent = env.client();
  const member = env.client();
  await parent.login('parent@test.com');
  await member.login('member@test.com');
  // Clients last so they win over the same-named user records.
  return { ...people, env, parent, member };
}

test('sanitizer: GPS, device, serial, and owner metadata are removed from every variant', async () => {
  const src = await jpegWithGps();
  assert.equal((await metadataReport(src)).hasExif, true);
  const { variants } = await sanitizeImage(src, LIMITS);
  for (const [name, buf] of Object.entries(variants)) {
    const report = await metadataReport(buf);
    assert.equal(report.hasExif, false, `${name} kept EXIF`);
    assert.equal(report.hasXmp, false, `${name} kept XMP`);
    assert.equal(report.hasIptc, false, `${name} kept IPTC`);
    const text = buf.toString('latin1');
    for (const needle of ['PhoneCo', 'Pocket 15', 'SN-1234567890', 'Parent Fullname', 'Elm Street']) {
      assert.ok(!text.includes(needle), `${name} still contains ${needle}`);
    }
  }
});

test('sanitizer: the declared type is ignored; non-images are rejected by their bytes', async () => {
  await assert.rejects(sanitizeImage(Buffer.from('<html><script>alert(1)</script></html>'), LIMITS), {
    name: 'UploadRejected',
  });
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"></svg>');
  await assert.rejects(sanitizeImage(svg, LIMITS), { name: 'UploadRejected' });
});

test('sanitizer: decompression bombs and animations are refused', async () => {
  const big = await sharp({ create: { width: 9000, height: 9000, channels: 3, background: '#000' } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await assert.rejects(sanitizeImage(big, { ...LIMITS, maxPixels: 50e6 }), { name: 'UploadRejected' });
  const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#f00' } }).gif().toBuffer();
  await assert.rejects(sanitizeImage(gif, LIMITS), { name: 'UploadRejected' });
});

test('end to end: an uploaded phone photo is stored encrypted and served without its metadata', async (t) => {
  const { env, parent } = await setup(t);
  const res = await parent.postMultipart('/photos/upload', { caption: 'At the park' }, { buffer: await jpegWithGps() });
  assert.equal(res.status, 302);
  const [photo] = await env.store.listPhotos();
  assert.equal(photo.caption, 'At the park');
  // Private by default.
  assert.equal(photo.audienceType, 'parents');
  // Stored bytes are ciphertext, not a JPEG.
  for (const bytes of env.mediaStorage.objects.values()) {
    assert.notEqual(bytes.subarray(0, 2).toString('hex'), 'ffd8');
  }
  const served = await parent.get(`/media/${photo.id}/full`);
  assert.equal(served.headers['content-type'], 'image/jpeg');
  assert.match(served.headers['cache-control'], /no-store/);
  assert.equal((await metadataReport(served.buffer)).hasExif, false);
});

test('a family member upload is pending, private, and goes to the guardians', async (t) => {
  const { env, member } = await setup(t);
  await member.postMultipart('/photos/upload', { caption: 'From grandma' }, { buffer: await plainPng() });
  const [photo] = await env.store.listPhotos();
  assert.equal(photo.pendingApproval, true);
  assert.equal((await member.get(`/media/${photo.id}/thumb`)).status, 404);
  assert.ok(env.notifier.sent.some((m) => /waiting for approval/.test(m.subject)));
});

test('approving requires choosing an audience (no silent "everyone")', async (t) => {
  const { env, parent, member } = await setup(t);
  await member.postMultipart('/photos/upload', {}, { buffer: await plainJpeg() });
  const [photo] = await env.store.listPhotos();
  await parent.post(`/photos/${photo.id}/approve`, {});
  assert.equal((await env.store.findPhotoById(photo.id)).pendingApproval, true);
  await parent.post(`/photos/${photo.id}/approve`, { audienceType: 'everyone' });
  const approved = await env.store.findPhotoById(photo.id);
  assert.equal(approved.pendingApproval, false);
  assert.equal(approved.audienceType, 'everyone');
  assert.ok(approved.publishedBy);
});

test('rejecting a contribution purges its stored media', async (t) => {
  const { env, parent, member } = await setup(t);
  await member.postMultipart('/photos/upload', {}, { buffer: await plainJpeg() });
  const [photo] = await env.store.listPhotos();
  assert.equal(env.mediaStorage.objects.size, 3);
  await parent.post(`/photos/${photo.id}/reject`);
  assert.equal(await env.store.findPhotoById(photo.id), null);
  assert.equal(env.mediaStorage.objects.size, 0);
});

test('invalid, missing, and oversized uploads create nothing', async (t) => {
  const { env, parent } = await setup(t);
  await parent.postMultipart('/photos/upload', {}, { buffer: Buffer.from('not an image'), type: 'image/png' });
  await parent.postMultipart('/photos/upload', {}, null);
  const saved = config.uploads.maxBytes;
  config.uploads.maxBytes = 1000;
  t.after(() => {
    config.uploads.maxBytes = saved;
  });
  await parent.postMultipart('/photos/upload', {}, { buffer: await plainJpeg({ width: 1600, height: 1200 }) });
  assert.equal((await env.store.listPhotos()).length, 0);
  assert.equal(env.mediaStorage.objects.size, 0);
});

test('an upload without a CSRF token is refused', async (t) => {
  const { env, parent } = await setup(t);
  const res = await parent.postMultipart('/photos/upload', { _csrf: 'forged' }, { buffer: await plainJpeg() }, { csrf: false });
  assert.equal(res.status, 403);
  assert.equal((await env.store.listPhotos()).length, 0);
});

test('a parent upload with a family-wide profile is governed like any widening', async (t) => {
  const env = await startApp();
  t.after(env.close);
  await seedFamily(env, { twoGuardians: true });
  const profile = await env.store.createUploadProfile({ name: 'Family', audienceType: 'everyone' });
  const p = env.client();
  await p.login('parent@test.com');
  await p.postMultipart('/photos/upload', { profileId: profile.id }, { buffer: await plainJpeg() });
  const [photo] = await env.store.listPhotos();
  assert.equal(photo.audienceType, 'parents');
  assert.equal((await env.store.listGovernanceRequests({ status: 'pending' })).length, 1);
});

// --- JSON answers for the bulk uploader (Accept: application/json) ---

const JSON_ACCEPT = { headers: { accept: 'application/json' } };
const parse = (res) => JSON.parse(res.body);

test('json: a guardian upload answers 201 with the new photo and its link', async (t) => {
  const { env, parent } = await setup(t);
  const res = await parent.postMultipart('/photos/upload', {}, { buffer: await plainJpeg() }, JSON_ACCEPT);
  assert.equal(res.status, 201);
  const body = parse(res);
  const [photo] = await env.store.listPhotos();
  assert.deepEqual(body.photo, { id: photo.id, pending: false, url: `/photos/${photo.id}` });
  assert.equal(body.sharing, 'private');
  // No flash is queued for a page the uploader never loads.
  assert.doesNotMatch((await parent.get('/home')).body, /Photo uploaded\./);
});

test('json: a family member upload is pending and gets no link to it', async (t) => {
  const { member } = await setup(t);
  const res = await member.postMultipart('/photos/upload', {}, { buffer: await plainJpeg() }, JSON_ACCEPT);
  assert.equal(res.status, 201);
  const body = parse(res);
  assert.equal(body.photo.pending, true);
  assert.equal(body.photo.url, null);
  assert.equal(body.sharing, 'awaiting_approval');
});

test('json: rejected files come back with a code and a plain message, and create nothing', async (t) => {
  const { env, parent } = await setup(t);
  let res = await parent.postMultipart('/photos/upload', {}, { buffer: Buffer.from('not an image') }, JSON_ACCEPT);
  assert.equal(res.status, 422);
  assert.equal(parse(res).error.code, 'unreadable');
  assert.match(parse(res).error.message, /could not be read/);

  const gif = await sharp({ create: { width: 10, height: 10, channels: 3, background: '#f00' } }).gif().toBuffer();
  res = await parent.postMultipart('/photos/upload', {}, { buffer: gif }, JSON_ACCEPT);
  assert.equal(parse(res).error.code, 'unsupported_type');

  res = await parent.postMultipart('/photos/upload', {}, null, JSON_ACCEPT);
  assert.equal(res.status, 400);
  assert.equal(parse(res).error.code, 'no_file');

  const saved = config.uploads.maxBytes;
  config.uploads.maxBytes = 1000;
  t.after(() => {
    config.uploads.maxBytes = saved;
  });
  res = await parent.postMultipart('/photos/upload', {}, { buffer: await plainJpeg({ width: 1600, height: 1200 }) }, JSON_ACCEPT);
  assert.equal(res.status, 413);
  assert.equal(parse(res).error.code, 'too_large');
  assert.equal((await env.store.listPhotos()).length, 0);
});

test('json: a bad CSRF token is still refused, with the "expired" code', async (t) => {
  const { env, parent } = await setup(t);
  const res = await parent.postMultipart(
    '/photos/upload',
    { _csrf: 'forged' },
    { buffer: await plainJpeg() },
    { csrf: false, ...JSON_ACCEPT }
  );
  assert.equal(res.status, 403);
  assert.equal(parse(res).error.code, 'expired');
  assert.equal((await env.store.listPhotos()).length, 0);
});

test('json: a signed-out upload is refused with the "signed_out" code', async (t) => {
  const env = await startApp();
  t.after(env.close);
  const anon = env.client();
  const res = await anon.postMultipart('/photos/upload', {}, { buffer: await plainJpeg() }, { csrf: false, ...JSON_ACCEPT });
  assert.equal(res.status, 401);
  assert.equal(parse(res).error.code, 'signed_out');
  assert.equal((await env.store.listPhotos()).length, 0);
});

test('json: the hourly upload limit still applies and answers "rate_limited"', async (t) => {
  const { env, parent } = await setup(t);
  const { UPLOADS_PER_HOUR } = require('../src/security/rateLimiters');
  await parent.refreshToken();
  const token = parent.token;
  let last;
  // Empty posts count against the limit too; no image needed to reach it.
  for (let i = 0; i <= UPLOADS_PER_HOUR; i += 1) {
    last = await parent.postMultipart('/photos/upload', { _csrf: token }, null, { csrf: false, ...JSON_ACCEPT });
  }
  assert.equal(last.status, 429);
  assert.equal(parse(last).error.code, 'rate_limited');
  assert.equal((await env.store.listPhotos()).length, 0);
});

test('without JSON, uploads still flash and redirect (no-JavaScript form)', async (t) => {
  const { parent } = await setup(t);
  const res = await parent.postMultipart('/photos/upload', {}, { buffer: Buffer.from('nope') });
  assert.equal(res.status, 302);
  const page = await parent.get('/home');
  assert.match(page.body, /could not be read as a photo/);
});

test('home renders the uploader with its limits for both roles', async (t) => {
  const { parent, member } = await setup(t);
  for (const [client, role] of [
    [parent, 'parent'],
    [member, 'member'],
  ]) {
    const body = (await client.get('/home')).body;
    assert.match(body, new RegExp(`data-uploader-role="${role}"`));
    assert.match(body, /data-max-bytes="\d+"/);
    assert.match(body, /data-per-hour="120"/);
    assert.match(body, /up to\s+15 MB each/);
    assert.match(body, /aria-live="polite" data-upload-live/);
  }
});
