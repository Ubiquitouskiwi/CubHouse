'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeStore } = require('./storeFactory');
const { isValidReactionEmoji, REACTION_EMOJIS, canComment, canReact, canDeleteComment, profilePermissions } = require('../src/permissions');

test('comments are listed oldest-first and soft-deleted (kept for guardians)', async () => {
  const store = await makeStore();
  const a = await store.createComment({ photoId: 'p', userId: 'u', body: 'first', authorRole: 'user' });
  await store.createComment({ photoId: 'p', userId: 'u', body: 'second' });
  const list = await store.listCommentsByPhoto('p');
  assert.deepEqual(list.map((c) => c.body), ['first', 'second']);
  await store.softDeleteComment(a.id, 'parent-id');
  const after = await store.findCommentById(a.id);
  assert.ok(after.deletedAt);
  assert.equal(after.deletedBy, 'parent-id');
  assert.equal(after.body, 'first', 'evidence was destroyed');
  assert.equal(await store.softDeleteComment(a.id, 'x'), null, 'deleted twice');
});

test('deleting a photo removes its comments, reactions, and reports', async () => {
  const store = await makeStore();
  const photo = await store.createPhoto({ caption: 'x' });
  const c = await store.createComment({ photoId: photo.id, userId: 'u', body: 'hi' });
  await store.toggleReaction({ photoId: photo.id, userId: 'u', emoji: REACTION_EMOJIS[0] });
  await store.createReport({ photoId: photo.id, commentId: c.id });
  await store.deletePhoto(photo.id);
  assert.equal((await store.listCommentsByPhoto(photo.id)).length, 0);
  assert.equal((await store.listReactionsByPhoto(photo.id)).length, 0);
  assert.equal((await store.listReports()).length, 0);
});

test('toggleReaction turns a reaction on then off; summary marks only the viewer', async () => {
  const store = await makeStore();
  const e = REACTION_EMOJIS[0];
  assert.equal((await store.toggleReaction({ photoId: 'p', userId: 'u', emoji: e })).on, true);
  await store.toggleReaction({ photoId: 'p', userId: 'v', emoji: e });
  const s = await store.reactionSummary('p', 'u');
  assert.equal(s.counts[e], 2);
  assert.deepEqual(s.mine, [e]);
  assert.equal((await store.toggleReaction({ photoId: 'p', userId: 'u', emoji: e })).on, false);
});

test('only palette emojis are accepted', () => {
  assert.equal(isValidReactionEmoji(REACTION_EMOJIS[0]), true);
  assert.equal(isValidReactionEmoji('<script>'), false);
});

test('canComment/canReact need view access and the enabled flag; author or parent may remove', () => {
  const viewer = { role: 'user', id: 'u' };
  const photo = { audienceType: 'everyone' };
  assert.equal(canComment(viewer, photo), true);
  assert.equal(canComment(viewer, { ...photo, commentsEnabled: false }), false);
  assert.equal(canReact(viewer, { audienceType: 'parents' }), false);
  assert.equal(canDeleteComment(viewer, { userId: 'u' }), true);
  assert.equal(canDeleteComment(viewer, { userId: 'x' }), false);
  assert.equal(canDeleteComment({ role: 'parent', id: 'p' }, { userId: 'x' }), true);
});

test('upload profiles default to parents-only and copy cleanly onto photos', async () => {
  const store = await makeStore();
  const profile = await store.createUploadProfile({ name: 'Default' });
  assert.equal(profile.audienceType, 'parents');
  const perms = profilePermissions({ ...profile, audienceGroupIds: ['g'] });
  assert.deepEqual(Object.keys(perms).sort(), [
    'audienceGroupIds',
    'audienceType',
    'audienceUserIds',
    'commentsEnabled',
    'downloadable',
    'reactionsEnabled',
    'watermark',
  ]);
  const photo = await store.createPhoto({ caption: 'x', ...perms, profileId: profile.id });
  await store.deleteUploadProfile(profile.id);
  const after = await store.findPhotoById(photo.id);
  assert.equal(after.profileId, null);
  assert.deepEqual(after.audienceGroupIds, ['g']);
});

test('deleteUser anonymizes or deletes content, and drops personal albums', async () => {
  const store = await makeStore();
  const u = await store.createUser({ email: 'u@test.com', passwordHash: 'h' });
  await store.createComment({ photoId: 'p', userId: u.id, body: 'keep me' });
  await store.createAlbum({ ownerId: u.id, name: 'Mine' });
  await store.deleteUser(u.id, { contentMode: 'delete' });
  assert.equal((await store.listCommentsByPhoto('p')).length, 0);
  assert.equal((await store.listAlbumsByOwner(u.id)).length, 0);
  assert.equal(await store.findUserByEmail('u@test.com'), null);
});
