'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { startApp, seedFamily, addPhoto } = require('./helpers');
const { verifyChain } = require('../src/audit');
const { runRetention } = require('../src/jobs/retention');
const { isWideningPhotoChange, photoExposure } = require('../src/permissions');

async function twoGuardians(t) {
  const env = await startApp();
  t.after(env.close);
  const people = await seedFamily(env, { twoGuardians: true });
  const a = env.client();
  const b = env.client();
  await a.login('parent@test.com');
  await b.login('parent2@test.com');
  return { env, a, b, ...people };
}

test('widening rule: whole-family visibility or new downloads widen; restrictions never do', () => {
  const priv = { audienceType: 'parents' };
  const fam = { audienceType: 'everyone' };
  assert.equal(photoExposure(priv), 'none');
  assert.equal(photoExposure(fam), 'family');
  assert.equal(photoExposure({ ...fam, hidden: true }), 'none');
  assert.equal(isWideningPhotoChange(priv, fam), true);
  assert.equal(isWideningPhotoChange({ ...fam, hidden: true }, fam), true);
  assert.equal(isWideningPhotoChange(fam, { ...fam, downloadable: true }), true);
  assert.equal(isWideningPhotoChange(fam, priv), false);
  assert.equal(isWideningPhotoChange(fam, { ...fam, hidden: true }), false);
  assert.equal(isWideningPhotoChange({ ...fam, downloadable: true }, fam), false);
  // Downloadable but visible to nobody is not a widening.
  assert.equal(isWideningPhotoChange(priv, { ...priv, downloadable: true }), false);
});

test('widening rule: listing every member or adding groups counts like "everyone"', () => {
  const members = [
    { id: 'm1', groupIds: ['g1'] },
    { id: 'm2', groupIds: ['g1'] },
    { id: 'm3', groupIds: ['g2'] },
    { id: 'm4', groupIds: ['g3'] },
  ];
  const priv = { audienceType: 'parents' };
  const allByName = { audienceType: 'users', audienceUserIds: ['m1', 'm2', 'm3', 'm4'] };
  assert.equal(isWideningPhotoChange(priv, allByName, members), true);
  // More than half the family, newly reached, is broad too.
  const three = { audienceType: 'users', audienceUserIds: ['m1', 'm2', 'm3'] };
  assert.equal(isWideningPhotoChange(priv, three, members), true);
  // Growing a group share to cover most of the family is widening.
  const g1 = { audienceType: 'groups', audienceGroupIds: ['g1'] };
  const g123 = { audienceType: 'groups', audienceGroupIds: ['g1', 'g2', 'g3'] };
  assert.equal(isWideningPhotoChange(g1, g123, members), true);
  // A small circle (half or fewer) is still one guardian's call.
  assert.equal(isWideningPhotoChange(priv, g1, members), false);
  assert.equal(isWideningPhotoChange(priv, { audienceType: 'users', audienceUserIds: ['m4'] }, members), false);
  // Narrowing, or re-spelling the same audience, is never widening.
  assert.equal(isWideningPhotoChange(allByName, g1, members), false);
  assert.equal(isWideningPhotoChange(allByName, { audienceType: 'groups', audienceGroupIds: ['g1', 'g2', 'g3'] }, members), false);
  // New download on a small circle still widens.
  assert.equal(isWideningPhotoChange(g1, { ...g1, downloadable: true }, members), true);
});

test('with two guardians, sharing with every member by name waits for the OTHER guardian', async (t) => {
  const { env, a, b, member } = await twoGuardians(t);
  const photo = await addPhoto(env);
  await a.post(`/photos/${photo.id}/permissions`, {
    audienceType: 'users',
    audienceUserIds: [member.id],
    commentsEnabled: 'on',
    reactionsEnabled: 'on',
  });
  assert.equal((await env.store.findPhotoById(photo.id)).audienceType, 'parents', 'widened by listing every member');
  const [request] = await env.store.listGovernanceRequests({ status: 'pending' });
  assert.equal(request.type, 'photos.update');
  await b.post(`/admin/governance/${request.id}/approve`);
  assert.deepEqual((await env.store.findPhotoById(photo.id)).audienceUserIds, [member.id]);
});

test('with two guardians, sharing with the whole family waits for the OTHER guardian', async (t) => {
  const { env, a, b } = await twoGuardians(t);
  const photo = await addPhoto(env);
  await a.post(`/photos/${photo.id}/permissions`, { audienceType: 'everyone', commentsEnabled: 'on', reactionsEnabled: 'on' });
  assert.equal((await env.store.findPhotoById(photo.id)).audienceType, 'parents', 'widened without approval');

  const [request] = await env.store.listGovernanceRequests({ status: 'pending' });
  assert.equal(request.type, 'photos.update');
  // The requester cannot approve their own request.
  await a.post(`/admin/governance/${request.id}/approve`);
  assert.equal((await env.store.findPhotoById(photo.id)).audienceType, 'parents');
  // The other guardian was notified, then approves.
  assert.ok(env.notifier.sent.some((m) => m.to === 'parent2@test.com' && /approval/.test(m.subject)));
  await b.post(`/admin/governance/${request.id}/approve`);
  const after = await env.store.findPhotoById(photo.id);
  assert.equal(after.audienceType, 'everyone');
  assert.ok(after.publishedBy);
});

test('restricting is immediate for any one guardian', async (t) => {
  const { env, a } = await twoGuardians(t);
  const photo = await addPhoto(env, { audienceType: 'everyone', downloadable: true });
  await a.post(`/photos/${photo.id}/toggle-download`);
  await a.post(`/photos/${photo.id}/toggle-hidden`);
  const after = await env.store.findPhotoById(photo.id);
  assert.equal(after.downloadable, false);
  assert.equal(after.hidden, true);
  assert.equal((await env.store.listGovernanceRequests()).length, 0);
});

test('a declined request changes nothing', async (t) => {
  const { env, a, b } = await twoGuardians(t);
  const photo = await addPhoto(env, { audienceType: 'everyone' });
  await a.post(`/photos/${photo.id}/toggle-download`);
  const [request] = await env.store.listGovernanceRequests({ status: 'pending' });
  await b.post(`/admin/governance/${request.id}/decline`);
  assert.equal((await env.store.findPhotoById(photo.id)).downloadable, false);
  assert.equal((await env.store.findGovernanceRequest(request.id)).status, 'declined');
});

test('bulk delete and archive erase both need the other guardian', async (t) => {
  const { env, a, b } = await twoGuardians(t);
  const p1 = await addPhoto(env);
  const p2 = await addPhoto(env);
  await a.post('/photos/bulk', { action: 'delete', photoIds: [p1.id, p2.id] });
  assert.equal((await env.store.listPhotos()).length, 2);
  await a.post('/admin/archive/erase', { confirm: 'ERASE' });
  const pending = await env.store.listGovernanceRequests({ status: 'pending' });
  assert.deepEqual(pending.map((r) => r.type).sort(), ['archive.erase', 'photos.delete']);
  const erase = pending.find((r) => r.type === 'archive.erase');
  await b.post(`/admin/governance/${erase.id}/approve`);
  assert.equal((await env.store.listPhotos()).length, 0);
  assert.equal(env.mediaStorage.objects.size, 0, 'media objects survived archive erase');
});

test('inviting a member and adding someone to a group are governed', async (t) => {
  const { env, a, b, member } = await twoGuardians(t);
  await a.post('/admin/access-codes', { note: 'for Grandpa', intendedEmail: 'grandpa@test.com' });
  assert.equal((await env.store.listAccessCodes()).length, 0);
  const group = await env.store.createGroup({ name: 'Grandparents' });
  await a.post(`/admin/groups/${group.id}/members`, { userId: member.id, action: 'add' });
  assert.deepEqual((await env.store.findUserById(member.id)).groupIds, []);
  for (const r of await env.store.listGovernanceRequests({ status: 'pending' })) {
    await b.post(`/admin/governance/${r.id}/approve`);
  }
  const [code] = await env.store.listAccessCodes();
  assert.equal(code.intendedEmail, 'grandpa@test.com');
  assert.ok(code.expiresAt);
  assert.deepEqual((await env.store.findUserById(member.id)).groupIds, [group.id]);
});

test('a single guardian: protected changes wait out the safety delay, then run', async (t) => {
  const env = await startApp();
  t.after(env.close);
  await seedFamily(env);
  const saved = config.governance.soloDelayMs;
  config.governance.soloDelayMs = 60 * 60 * 1000;
  t.after(() => {
    config.governance.soloDelayMs = saved;
  });
  const photo = await addPhoto(env);
  const p = env.client();
  await p.login('parent@test.com');
  await p.post(`/photos/${photo.id}/permissions`, { audienceType: 'everyone' });
  assert.equal((await env.store.findPhotoById(photo.id)).audienceType, 'parents');
  const [request] = await env.store.listGovernanceRequests({ status: 'pending' });
  assert.ok(request.executeAfter);
  // Not yet due.
  assert.equal(await env.services.governance.runDue(Date.now()), 0);
  // Due.
  assert.equal(await env.services.governance.runDue(Date.now() + 2 * 60 * 60 * 1000), 1);
  assert.equal((await env.store.findPhotoById(photo.id)).audienceType, 'everyone');
});

test('audit trail is hash-chained and detects tampering', async (t) => {
  const { env, a } = await twoGuardians(t);
  await a.post('/admin/groups', { name: 'Cousins' });
  const events = await env.store.listSecurityAuditEvents();
  assert.ok(events.length >= 3);
  assert.equal(verifyChain(events).ok, true);
  const tampered = events.map((e) => ({ ...e }));
  tampered[1].type = 'auth.logout';
  assert.equal(verifyChain(tampered).ok, false);
  const removed = events.filter((_, i) => i !== 1);
  assert.equal(verifyChain(removed).ok, false);
  const page = await a.get('/admin/audit');
  assert.match(page.body, /Integrity check passed/);
});

test('retention: old downloads purged, old audit details redacted, chain still verifies', async (t) => {
  const { env } = await twoGuardians(t);
  await env.store.recordDownload({ token: 'tok-old', userId: 'u', photoId: 'p' });
  const future = Date.now() + 400 * 24 * 60 * 60 * 1000;
  const result = await runRetention({ store: env.store, config, now: future });
  assert.equal(result.downloadsPurged, 1);
  assert.ok(result.auditRedacted >= 1);
  const events = await env.store.listSecurityAuditEvents();
  assert.ok(events.every((e) => e.details === null));
  assert.equal(verifyChain(events).ok, true);
});

test('retention: two instances (a deploy swap) send the daily download digest once', async (t) => {
  const { env } = await twoGuardians(t);
  await env.store.recordDownload({ token: 'tok-new', userId: 'u', photoId: 'p' });
  const before = env.notifier.sent.filter((m) => /download summary/.test(m.subject)).length;
  const now = Date.now();
  const deps = { store: env.store, config, notifier: env.notifier, now };
  // Both instances tick at the same moment against the shared store.
  const [first, second] = await Promise.all([runRetention(deps), runRetention(deps)]);
  assert.equal([first, second].filter((r) => r.digestSent).length, 1);
  // A restart later the same day does not send another.
  assert.equal((await runRetention({ ...deps, now: now + 60 * 1000 })).digestSent, false);
  const sent = env.notifier.sent.filter((m) => /download summary/.test(m.subject)).length - before;
  // Two guardians get one copy each from the single run, never two runs' worth.
  assert.equal(sent, 2);
});
