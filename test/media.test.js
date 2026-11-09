'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { makeStore } = require('./storeFactory');
const { createMediaService } = require('../src/media');
const { createLocalStorage } = require('../src/media/storage');
const { buildZip } = require('../src/services/zip');
const config = require('../src/config');
const { startApp, seedFamily, addPhoto, memoryMediaStorage } = require('./helpers');
const { plainJpeg } = require('./fixtures/makeImages');

const KEY_A = crypto.randomBytes(32).toString('base64');
const KEY_B = crypto.randomBytes(32).toString('base64');

function service(store, storage, encryptionKey) {
  return createMediaService({ store, storage, config: { ...config, encryptionKey } });
}

test('envelope encryption: stored objects are ciphertext; the data key is stored only wrapped', async () => {
  const store = await makeStore();
  const storage = memoryMediaStorage();
  const media = service(store, storage, KEY_A);
  const src = await plainJpeg();
  const ingested = await media.ingest(src);
  for (const bytes of storage.objects.values()) {
    assert.notEqual(bytes.subarray(0, 3).toString('hex'), 'ffd8ff');
  }
  const wrapped = await store.getSetting('media.dataKey.v1');
  assert.ok(wrapped && Buffer.from(wrapped, 'base64').length > 32);
  const photo = { mediaId: ingested.mediaId };
  const full = await media.read(photo, 'full');
  assert.equal(full.subarray(0, 3).toString('hex'), 'ffd8ff');
});

test('bucket contents plus the database are useless without the key-encryption key', async () => {
  const store = await makeStore();
  const storage = memoryMediaStorage();
  const ingested = await service(store, storage, KEY_A).ingest(await plainJpeg());
  const attacker = service(store, storage, KEY_B);
  await assert.rejects(attacker.read({ mediaId: ingested.mediaId }, 'full'));
});

test('production never creates a fresh media key when photos already exist', async () => {
  const store = await makeStore();
  const storage = memoryMediaStorage();
  const prod = { ...config, isProduction: true, encryptionKey: KEY_A };
  // First boot on an empty archive may create the key.
  const first = createMediaService({ store, storage, config: prod });
  const ingested = await first.ingest(await plainJpeg());
  await store.createPhoto({ caption: 'x', ...ingested });
  // Simulate a restore that lost the settings row: a new key must be refused.
  const restored = await makeStore();
  await restored.createPhoto({ caption: 'x', ...ingested });
  const second = createMediaService({ store: restored, storage, config: prod });
  await assert.rejects(second.read({ mediaId: ingested.mediaId }, 'full'), /Refusing to create a new key/);
  assert.equal(await restored.getSetting('media.dataKey.v1'), null);
});

test('the in-memory store never writes media to disk (key and bytes vanish together)', async () => {
  const store = await makeStore();
  if (store.kind !== 'memory') {
    return;
  }
  const media = createMediaService({ store, config: { ...config, media: { ...config.media, backend: 'local' } } });
  assert.equal(media.backendKind, 'memory');
});

test('PgStore implements every method of the MemoryStore interface', () => {
  const { MemoryStore } = require('../src/store/memoryStore');
  const { PgStore } = require('../src/store/pgStore');
  const methods = (C) => Object.getOwnPropertyNames(C.prototype).filter((n) => n !== 'constructor');
  const missing = methods(MemoryStore).filter((m) => typeof PgStore.prototype[m] !== 'function');
  assert.deepEqual(missing, []);
});

test('ciphertext is bound to its object key (no swapping between photos)', async () => {
  const store = await makeStore();
  const storage = memoryMediaStorage();
  const media = service(store, storage, KEY_A);
  const a = await media.ingest(await plainJpeg({ color: '#ff0000' }));
  const b = await media.ingest(await plainJpeg({ color: '#0000ff' }));
  storage.objects.set(`photos/${a.mediaId}/full`, storage.objects.get(`photos/${b.mediaId}/full`));
  await assert.rejects(media.read({ mediaId: a.mediaId }, 'full'));
});

test('local storage rejects keys that are not random photo ids (no path traversal)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photos-media-'));
  try {
    const local = createLocalStorage({ dir });
    await assert.rejects(local.put('../../etc/passwd', Buffer.from('x')), /invalid media object key/);
    await assert.rejects(local.get('photos/../../secret/full'), /invalid media object key/);
    const key = `photos/${crypto.randomUUID()}/thumb`;
    await local.put(key, Buffer.from('sealed'));
    assert.equal(fs.statSync(path.join(dir, key)).mode & 0o777, 0o600);
    await local.remove(key);
    assert.equal(await local.get(key), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the zip writer produces a valid archive', () => {
  const zip = buildZip([{ name: 'a.txt', data: 'hello' }, { name: 'b/c.json', data: '{}' }]);
  assert.ok(zip.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])));
  assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
  assert.equal(zip.readUInt16LE(zip.length - 12), 2);
});

test('archive export contains every photo as a clean JPEG plus an index, and is audited', async (t) => {
  const env = await startApp();
  t.after(env.close);
  await seedFamily(env, { twoGuardians: true });
  await addPhoto(env, { caption: 'Day one' });
  await addPhoto(env, { caption: 'Day two' });
  const p = env.client();
  await p.login('parent@test.com');
  const res = await p.post('/admin/archive/export');
  assert.equal(res.headers['content-type'], 'application/zip');
  const text = res.buffer.toString('latin1');
  assert.match(text, /index\.json/);
  assert.match(text, /Day one/);
  assert.equal((text.match(/\xff\xd8\xff/g) || []).length >= 2, true);
  const events = await env.store.listSecurityAuditEvents();
  assert.ok(events.some((e) => e.type === 'archive.exported'));
  assert.ok(env.notifier.sent.some((m) => m.to === 'parent2@test.com' && /exported/.test(m.subject)));
  // Members cannot export the archive.
  const m = env.client();
  await m.login('member@test.com');
  assert.equal((await m.post('/admin/archive/export')).location, '/home');
});
