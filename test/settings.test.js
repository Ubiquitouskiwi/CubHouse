'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const { makeStore } = require('./storeFactory');
const { startApp, seedFamily, addPhoto, PASSWORD } = require('./helpers');
const { checkNewPassword } = require('../src/security/passwordPolicy');
const config = require('../src/config');

test('updateUser changes email without changing the account UUID', async () => {
  const store = await makeStore();
  const u = await store.createUser({ email: 'a@test.com', passwordHash: 'h' });
  const updated = await store.updateUser(u.id, { email: 'b@test.com' });
  assert.equal(updated.id, u.id);
  assert.equal(await store.findUserByEmail('a@test.com'), null);
});

test('updateUser rejects an email or username held by another account', async () => {
  const store = await makeStore();
  await store.createUser({ email: 'a@test.com', passwordHash: 'h', username: 'alpha' });
  const b = await store.createUser({ email: 'b@test.com', passwordHash: 'h' });
  await assert.rejects(store.updateUser(b.id, { email: 'A@test.com' }), { code: 'USER_EXISTS' });
  await assert.rejects(store.updateUser(b.id, { username: 'ALPHA' }), { code: 'USERNAME_EXISTS' });
});

test('password policy: length, 72-byte cap, not the email, breach check via k-anonymity', async () => {
  assert.equal((await checkNewPassword('short')).ok, false);
  assert.equal((await checkNewPassword('x'.repeat(80))).ok, false);
  assert.equal((await checkNewPassword('me@example.com', { email: 'ME@example.com' })).ok, false);
  assert.equal((await checkNewPassword('a perfectly fine passphrase')).ok, true);

  const saved = config.security.breachedPasswordCheck;
  config.security.breachedPasswordCheck = true;
  try {
    let requested = null;
    const fakeFetch = async (url) => {
      requested = url;
      // SHA-1('password1234') = E6B6AFBD6D76BB5D2041542D7D2E3FAC5BB05593
      return { ok: true, text: async () => 'FBD6D76BB5D2041542D7D2E3FAC5BB05593:42\r\nDEADBEEF:1' };
    };
    const breached = await checkNewPassword('password1234', { fetchImpl: fakeFetch });
    assert.equal(breached.ok, false);
    assert.match(requested, /\/range\/E6B6A$/, 'more than the 5-char prefix left the server');
    const outage = await checkNewPassword('password1234', { fetchImpl: async () => { throw new Error('down'); } });
    assert.equal(outage.ok, true, 'an API outage must not lock people out');
  } finally {
    config.security.breachedPasswordCheck = saved;
  }
});

async function setup(t) {
  const env = await startApp();
  t.after(env.close);
  const people = await seedFamily(env);
  const c = env.client();
  await c.login('member@test.com');
  return { ...people, env, c };
}

test('changing the sign-in email requires the current password and tells the old address', async (t) => {
  const { env, c, member } = await setup(t);
  await c.post('/settings/profile', { displayName: 'Grandma', email: 'new@test.com' });
  assert.equal((await env.store.findUserById(member.id)).email, 'member@test.com');
  await c.post('/settings/profile', { displayName: 'Grandma', email: 'new@test.com', currentPassword: PASSWORD });
  assert.equal((await env.store.findUserById(member.id)).email, 'new@test.com');
  assert.ok(env.notifier.sent.some((m) => m.to === 'member@test.com' && /email was changed/.test(m.subject)));
});

test('display names that impersonate a guardian are refused for members', async (t) => {
  const { env, c, member } = await setup(t);
  await c.post('/settings/profile', { displayName: 'Parents', email: 'member@test.com' });
  assert.equal((await env.store.findUserById(member.id)).displayName, 'Grandma');
});

test('password change requires the correct current password and the policy', async (t) => {
  const { env, c, member } = await setup(t);
  const before = (await env.store.findUserById(member.id)).passwordHash;
  await c.post('/settings/password', { currentPassword: 'wrong wrong wrong', newPassword: 'another long phrase', confirmPassword: 'another long phrase' });
  await c.post('/settings/password', { currentPassword: PASSWORD, newPassword: 'short', confirmPassword: 'short' });
  assert.equal((await env.store.findUserById(member.id)).passwordHash, before);
});

test('theme preference is stored and validated', async (t) => {
  const { env, c, member } = await setup(t);
  await c.post('/settings/theme', { theme: 'dark' });
  assert.equal((await env.store.findUserById(member.id)).theme, 'dark');
  await c.post('/settings/theme', { theme: 'neon' });
  assert.equal((await env.store.findUserById(member.id)).theme, 'system');
});

test('export my data returns a zip with my account and activity, and no other members', async (t) => {
  const { env, c, member } = await setup(t);
  const photo = await addPhoto(env, { audienceType: 'everyone' });
  await c.post(`/photos/${photo.id}/comments`, { body: 'So cute' });
  const res = await c.post('/settings/export');
  assert.equal(res.headers['content-type'], 'application/zip');
  // Stored (uncompressed) zip: the JSON is readable in place.
  const text = res.buffer.toString('utf8');
  assert.match(text, /"email": "member@test.com"/);
  assert.match(text, /So cute/);
  assert.doesNotMatch(text, /parent@test.com/);
  assert.ok(res.buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])));
  void zlib;
  void member;
});

test('delete my account: requires DELETE + password; anonymizes comments by default', async (t) => {
  const { env, c, member } = await setup(t);
  const photo = await addPhoto(env, { audienceType: 'everyone' });
  await c.post(`/photos/${photo.id}/comments`, { body: 'Hello' });
  await c.post('/settings/delete-account', { confirm: 'nope', password: PASSWORD });
  assert.ok(await env.store.findUserById(member.id));
  const res = await c.post('/settings/delete-account', { confirm: 'DELETE', password: PASSWORD });
  assert.equal(res.location, '/login');
  assert.equal(await env.store.findUserById(member.id), null);
  const [comment] = await env.store.listCommentsByPhoto(photo.id);
  assert.equal(comment.userDisplayName, 'Former member');
  assert.equal(comment.userId, null);
});

test('guardians cannot self-delete (the archive is never left ownerless)', async (t) => {
  const { env } = await setup(t);
  const p = env.client();
  await p.login('parent@test.com');
  await p.post('/settings/delete-account', { confirm: 'DELETE', password: PASSWORD });
  assert.ok(await env.store.findUserByEmail('parent@test.com'));
});
