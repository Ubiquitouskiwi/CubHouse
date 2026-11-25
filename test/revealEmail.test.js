'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, seedFamily, seedUser } = require('./helpers');

const INVITEE = 'grandpa@test.com';
const JSON_HEADERS = { accept: 'application/json' };

async function setup(t) {
  const env = await startApp();
  t.after(env.close);
  await seedFamily(env, { twoGuardians: true });
  const a = env.client();
  await a.login('parent@test.com');
  await a.post('/admin/access-codes', { note: 'for Grandpa', intendedEmail: INVITEE });
  const [request] = await env.store.listGovernanceRequests({ status: 'pending' });
  return { env, a, request };
}

const reveal = (client, fields, opts = {}) =>
  client.post('/admin/reveal-email', fields, { headers: JSON_HEADERS, ...opts });

test('admin list: invitee email is masked and never in the HTML, each row has a named Show button', async (t) => {
  const { a, request } = await setup(t);
  const page = await a.get('/admin');
  assert.equal(page.status, 200);
  assert.ok(!page.body.includes(INVITEE), 'full email leaked into the admin page');
  assert.ok(page.body.includes('g\u2022\u2022\u2022@test.com'));
  assert.ok(page.body.includes(`data-kind="request" data-id="${request.id}"`));
  assert.match(page.body, /data-email-show aria-label="Show full email address, currently g/);
  assert.match(page.body, /role="status" aria-live="polite" data-email-status/);
});

test('reveal: returns only that one email, no-store, and writes an audit entry without the address', async (t) => {
  const { env, a, request } = await setup(t);
  const res = await reveal(a, { kind: 'request', id: request.id });
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { ok: true, email: INVITEE });
  assert.match(res.headers['cache-control'], /no-store/);
  const events = (await env.store.listSecurityAuditEvents()).filter((e) => e.type === 'email.revealed');
  assert.equal(events.length, 1);
  assert.equal(events[0].targetType, 'governanceRequest');
  assert.equal(events[0].targetId, request.id);
  assert.ok(events[0].actorId);
  assert.ok(!JSON.stringify(events[0]).includes(INVITEE), 'audit entry holds the address');
});

test('reveal: an invite code row works, and the audit target is a fingerprint, not the code', async (t) => {
  const { env, a } = await setup(t);
  const b = env.client();
  await b.login('parent2@test.com');
  await b.post(`/admin/governance/${(await env.store.listGovernanceRequests({ status: 'pending' }))[0].id}/approve`);
  const [code] = await env.store.listAccessCodes();
  const page = await a.get('/admin');
  assert.ok(!page.body.includes(INVITEE));
  const res = await reveal(a, { kind: 'code', id: code.code });
  assert.equal(JSON.parse(res.body).email, INVITEE);
  const [event] = (await env.store.listSecurityAuditEvents()).filter((e) => e.type === 'email.revealed');
  assert.equal(event.targetType, 'accessCode');
  assert.ok(!JSON.stringify(event).includes(code.code));
});

test('reveal: needs a signed-in guardian and a CSRF token', async (t) => {
  const { env, a, request } = await setup(t);
  const anon = env.client();
  assert.notEqual((await reveal(anon, { kind: 'request', id: request.id }, { csrf: false })).status, 200);
  const noCsrf = await reveal(a, { kind: 'request', id: request.id, _csrf: 'wrong' }, { csrf: true });
  assert.equal(noCsrf.status, 403);
  const member = env.client();
  await member.login('member@test.com');
  assert.ok([302, 403].includes((await reveal(member, { kind: 'request', id: request.id })).status));
  const dev = await seedUser(env.store, { email: 'dev@test.com', role: 'dev', displayName: 'Dev' });
  assert.ok(dev);
  const devClient = env.client();
  await devClient.login('dev@test.com');
  const devRes = await reveal(devClient, { kind: 'request', id: request.id });
  assert.notEqual(devRes.status, 200);
  assert.ok(!devRes.body.includes(INVITEE));
  const events = (await env.store.listSecurityAuditEvents()).filter((e) => e.type === 'email.revealed');
  assert.equal(events.length, 0);
});

test('reveal: unknown ids, other request types and resolved requests give nothing', async (t) => {
  const { a, request } = await setup(t);
  assert.equal((await reveal(a, { kind: 'request', id: 'nope' })).status, 404);
  assert.equal((await reveal(a, { kind: 'code', id: 'nope' })).status, 404);
  assert.equal((await reveal(a, { kind: 'other', id: request.id })).status, 404);
  await a.post(`/admin/governance/${request.id}/decline`);
  const res = await reveal(a, { kind: 'request', id: request.id });
  assert.equal(res.status, 404);
  assert.ok(!res.body.includes(INVITEE));
});

test('reveal: rate limited per guardian', async (t) => {
  const { a, request } = await setup(t);
  let last;
  for (let i = 0; i < 31; i += 1) {
    last = await reveal(a, { kind: 'request', id: request.id });
  }
  assert.equal(last.status, 429);
  assert.ok(!last.body.includes(INVITEE));
});

test('client script: re-masks after 15 seconds, on another row, on hide, and is shipped as a file (no inline script)', () => {
  const js = fs.readFileSync(path.join(__dirname, '../public/page-behaviors.js'), 'utf8');
  assert.match(js, /REVEAL_MS = 15000/);
  assert.match(js, /pagehide/);
  assert.match(js, /visibilitychange/);
  assert.match(js, /remask\(revealed, ''\)/);
  const partial = fs.readFileSync(path.join(__dirname, '../src/views/partials/masked-email.ejs'), 'utf8');
  assert.ok(!/<script/i.test(partial));
  assert.ok(!/\son\w+=/i.test(partial));
});
