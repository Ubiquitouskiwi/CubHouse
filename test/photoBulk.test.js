'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, seedFamily, addPhoto } = require('./helpers');

async function setup(t, opts) {
  const env = await startApp();
  t.after(env.close);
  await seedFamily(env, opts);
  const parent = env.client();
  await parent.login('parent@test.com');
  const photos = [];
  for (let i = 0; i < 3; i += 1) {
    photos.push(await addPhoto(env, { caption: `P${i}`, audienceType: 'everyone' }));
  }
  return { env, parent, photos, ids: photos.map((p) => p.id) };
}

test('bulkUpdatePhotos applies one change to many photos and skips unknown ids', async (t) => {
  const { env, ids } = await setup(t);
  assert.equal(await env.store.bulkUpdatePhotos([...ids, 'nope'], { hidden: true }), 3);
  assert.equal(await env.store.bulkUpdatePhotos([], { hidden: true }), 0);
  for (const id of ids) {
    assert.equal((await env.store.findPhotoById(id)).hidden, true);
  }
});

test('restricting bulk actions (hide, lock, watermark on) apply immediately', async (t) => {
  const { env, parent, ids } = await setup(t, { twoGuardians: true });
  await parent.post('/photos/bulk', { action: 'hide', photoIds: ids });
  await parent.post('/photos/bulk', { action: 'lock-download', photoIds: ids });
  await parent.post('/photos/bulk', { action: 'watermark-on', photoIds: ids });
  for (const id of ids) {
    const p = await env.store.findPhotoById(id);
    assert.equal(p.hidden, true);
    assert.equal(p.downloadable, false);
    assert.equal(p.watermark, true);
  }
  assert.equal((await env.store.listGovernanceRequests()).length, 0);
});

test('widening bulk actions (allow download) wait for the other guardian', async (t) => {
  const { env, parent, ids } = await setup(t, { twoGuardians: true });
  await parent.post('/photos/bulk', { action: 'allow-download', photoIds: ids });
  for (const id of ids) {
    assert.equal((await env.store.findPhotoById(id)).downloadable, false);
  }
  const [req] = await env.store.listGovernanceRequests({ status: 'pending' });
  assert.equal(req.payload.changes.watermark, true, 'download enabled without the watermark default');
});

test('with a single guardian in development, allowing download applies with the watermark on', async (t) => {
  const { env, parent, ids } = await setup(t);
  await parent.post('/photos/bulk', { action: 'allow-download', photoIds: ids });
  for (const id of ids) {
    const p = await env.store.findPhotoById(id);
    assert.equal(p.downloadable, true);
    assert.equal(p.watermark, true);
  }
});

test('bulk delete removes exactly the selected photos and their media', async (t) => {
  const { env, parent, ids } = await setup(t);
  await parent.post('/photos/bulk', { action: 'delete', photoIds: [ids[0], ids[1]] });
  assert.equal(await env.store.findPhotoById(ids[0]), null);
  assert.equal(await env.store.findPhotoById(ids[1]), null);
  assert.ok(await env.store.findPhotoById(ids[2]));
  assert.equal(env.mediaStorage.objects.size, 3);
});

test('a single selected id (string, not array) still works', async (t) => {
  const { env, parent, ids } = await setup(t);
  await parent.post('/photos/bulk', { action: 'hide', photoIds: ids[0] });
  assert.equal((await env.store.findPhotoById(ids[0])).hidden, true);
});

test('a non-parent cannot run bulk actions', async (t) => {
  const { env, ids } = await setup(t);
  const member = env.client();
  await member.login('member@test.com');
  await member.post('/photos/bulk', { action: 'delete', photoIds: ids });
  assert.equal((await env.store.listPhotos()).length, 3);
});

test('an unknown action or empty selection changes nothing', async (t) => {
  const { env, parent, ids } = await setup(t);
  await parent.post('/photos/bulk', { action: 'explode', photoIds: ids });
  await parent.post('/photos/bulk', { action: 'hide' });
  for (const id of ids) {
    assert.equal((await env.store.findPhotoById(id)).hidden, false);
  }
});

test('bulk move-to-profile copies the profile permissions onto the selection', async (t) => {
  const { env, parent, ids } = await setup(t);
  const group = await env.store.createGroup({ name: 'Cousins' });
  const profile = await env.store.createUploadProfile({ name: 'Cousins only', audienceType: 'groups', audienceGroupIds: [group.id] });
  await parent.post('/photos/bulk', { action: 'move-to-profile', profileId: profile.id, photoIds: ids });
  for (const id of ids) {
    const p = await env.store.findPhotoById(id);
    assert.equal(p.profileId, profile.id);
    assert.equal(p.audienceType, 'groups');
    assert.deepEqual(p.audienceGroupIds, [group.id]);
  }
});
