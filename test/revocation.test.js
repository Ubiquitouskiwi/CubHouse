'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { startApp, seedFamily, addPhoto } = require('./helpers');

async function setup(t, opts) {
  const env = await startApp();
  t.after(env.close);
  const people = await seedFamily(env, opts);
  return { env, ...people };
}

test('remove and revoke: the member is signed out on their very next request', async (t) => {
  const { env, member } = await setup(t);
  const photo = await addPhoto(env, { audienceType: 'everyone' });
  const fam = env.client();
  await fam.login(member.email);
  assert.equal((await fam.get(`/photos/${photo.id}`)).status, 200);

  const p = env.client();
  await p.login('parent@test.com');
  const res = await p.post(`/admin/members/${member.id}/remove`);
  assert.equal(res.location, '/admin');

  // Existing session is dead, image bytes refused, and they cannot sign back in.
  const after = await fam.get(`/photos/${photo.id}`);
  assert.equal(after.status, 302);
  assert.equal(after.location, '/login');
  assert.equal((await fam.get(`/media/${photo.id}/thumb`)).status, 302);
  const again = env.client();
  assert.equal((await again.login(member.email)).status, 401);

  const stored = await env.store.findUserById(member.id);
  assert.equal(stored.disabled, true);
  assert.deepEqual(stored.groupIds, []);
  assert.ok((await env.store.listSecurityAuditEvents()).some((e) => e.type === 'member.removed'));
});

test('removing a guardian also revokes the invite codes they created (once approved)', async (t) => {
  // Guardian removal is governed, so the removed guardian's agreement is the approval here.
  const { env, parent2 } = await setup(t, { twoGuardians: true });
  await env.store.createAccessCode({ code: 'INVITE-AAAA-BBBB-CCCC', createdBy: parent2.id });
  const p = env.client();
  await p.login('parent@test.com');
  await p.post(`/admin/members/${parent2.id}/remove`);
  const [request] = await env.store.listGovernanceRequests({ status: 'pending' });
  const p2 = env.client();
  await p2.login(parent2.email);
  await p2.post(`/admin/governance/${request.id}/approve`);
  const code = await env.store.findAccessCode('INVITE-AAAA-BBBB-CCCC');
  assert.ok(code.revokedAt);
  assert.equal((await env.store.findUserById(parent2.id)).disabled, true);
});

test('one guardian cannot remove the other alone; the other is told and can decline', async (t) => {
  const { env, parent2 } = await setup(t, { twoGuardians: true });
  const a = env.client();
  await a.login('parent@test.com');
  await a.post(`/admin/members/${parent2.id}/remove`);
  assert.equal((await env.store.findUserById(parent2.id)).disabled, false, 'guardian removed without approval');
  const [request] = await env.store.listGovernanceRequests({ status: 'pending' });
  assert.equal(request.type, 'user.remove');
  assert.ok(env.notifier.sent.some((m) => m.to === parent2.email && /approval/.test(m.subject)));
  // The requester cannot approve their own removal request.
  await a.post(`/admin/governance/${request.id}/approve`);
  assert.equal((await env.store.findUserById(parent2.id)).disabled, false);
  const b = env.client();
  await b.login(parent2.email);
  await b.post(`/admin/governance/${request.id}/decline`);
  assert.equal((await env.store.findGovernanceRequest(request.id)).status, 'declined');
  assert.equal((await env.store.findUserById(parent2.id)).disabled, false);
});

test('a removed guardian is notified at their own address', async (t) => {
  const { env, parent, parent2 } = await setup(t, { twoGuardians: true });
  const removed = await env.services.actions.removeMember(parent2.id, { removedBy: parent.id });
  assert.equal(removed.ok, true);
  assert.ok(env.notifier.sent.some((m) => m.to === parent2.email && /guardian access was removed/.test(m.subject)));
});

test('regression: removing the co-guardian does not unlock self-approval of an archive erase', async (t) => {
  const { env, parent2 } = await setup(t, { twoGuardians: true });
  await addPhoto(env);
  const a = env.client();
  await a.login('parent@test.com');
  await a.post('/admin/archive/erase', { confirm: 'ERASE' });
  const erase = (await env.store.listGovernanceRequests({ status: 'pending' })).find((r) => r.type === 'archive.erase');
  await a.post(`/admin/members/${parent2.id}/remove`);
  assert.equal((await env.store.findUserById(parent2.id)).disabled, false);
  // Even if the other guardian were gone (disabled out of band), A still cannot approve A's request.
  await env.store.updateUser(parent2.id, { disabled: true });
  const outcome = await env.services.governance.approve({ session: { userId: (await env.store.findUserByEmail('parent@test.com')).id } }, erase.id);
  assert.equal(outcome.ok, false);
  await a.post(`/admin/governance/${erase.id}/approve`);
  assert.equal((await env.store.listPhotos()).length, 1, 'archive erased by a self-approved request');
});

test('the last guardian cannot be removed', async (t) => {
  const { env, parent } = await setup(t);
  const other = await env.store.createUser({ email: 'p2@test.com', passwordHash: parent.passwordHash, role: 'parent' });
  await env.store.updateUser(other.id, { disabled: true });
  const p = env.client();
  await p.login('parent@test.com');
  // Cannot remove yourself, and no other active guardian remains.
  await p.post(`/admin/members/${parent.id}/remove`);
  assert.equal((await env.store.findUserById(parent.id)).disabled, false);
});

test('a role change takes effect on the next request (role is not trusted from the session)', async (t) => {
  const { env, parent2 } = await setup(t, { twoGuardians: true });
  const p2 = env.client();
  await p2.login(parent2.email);
  assert.equal((await p2.get('/photos/downloads')).status, 200);
  await env.store.updateUser(parent2.id, { role: 'user' });
  const res = await p2.get('/photos/downloads');
  assert.equal(res.status, 302);
  assert.equal(res.location, '/home');
});

test('sign out everywhere ends every session of the account', async (t) => {
  const { env, member } = await setup(t);
  const a = env.client();
  const b = env.client();
  await a.login(member.email);
  await b.login(member.email);
  await a.post('/settings/security/signout-all');
  assert.equal((await a.get('/home')).location, '/login');
  assert.equal((await b.get('/home')).location, '/login');
});

test('a password change signs out other devices but keeps this one', async (t) => {
  const { env, member } = await setup(t);
  const here = env.client();
  const there = env.client();
  await here.login(member.email);
  await there.login(member.email);
  const res = await here.post('/settings/password', {
    currentPassword: 'correct horse battery staple',
    newPassword: 'a brand new long passphrase',
    confirmPassword: 'a brand new long passphrase',
  });
  assert.equal(res.location, '/settings');
  assert.equal((await here.get('/home')).status, 200);
  assert.equal((await there.get('/home')).location, '/login');
});

test('sessions expire at the absolute lifetime even while active', async (t) => {
  const { env, member } = await setup(t);
  const c = env.client();
  await c.login(member.email);
  const saved = config.session.absoluteLifetimeMs;
  config.session.absoluteLifetimeMs = 1;
  t.after(() => {
    config.session.absoluteLifetimeMs = saved;
  });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await c.get('/home')).location, '/login');
});

test('step-up: a stale authentication must be confirmed before a destructive action', async (t) => {
  const { env } = await setup(t);
  const photo = await addPhoto(env);
  const p = env.client();
  await p.login('parent@test.com');
  const saved = config.parentAuth.stepUpTtlMs;
  config.parentAuth.stepUpTtlMs = 1;
  t.after(() => {
    config.parentAuth.stepUpTtlMs = saved;
  });
  await new Promise((r) => setTimeout(r, 5));
  const refused = await p.post(`/photos/${photo.id}/delete`);
  assert.equal(refused.location, '/reauth');
  assert.ok(await env.store.findPhotoById(photo.id), 'photo deleted without step-up');

  config.parentAuth.stepUpTtlMs = saved;
  const wrong = await p.post('/reauth', { password: 'not my password at all' });
  assert.equal(wrong.status, 401);
  const ok = await p.post('/reauth', { password: 'correct horse battery staple' });
  assert.equal(ok.status, 302);
  const done = await p.post(`/photos/${photo.id}/delete`);
  assert.equal(done.location, '/photos');
  assert.equal(await env.store.findPhotoById(photo.id), null);
});
