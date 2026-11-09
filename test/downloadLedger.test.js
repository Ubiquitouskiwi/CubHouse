'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const sharp = require('sharp');
const { startApp, seedFamily, addPhoto } = require('./helpers');
const { readTraceToken } = require('../src/phototrace');
const { truncateIp } = require('../src/security/clientInfo');

async function setup(t) {
  const env = await startApp();
  t.after(env.close);
  await seedFamily(env);
  const member = env.client();
  await member.login('member@test.com');
  const parent = env.client();
  await parent.login('parent@test.com');
  return { env, member, parent };
}

test('a download is recorded, minimized: no email, no caption, truncated network, opaque token', async (t) => {
  const { env, member } = await setup(t);
  const photo = await addPhoto(env, { caption: 'Bath time', audienceType: 'everyone', downloadable: true });
  const res = await member.get(`/photos/${photo.id}/download`);
  assert.equal(res.status, 200);
  assert.match(res.headers['content-disposition'], new RegExp(`^attachment; filename="${config.app.slug}-[a-z0-9_-]{8}\\.jpg"$`));
  const [row] = await env.store.listDownloads();
  assert.equal(row.photoId, photo.id);
  assert.equal(row.userDisplayName, 'Grandma');
  assert.equal(row.userEmail, undefined);
  assert.equal(row.photoCaption, undefined);
  assert.equal(row.userAgent, null);
  assert.equal(row.ipNet, '127.0.0.0/24');
  assert.match(row.token, /^[A-Za-z0-9_-]{16}$/);
  // The file carries exactly that token, and none of the downloader's details.
  assert.equal(await readTraceToken(res.buffer), row.token);
  const text = res.buffer.toString('latin1');
  assert.ok(!text.includes('Grandma') && !text.includes('member@test.com') && !text.includes('Bath time'));
});

test('member downloads are visibly watermarked by default; parent downloads are not', async (t) => {
  const { env, member, parent } = await setup(t);
  const photo = await addPhoto(env, { audienceType: 'everyone', downloadable: true, watermark: true });
  await member.get(`/photos/${photo.id}/download`);
  await parent.get(`/photos/${photo.id}/download`);
  const rows = await env.store.listDownloads();
  const byName = Object.fromEntries(rows.map((r) => [r.userDisplayName, r]));
  assert.equal(byName.Grandma.watermarked, true);
  assert.equal(byName.Pat.watermarked, false);
});

test('a locked download records no ledger row', async (t) => {
  const { env, member } = await setup(t);
  const photo = await addPhoto(env, { audienceType: 'everyone', downloadable: false });
  await member.get(`/photos/${photo.id}/download`);
  assert.equal((await env.store.listDownloads()).length, 0);
});

test('a forged X-Forwarded-For header does not reach the ledger', async (t) => {
  const { env, member } = await setup(t);
  const photo = await addPhoto(env, { audienceType: 'everyone', downloadable: true });
  await member.get(`/photos/${photo.id}/download`, { 'x-forwarded-for': '6.6.6.6' });
  const [row] = await env.store.listDownloads();
  assert.equal(row.ipNet, '127.0.0.0/24');
});

test('IP truncation keeps only the network prefix', () => {
  assert.equal(truncateIp('203.0.113.77'), '203.0.113.0/24');
  assert.equal(truncateIp('::ffff:198.51.100.9'), '198.51.100.0/24');
  assert.equal(truncateIp('2001:db8:abcd:12::1'), '2001:db8:abcd::/48');
  assert.equal(truncateIp(null), null);
});

test('the download history and trace tool are parent-only', async (t) => {
  const { member } = await setup(t);
  assert.equal((await member.get('/photos/downloads')).location, '/home');
});

test('trace lookup: a recovered file resolves to the downloader, screenshot-stripped files do not', async (t) => {
  const { env, member, parent } = await setup(t);
  const photo = await addPhoto(env, { audienceType: 'everyone', downloadable: true });
  const dl = await member.get(`/photos/${photo.id}/download`);
  const found = await parent.postMultipart('/photos/trace', {}, { buffer: dl.buffer });
  assert.match(found.body, /downloaded by <strong>Grandma<\/strong>/);

  const stripped = await sharp(dl.buffer).jpeg().toBuffer();
  const notFound = await parent.postMultipart('/photos/trace', {}, { buffer: stripped });
  assert.match(notFound.body, /No reference was found/);
});
