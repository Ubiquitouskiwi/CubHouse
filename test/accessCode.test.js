'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { makeStore } = require('./storeFactory');
const { generateAccessCode } = require('../src/auth');
const { startApp, seedFamily } = require('./helpers');

const PW = 'a long enough passphrase';

test('generated codes are 12 random symbols from an unambiguous alphabet', () => {
  const seen = new Set();
  for (let i = 0; i < 200; i += 1) {
    const code = generateAccessCode();
    assert.match(code, /^INVITE-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
    seen.add(code);
  }
  assert.equal(seen.size, 200);
});

test('claimAccessCode is single-use and rejects expired, revoked, and wrong-email codes', async () => {
  const store = await makeStore();
  const future = new Date(Date.now() + 60000).toISOString();
  await store.createAccessCode({ code: 'OPEN', expiresAt: future });
  await store.createAccessCode({ code: 'OLD', expiresAt: new Date(Date.now() - 1000).toISOString() });
  await store.createAccessCode({ code: 'GONE', expiresAt: future });
  await store.revokeAccessCode('GONE', 'p');
  await store.createAccessCode({ code: 'BOUND', expiresAt: future, intendedEmail: 'Grandma@Test.com' });

  assert.ok(await store.claimAccessCode('OPEN', { email: 'a@test.com' }));
  assert.equal(await store.claimAccessCode('OPEN', { email: 'b@test.com' }), null, 'claimed twice');
  assert.equal(await store.claimAccessCode('OLD', { email: 'a@test.com' }), null);
  assert.equal(await store.claimAccessCode('GONE', { email: 'a@test.com' }), null);
  assert.equal(await store.claimAccessCode('BOUND', { email: 'someone@test.com' }), null);
  assert.ok(await store.claimAccessCode('BOUND', { email: 'grandma@test.com' }));
  assert.equal(await store.claimAccessCode('NOPE', {}), null);
});

test('a released claim can be claimed again; a consumed code cannot', async () => {
  const store = await makeStore();
  await store.createAccessCode({ code: 'C1' });
  await store.claimAccessCode('C1');
  await store.releaseAccessCode('C1');
  assert.ok(await store.claimAccessCode('C1'));
  await store.consumeAccessCode('C1', 'user-1');
  await store.releaseAccessCode('C1');
  assert.equal(await store.claimAccessCode('C1'), null);
});

async function register(client, fields) {
  return client.post('/register', {
    email: 'new@test.com',
    displayName: 'Cousin Lee',
    password: PW,
    confirm: PW,
    acknowledgePrivacy: 'on',
    ...fields,
  });
}

test('parallel registrations with one code create exactly one account', async (t) => {
  const env = await startApp();
  t.after(env.close);
  await seedFamily(env);
  await env.store.createAccessCode({ code: 'INVITE-RACE-RACE-RACE' });
  const clients = Array.from({ length: 5 }, () => env.client());
  await Promise.all(clients.map((c) => c.refreshToken()));
  await Promise.all(
    clients.map((c, i) =>
      register(c, { email: `racer${i}@test.com`, accessCode: 'INVITE-RACE-RACE-RACE', _csrf: c.token })
    )
  );
  const racers = (await env.store.listUsers()).filter((u) => u.email.startsWith('racer'));
  assert.equal(racers.length, 1);
});

test('registration requires the privacy acknowledgment and a policy-compliant password', async (t) => {
  const env = await startApp();
  t.after(env.close);
  await seedFamily(env);
  await env.store.createAccessCode({ code: 'INVITE-AAAA-AAAA-AAAA' });
  const c = env.client();
  const noAck = await register(c, { accessCode: 'INVITE-AAAA-AAAA-AAAA', acknowledgePrivacy: undefined });
  assert.equal(noAck.status, 400);
  const short = await register(c, { accessCode: 'INVITE-AAAA-AAAA-AAAA', password: 'short', confirm: 'short' });
  assert.equal(short.status, 400);
  assert.match(short.body, /at least 12/);
  // The code was not burned by those failures.
  assert.equal((await env.store.findAccessCode('INVITE-AAAA-AAAA-AAAA')).usedBy, null);
});

test('bad, used, and expired codes all return the same generic message', async (t) => {
  const env = await startApp();
  t.after(env.close);
  await seedFamily(env);
  await env.store.createAccessCode({ code: 'INVITE-USED-USED-USED' });
  await env.store.consumeAccessCode('INVITE-USED-USED-USED', 'someone');
  await env.store.createAccessCode({ code: 'INVITE-EXPD-EXPD-EXPD', expiresAt: new Date(Date.now() - 1).toISOString() });
  const c = env.client();
  const bodies = [];
  for (const code of ['INVITE-NOPE-NOPE-NOPE', 'INVITE-USED-USED-USED', 'INVITE-EXPD-EXPD-EXPD']) {
    const res = await register(c, { accessCode: code });
    bodies.push(/alert-error[^>]*>\s*<p>([^<]+)/.exec(res.body)[1]);
  }
  assert.equal(new Set(bodies).size, 1);
});

test('a successful registration regenerates the session, joins the group, and notifies guardians', async (t) => {
  const env = await startApp();
  t.after(env.close);
  await seedFamily(env);
  const group = await env.store.createGroup({ name: 'Cousins' });
  await env.store.createAccessCode({ code: 'INVITE-JOIN-JOIN-JOIN', groupId: group.id, note: 'for Lee' });
  const c = env.client();
  await c.get('/register');
  const before = c.cookies.get(config.session.name);
  const res = await register(c, { accessCode: 'INVITE-JOIN-JOIN-JOIN' });
  assert.equal(res.location, '/home');
  assert.notEqual(c.cookies.get(config.session.name), before, 'session not regenerated on register');
  const user = await env.store.findUserByEmail('new@test.com');
  assert.deepEqual(user.groupIds, [group.id]);
  assert.ok(user.privacyAcceptedAt);
  assert.ok(env.notifier.sent.some((m) => /invite code was used/.test(m.subject)));
});

test('a guardian can revoke an unused code', async (t) => {
  const env = await startApp();
  t.after(env.close);
  await seedFamily(env);
  await env.store.createAccessCode({ code: 'INVITE-REVK-REVK-REVK' });
  const p = env.client();
  await p.login('parent@test.com');
  await p.post('/admin/access-codes/INVITE-REVK-REVK-REVK/revoke');
  const c = env.client();
  const res = await register(c, { accessCode: 'INVITE-REVK-REVK-REVK' });
  assert.equal(res.status, 400);
});

test('a single guardian creates codes immediately (dev delay is zero), with expiry', async (t) => {
  const env = await startApp();
  t.after(env.close);
  await seedFamily(env);
  const p = env.client();
  await p.login('parent@test.com');
  await p.post('/admin/access-codes', { note: 'Grandpa' });
  const [code] = await env.store.listAccessCodes();
  assert.ok(code);
  assert.ok(Date.parse(code.expiresAt) > Date.now());
});
