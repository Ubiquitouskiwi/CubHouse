'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { REACTION_EMOJIS } = require('../src/permissions');
const { startApp, seedFamily, seedUser, addPhoto } = require('./helpers');

async function setup(t) {
  const env = await startApp();
  t.after(env.close);
  const people = await seedFamily(env);
  await seedUser(env.store, { email: 'cousin@test.com', displayName: 'Cousin' });
  const photo = await addPhoto(env, { audienceType: 'everyone' });
  const member = env.client();
  await member.login('member@test.com');
  const cousin = env.client();
  await cousin.login('cousin@test.com');
  const parent = env.client();
  await parent.login('parent@test.com');
  return { ...people, env, photo, member, cousin, parent };
}

test('a member posts a comment with a role badge, and the author can remove it', async (t) => {
  const { env, photo, member } = await setup(t);
  await member.post(`/photos/${photo.id}/comments`, { body: 'Look at that smile' });
  const [c] = await env.store.listCommentsByPhoto(photo.id);
  assert.equal(c.authorRole, 'user');
  const page = await member.get(`/photos/${photo.id}`);
  assert.match(page.body, /badge-role">Family</);
  await member.post(`/photos/${photo.id}/comments/${c.id}/delete`);
  assert.ok((await env.store.findCommentById(c.id)).deletedAt);
  assert.doesNotMatch((await member.get(`/photos/${photo.id}`)).body, /Look at that smile/);
});

test('removed comments stay visible to guardians as a record', async (t) => {
  const { env, photo, member, parent } = await setup(t);
  await member.post(`/photos/${photo.id}/comments`, { body: 'Something unkind' });
  const [c] = await env.store.listCommentsByPhoto(photo.id);
  await member.post(`/photos/${photo.id}/comments/${c.id}/delete`);
  const page = await parent.get(`/photos/${photo.id}`);
  assert.match(page.body, /Something unkind/);
  assert.match(page.body, /Removed \(visible to parents only\)/);
});

test('a member cannot remove another member comment, but a parent can', async (t) => {
  const { env, photo, member, cousin, parent } = await setup(t);
  await member.post(`/photos/${photo.id}/comments`, { body: 'Mine' });
  const [c] = await env.store.listCommentsByPhoto(photo.id);
  await cousin.post(`/photos/${photo.id}/comments/${c.id}/delete`);
  assert.equal((await env.store.findCommentById(c.id)).deletedAt, null);
  await parent.post(`/photos/${photo.id}/comments/${c.id}/delete`);
  assert.ok((await env.store.findCommentById(c.id)).deletedAt);
});

test('reporting a comment notifies the guardians and lands in Admin', async (t) => {
  const { env, photo, member, cousin, parent } = await setup(t);
  await member.post(`/photos/${photo.id}/comments`, { body: 'Where is their school again?' });
  const [c] = await env.store.listCommentsByPhoto(photo.id);
  await cousin.post(`/photos/${photo.id}/comments/${c.id}/report`, { reason: 'Asking for location' });
  assert.equal((await env.store.listReports()).length, 1);
  assert.ok(env.notifier.sent.some((m) => /comment was reported/.test(m.subject)));
  const admin = await parent.get('/admin');
  assert.match(admin.body, /Where is their school again/);
  const [report] = await env.store.listReports();
  await parent.post(`/admin/reports/${report.id}/resolve`, { removeComment: 'on' });
  assert.ok((await env.store.findCommentById(c.id)).deletedAt);
  assert.equal((await env.store.listReports()).length, 0);
});

test('a muted member can no longer comment or react', async (t) => {
  const { env, photo, member, parent } = await setup(t);
  const m = await env.store.findUserByEmail('member@test.com');
  await parent.post(`/admin/members/${m.id}/mute`, { muted: 'on' });
  await member.post(`/photos/${photo.id}/comments`, { body: 'hi' });
  await member.post(`/photos/${photo.id}/react`, { emoji: REACTION_EMOJIS[0] });
  assert.equal((await env.store.listCommentsByPhoto(photo.id)).length, 0);
  assert.equal((await env.store.listReactionsByPhoto(photo.id)).length, 0);
});

test('comments and reactions are refused when a parent turned them off', async (t) => {
  const { env, photo, member } = await setup(t);
  await env.store.updatePhoto(photo.id, { commentsEnabled: false, reactionsEnabled: false });
  await member.post(`/photos/${photo.id}/comments`, { body: 'hi' });
  await member.post(`/photos/${photo.id}/react`, { emoji: REACTION_EMOJIS[0] });
  assert.equal((await env.store.listCommentsByPhoto(photo.id)).length, 0);
  assert.equal((await env.store.listReactionsByPhoto(photo.id)).length, 0);
});

test('reactions toggle, and an off-palette emoji is rejected', async (t) => {
  const { env, photo, member } = await setup(t);
  await member.post(`/photos/${photo.id}/react`, { emoji: REACTION_EMOJIS[1] });
  await member.post(`/photos/${photo.id}/react`, { emoji: 'x' });
  const rows = await env.store.listReactionsByPhoto(photo.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].emoji, REACTION_EMOJIS[1]);
});

test('comment rate limit stops a flood', async (t) => {
  const { photo, member } = await setup(t);
  let last;
  for (let i = 0; i < 32; i += 1) {
    last = await member.post(`/photos/${photo.id}/comments`, { body: `msg ${i}` });
  }
  assert.equal(last.status, 429);
});

test('comment HTML is escaped (no stored XSS)', async (t) => {
  const { photo, member } = await setup(t);
  await member.post(`/photos/${photo.id}/comments`, { body: '<img src=x onerror=alert(1)>' });
  const page = await member.get(`/photos/${photo.id}`);
  assert.doesNotMatch(page.body, /<img src=x onerror/);
  assert.match(page.body, /&lt;img src=x onerror=alert\(1\)&gt;/);
});
