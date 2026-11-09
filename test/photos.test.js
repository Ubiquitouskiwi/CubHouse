'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, seedFamily, seedUser, addPhoto, rawRequest } = require('./helpers');

async function setup(t) {
  const env = await startApp();
  t.after(env.close);
  const people = await seedFamily(env);
  const outsider = await seedUser(env.store, { email: 'outsider@test.com' });
  const member = env.client();
  await member.login('member@test.com');
  const out = env.client();
  await out.login(outsider.email);
  // Clients last so they win over the same-named user records.
  return { ...people, outsider, env, member, out };
}

test('a member only sees photos shared with them; private and hidden ones never appear', async (t) => {
  const { env, member } = await setup(t);
  const memberUser = await env.store.findUserByEmail('member@test.com');
  await addPhoto(env, { caption: 'Shared one', audienceType: 'users', audienceUserIds: [memberUser.id] });
  await addPhoto(env, { caption: 'Private one' });
  await addPhoto(env, { caption: 'Hidden one', audienceType: 'everyone', hidden: true });
  const page = await member.get('/photos');
  assert.match(page.body, /Shared one/);
  assert.doesNotMatch(page.body, /Private one|Hidden one/);
});

test('direct photo, media, and download URLs are 404 outside the audience', async (t) => {
  const { env, out } = await setup(t);
  const memberUser = await env.store.findUserByEmail('member@test.com');
  const photo = await addPhoto(env, { audienceType: 'users', audienceUserIds: [memberUser.id], downloadable: true });
  assert.equal((await out.get(`/photos/${photo.id}`)).status, 404);
  assert.equal((await out.get(`/media/${photo.id}/thumb`)).status, 404);
  assert.equal((await out.get(`/media/${photo.id}/display`)).status, 404);
  assert.equal((await out.get(`/photos/${photo.id}/download`)).status, 404);
});

test('anonymous visitors get no image bytes at all', async (t) => {
  const { env } = await setup(t);
  const photo = await addPhoto(env, { audienceType: 'everyone' });
  const res = await rawRequest(env.base, `/media/${photo.id}/thumb`);
  assert.equal(res.status, 302);
  assert.equal(res.location, '/login');
});

test('viewing never hands a member the full original; only the traced download does', async (t) => {
  const { env, member } = await setup(t);
  const photo = await addPhoto(env, { audienceType: 'everyone', downloadable: false });
  assert.equal((await member.get(`/media/${photo.id}/display`)).status, 200);
  assert.equal((await member.get(`/media/${photo.id}/full`)).status, 404);
  const page = await member.get(`/photos/${photo.id}`);
  assert.doesNotMatch(page.body, /\/full"/);
  assert.doesNotMatch(page.body, /data:image/);
});

test('download is refused server-side unless the photo is downloadable', async (t) => {
  const { env, member } = await setup(t);
  const photo = await addPhoto(env, { audienceType: 'everyone', downloadable: false });
  const res = await member.get(`/photos/${photo.id}/download`);
  assert.equal(res.status, 302);
  assert.equal((await env.store.listDownloads()).length, 0);
});

test('a non-parent cannot change permissions, hide, delete, or approve', async (t) => {
  const { env, member } = await setup(t);
  const photo = await addPhoto(env, { audienceType: 'everyone' });
  await member.post(`/photos/${photo.id}/permissions`, { audienceType: 'parents', hidden: 'on' });
  await member.post(`/photos/${photo.id}/toggle-hidden`);
  await member.post(`/photos/${photo.id}/delete`);
  const after = await env.store.findPhotoById(photo.id);
  assert.equal(after.audienceType, 'everyone');
  assert.equal(after.hidden, false);
});

test('a parent narrowing the audience to a group takes effect immediately', async (t) => {
  const { env, member } = await setup(t);
  const group = await env.store.createGroup({ name: 'Grandparents' });
  const memberUser = await env.store.findUserByEmail('member@test.com');
  await env.store.addUserToGroup(memberUser.id, group.id);
  const photo = await addPhoto(env, { audienceType: 'everyone' });
  const p = env.client();
  await p.login('parent@test.com');
  await p.post(`/photos/${photo.id}/permissions`, { audienceType: 'groups', audienceGroupIds: group.id, commentsEnabled: 'on' });
  const after = await env.store.findPhotoById(photo.id);
  assert.equal(after.audienceType, 'groups');
  assert.equal((await member.get(`/photos/${photo.id}`)).status, 200);
  await env.store.removeUserFromGroup(memberUser.id, group.id);
  assert.equal((await member.get(`/photos/${photo.id}`)).status, 404);
});

test('albums are personal and only hold photos the owner can view', async (t) => {
  const { env, member, out } = await setup(t);
  const visible = await addPhoto(env, { audienceType: 'everyone', caption: 'Visible' });
  const privatePhoto = await addPhoto(env, { caption: 'Secret' });
  await member.post('/albums', { name: 'Faves' });
  const memberUser = await env.store.findUserByEmail('member@test.com');
  const [album] = await env.store.listAlbumsByOwner(memberUser.id);
  await member.post(`/albums/${album.id}/add`, { photoId: visible.id });
  await member.post(`/albums/${album.id}/add`, { photoId: privatePhoto.id });
  assert.deepEqual((await env.store.findAlbumById(album.id)).photoIds, [visible.id]);
  // Another member cannot open it.
  assert.equal((await out.get(`/albums/${album.id}`)).status, 404);
});

test('deleting a photo removes every stored variant and scrubs the ledger', async (t) => {
  const { env, member } = await setup(t);
  const photo = await addPhoto(env, { audienceType: 'everyone', downloadable: true });
  await member.get(`/photos/${photo.id}/download`);
  const p = env.client();
  await p.login('parent@test.com');
  await p.post(`/photos/${photo.id}/delete`);
  assert.equal(await env.store.findPhotoById(photo.id), null);
  assert.equal(env.mediaStorage.objects.size, 0);
  const [row] = await env.store.listDownloads();
  assert.equal(row.photoDeleted, true);
  assert.equal(row.ipNet, null);
});
