'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const totp = require('../src/security/totp');
const {
  generateResetCode,
  generateRecoveryCodes,
  isResetCodeShape,
  isRecoveryCodeShape,
  hashSecret,
} = require('../src/security/recovery');
const { startApp, seedFamily, setupKeyFrom, PASSWORD } = require('./helpers');

const NEW_PW = 'a brand new long passphrase';

async function setup(t, opts) {
  const env = await startApp();
  t.after(env.close);
  const people = await seedFamily(env, opts);
  const p = env.client();
  await p.login('parent@test.com');
  return { env, p, ...people };
}

function codeFrom(flashHtml) {
  const m = /(RESET-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})/.exec(flashHtml);
  return m ? m[1] : null;
}

async function issue(env, p, userId) {
  await p.post(`/admin/members/${userId}/reset-signin`);
  return codeFrom((await p.get('/admin')).body);
}

function redeem(client, fields) {
  return client.post('/reset', { password: NEW_PW, confirm: NEW_PW, ...fields });
}

test('reset and recovery codes are random and well-formed', () => {
  const resets = new Set(Array.from({ length: 100 }, generateResetCode));
  assert.equal(resets.size, 100);
  assert.ok([...resets].every(isResetCodeShape));
  const recovery = generateRecoveryCodes();
  assert.equal(recovery.length, 10);
  assert.ok(recovery.every(isRecoveryCodeShape));
});

test('a guardian-issued reset code resets the password and 2FA once, ends sessions, and is audited', async (t) => {
  const { env, p, member } = await setup(t);
  await env.store.updateUser(member.id, { mfaEnabled: true, mfaSecretSealed: 'x', mfaRecoveryCodes: ['h'] });
  const old = env.client();
  await old.post('/login', { email: member.email, password: PASSWORD });

  const code = await issue(env, p, member.id);
  assert.ok(code, 'the code was not shown to the issuing guardian');
  assert.ok(env.notifier.sent.some((m) => m.to === member.email && /reset code was issued/.test(m.subject)));
  // The code is never written to the audit trail.
  assert.doesNotMatch(JSON.stringify(await env.store.listSecurityAuditEvents()), new RegExp(code));

  const c = env.client();
  const res = await redeem(c, { email: member.email, code: code.toLowerCase() });
  assert.equal(res.location, '/login');
  const after = await env.store.findUserById(member.id);
  assert.equal(after.mfaEnabled, false);
  assert.deepEqual(after.mfaRecoveryCodes, []);
  assert.ok(after.sessionVersion > member.sessionVersion);
  assert.equal((await c.login(member.email, NEW_PW)).location, '/home');

  // Single use.
  const again = await redeem(env.client(), { email: member.email, code });
  assert.equal(again.status, 400);
  const types = (await env.store.listSecurityAuditEvents()).map((e) => e.type);
  assert.ok(types.includes('account.reset_issued'));
  assert.ok(types.includes('account.reset_redeemed'));
  assert.ok(types.includes('account.reset_failed'));
});

test('a reset code fails for the wrong email, after expiry, or once replaced; errors are identical', async (t) => {
  const { env, p, member } = await setup(t);
  const other = await env.store.createUser({ email: 'other@test.com', passwordHash: member.passwordHash, displayName: 'Other' });
  const first = await issue(env, p, member.id);
  const wrongEmail = await redeem(env.client(), { email: other.email, code: first });
  const second = await issue(env, p, member.id);
  const replaced = await redeem(env.client(), { email: member.email, code: first });
  assert.equal(wrongEmail.status, 400);
  assert.equal(replaced.status, 400);
  const msg = (r) => /<div class="alert alert-error"[^>]*>([\s\S]*?)<\/div>/.exec(r.body)[1].trim();
  assert.equal(msg(wrongEmail), msg(replaced));

  const saved = config.security.resetCodeTtlMs;
  config.security.resetCodeTtlMs = 1;
  t.after(() => {
    config.security.resetCodeTtlMs = saved;
  });
  const expiring = await issue(env, p, member.id);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal((await redeem(env.client(), { email: member.email, code: expiring })).status, 400);
  assert.ok(second);
});

test('a family member cannot issue reset codes', async (t) => {
  const { env, member, parent } = await setup(t);
  const m = env.client();
  await m.login(member.email);
  await m.post(`/admin/members/${parent.id}/reset-signin`);
  const types = (await env.store.listSecurityAuditEvents()).map((e) => e.type);
  assert.equal(types.includes('account.reset_issued'), false);
  assert.equal(env.notifier.sent.some((x) => /reset code was issued/.test(x.subject)), false);
});

test('the delay alone does not block a guardian reset forever', async (t) => {
  const { env, p, parent2 } = await setup(t, { twoGuardians: true });
  const saved = config.security.guardianResetDelayMs;
  config.security.guardianResetDelayMs = 60 * 60 * 1000;
  t.after(() => {
    config.security.guardianResetDelayMs = saved;
  });
  const code = await issue(env, p, parent2.id);
  const due = await env.store.consumeResetCode(hashSecret(code), { userId: parent2.id, now: Date.now() + 2 * 60 * 60 * 1000 });
  assert.ok(due, 'a delayed guardian reset never became usable');
});

test('a guardian reset is delayed, emailed to that guardian, and cancellable by them', async (t) => {
  const { env, p, parent2 } = await setup(t, { twoGuardians: true });
  const saved = config.security.guardianResetDelayMs;
  config.security.guardianResetDelayMs = 60 * 60 * 1000;
  t.after(() => {
    config.security.guardianResetDelayMs = saved;
  });
  const code = await issue(env, p, parent2.id);
  assert.ok(code);
  assert.ok(env.notifier.sent.some((m) => m.to === parent2.email && /starts working in 1 hours/.test(m.text)));
  // Not usable yet.
  assert.equal((await redeem(env.client(), { email: parent2.email, code })).status, 400);
  // The real guardian cancels it.
  const b = env.client();
  await b.login(parent2.email);
  await b.post('/settings/security/cancel-reset');
  // Even once its delay would have passed, the cancelled code is dead.
  const late = await env.store.consumeResetCode(hashSecret(code), { userId: parent2.id, now: Date.now() + 2 * 60 * 60 * 1000 });
  assert.equal(late, null);
});

test('recovery codes: shown once at enrollment, each works once in place of an app code', async (t) => {
  const { env, member } = await setup(t);
  const c = env.client();
  await c.login(member.email);
  const page = await c.get('/settings/security');
  const secret = setupKeyFrom(page.body);
  await c.post('/settings/security/mfa/enable', { code: totp.generate(secret) });
  const shown = await c.get('/settings/security');
  const codes = [...shown.body.matchAll(/<li><code>([A-Z2-9]{5}-[A-Z2-9]{5})<\/code><\/li>/g)].map((m) => m[1]);
  assert.equal(codes.length, 10);
  assert.doesNotMatch((await c.get('/settings/security')).body, new RegExp(codes[0]), 'codes shown twice');
  const stored = await env.store.findUserById(member.id);
  assert.ok(!stored.mfaRecoveryCodes.includes(codes[0]), 'stored in the clear');

  const d = env.client();
  await d.post('/login', { email: member.email, password: PASSWORD });
  assert.equal((await d.post('/login/mfa', { code: codes[0].toLowerCase() })).location, '/home');
  const e = env.client();
  await e.post('/login', { email: member.email, password: PASSWORD });
  assert.equal((await e.post('/login/mfa', { code: codes[0] })).status, 401, 'recovery code reused');
  assert.equal((await env.store.findUserById(member.id)).mfaRecoveryCodes.length, 9);
  assert.ok(env.notifier.sent.some((m) => m.to === member.email && /recovery code was used/.test(m.subject)));
});

test('a removed member can be invited back with their old email; old history is kept', async (t) => {
  const { env, p, member } = await setup(t);
  await env.store.recordDownload({ token: 'tok-1', userId: member.id, photoId: 'ph' });
  await p.post(`/admin/members/${member.id}/remove`);
  await env.store.createAccessCode({ code: 'INVITE-BACK-AGAI-NNNN', expiresAt: new Date(Date.now() + 60000).toISOString() });
  const c = env.client();
  const res = await c.post('/register', {
    email: member.email,
    displayName: 'Grandma',
    password: NEW_PW,
    confirm: NEW_PW,
    accessCode: 'INVITE-BACK-AGAI-NNNN',
    acknowledgePrivacy: 'on',
  });
  assert.equal(res.location, '/home');
  const fresh = await env.store.findUserByEmail(member.email);
  assert.notEqual(fresh.id, member.id);
  assert.equal(fresh.disabled, false);
  const old = await env.store.findUserById(member.id);
  assert.equal(old.disabled, true);
  assert.equal((await env.store.findDownloadByToken('tok-1')).userId, member.id, 'leak history lost');
});

test('an ACTIVE account email still cannot be re-registered', async (t) => {
  const { env, member } = await setup(t);
  await env.store.createAccessCode({ code: 'INVITE-TAKE-OVER-NNNN', expiresAt: new Date(Date.now() + 60000).toISOString() });
  const res = await env.client().post('/register', {
    email: member.email,
    displayName: 'Imposter',
    password: NEW_PW,
    confirm: NEW_PW,
    accessCode: 'INVITE-TAKE-OVER-NNNN',
    acknowledgePrivacy: 'on',
  });
  assert.equal(res.status, 400);
  assert.equal((await env.store.findUserByEmail(member.email)).id, member.id);
});

test('the operator reset CLI refuses to run without the production database', () => {
  const { spawnSync } = require('node:child_process');
  const r = spawnSync(process.execPath, ['scripts/issue-reset-code.js', 'someone@test.com'], {
    env: { PATH: process.env.PATH, NODE_ENV: 'test' },
    encoding: 'utf8',
    timeout: 20000,
  });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /DATABASE_URL is not set/);
});
