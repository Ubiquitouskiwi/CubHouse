'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const totp = require('../src/security/totp');
const { startApp, seedFamily, PASSWORD } = require('./helpers');

test('TOTP matches the RFC 6238 SHA-1 test vector', () => {
  // RFC 6238 Appendix B secret "12345678901234567890" at T=59s -> 94287082 (8 digits; we use 6).
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totp.generate(secret, 59 * 1000), '287082');
  assert.ok(totp.verify(secret, '287082', { timeMs: 59 * 1000 }) >= 0);
  assert.equal(totp.verify(secret, '000000', { timeMs: 59 * 1000 }), -1);
  assert.equal(totp.verify(secret, 'abc', { timeMs: 59 * 1000 }), -1);
});

async function enroll(c) {
  const page = await c.get('/settings/security');
  const secret = /class="setup-key"><code>([A-Z2-7 ]+)<\/code>/.exec(page.body)[1].replace(/ /g, '');
  const res = await c.post('/settings/security/mfa/enable', { code: totp.generate(secret) });
  assert.equal(res.location, '/settings/security');
  return secret;
}

test('enrolling MFA, then signing in requires a valid, non-replayed code', async (t) => {
  const env = await startApp();
  t.after(env.close);
  const { member } = await seedFamily(env);
  const c = env.client();
  await c.login(member.email);
  const secret = await enroll(c);
  const stored = await env.store.findUserById(member.id);
  assert.equal(stored.mfaEnabled, true);
  // Secret is encrypted at rest, never stored in the clear.
  assert.ok(!String(stored.mfaSecretSealed).includes(secret));

  const d = env.client();
  const step1 = await d.post('/login', { email: member.email, password: PASSWORD });
  assert.equal(step1.location, '/login/mfa');
  assert.equal((await d.get('/home')).location, '/login', 'password alone gave access');
  const bad = await d.post('/login/mfa', { code: '000000' });
  assert.equal(bad.status, 401);

  // The code used at enrollment cannot be replayed within the same step.
  const replay = await d.post('/login/mfa', { code: totp.generate(secret) });
  assert.equal(replay.status, 401);
  const next = await d.post('/login/mfa', { code: totp.generate(secret, Date.now() + 30 * 1000) });
  assert.equal(next.location, '/home');
  assert.equal((await d.get('/home')).status, 200);
});

test('when MFA is required, a guardian without it is sent to enroll', async (t) => {
  const env = await startApp();
  t.after(env.close);
  await seedFamily(env);
  const saved = config.parentAuth.requireMfa;
  config.parentAuth.requireMfa = true;
  t.after(() => {
    config.parentAuth.requireMfa = saved;
  });
  const p = env.client();
  await p.login('parent@test.com');
  const res = await p.get('/admin');
  assert.equal(res.location, '/settings/security');
  await enroll(p);
  assert.equal((await p.get('/admin')).status, 200);
  // And cannot be turned off while required.
  await p.post('/settings/security/mfa/disable', { password: PASSWORD, code: '123456' });
  assert.equal((await env.store.findUserByEmail('parent@test.com')).mfaEnabled, true);
});
