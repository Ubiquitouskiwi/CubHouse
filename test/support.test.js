'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const totp = require('../src/security/totp');
const { deriveKey, sealText } = require('../src/security/secretBox');
const { verifyPassword } = require('../src/auth');
const { logger } = require('../src/logger');
const { canViewPhoto, photoCapabilities, portalCapabilities } = require('../src/permissions');
const { createOperatorAccount, maskEmail } = require('../src/services/support');
const { createActions } = require('../src/services/actions');
const { startApp, seedFamily, seedUser, addPhoto, PASSWORD } = require('./helpers');

const NEW_PW = 'a brand new long passphrase';
const OP_EMAIL = 'support@test.com';

/** An operator with two-step verification already on; returns its secret. */
async function seedOperator(env, { email = OP_EMAIL, displayName = 'Site Dev' } = {}) {
  const op = await seedUser(env.store, { email, role: 'operator', displayName });
  const secret = totp.generateSecret();
  await env.store.updateUser(op.id, {
    mfaEnabled: true,
    mfaSecretSealed: sealText(deriveKey(config.encryptionKey), secret, `mfa:${op.id}`),
    mfaLastCounter: -1,
  });
  return { op, secret };
}

async function signInOperator(env, { email = OP_EMAIL, secret }) {
  const c = env.client();
  const step1 = await c.post('/login', { email, password: PASSWORD });
  assert.equal(step1.location, '/login/mfa');
  const step2 = await c.post('/login/mfa', { code: totp.generate(secret) });
  assert.equal(step2.location, '/home');
  c.authed = true;
  return c;
}

async function setup(t) {
  const env = await startApp();
  t.after(env.close);
  const people = await seedFamily(env);
  const { op, secret } = await seedOperator(env);
  const o = await signInOperator(env, { secret });
  // Each action needs a code newer than the last one used, so a test can run
  // several actions within one 30-second step.
  const freshCode = async () => {
    await env.store.updateUser(op.id, { mfaLastCounter: -1 });
    return totp.generate(secret);
  };
  return { env, o, op, secret, freshCode, ...people };
}

async function lockOut(env, email) {
  const c = env.client();
  for (let i = 0; i < config.security.maxLoginFailures; i += 1) {
    await c.post('/login', { email, password: 'definitely the wrong password' });
  }
  const res = await env.client().post('/login', { email, password: PASSWORD });
  assert.equal(res.status, 429, 'the account should be locked');
}

async function events(env, type) {
  return (await env.store.listSecurityAuditEvents()).filter((e) => e.type === type);
}

test('role gating: anonymous is sent to sign in; parent, member and dev get 403', async (t) => {
  const { env, member } = await setup(t);
  const anon = env.client();
  assert.equal((await anon.get('/support')).location, '/login');
  assert.equal((await anon.get(`/support/accounts/${member.id}/unlock`)).location, '/login');
  const anonPost = await anon.post(`/support/accounts/${member.id}/unlock`, { confirm: 'UNLOCK', code: '000000' });
  assert.equal(anonPost.location, '/login');

  await seedUser(env.store, { email: 'dev@test.com', role: 'dev', displayName: 'Dev' });
  for (const email of ['parent@test.com', 'member@test.com', 'dev@test.com']) {
    const c = env.client();
    await c.login(email);
    assert.equal((await c.get('/support')).status, 403, `${email} reached /support`);
    assert.equal((await c.get(`/support/accounts/${member.id}/unlock`)).status, 403);
    const post = await c.post(`/support/accounts/${member.id}/reset-mfa`, { confirm: 'RESET MFA', code: '000000' });
    assert.equal(post.status, 403, `${email} posted a support action`);
    // The nav never offers it.
    assert.doesNotMatch((await c.get('/settings')).body, /href="\/support"/);
  }
  assert.equal((await events(env, 'support.mfa_reset')).length, 0);
});

test('the operator reaches only Support and its own settings, never family content', async (t) => {
  const { env, o } = await setup(t);
  const photo = await addPhoto(env, { caption: 'Beach day placeholder', audienceType: 'everyone' });
  assert.equal((await o.get('/home')).location, '/support');
  const page = await o.get('/support');
  assert.equal(page.status, 200);
  assert.match(page.body, /href="\/support"/);
  assert.doesNotMatch(page.body, /Beach day placeholder/);
  assert.doesNotMatch(page.body, /href="\/photos"/);
  for (const path of ['/photos', `/photos/${photo.id}`, '/albums', '/admin', '/admin/audit', '/downloads']) {
    assert.equal((await o.get(path)).status, 403, `${path} was reachable`);
  }
  assert.equal((await o.post('/settings/export')).status, 403);
  assert.equal((await o.get('/settings')).status, 200);
  assert.equal((await o.get('/settings/security')).status, 200);

  // The permission model agrees, whatever the photo's audience.
  const viewer = { role: 'operator', id: 'x', groupIds: [] };
  assert.equal(canViewPhoto(viewer, { audienceType: 'everyone' }), false);
  assert.equal(photoCapabilities(viewer).view, false);
  assert.equal(portalCapabilities('operator').viewAdminDashboard, false);
  assert.equal(portalCapabilities('operator').useSupportConsole, true);
});

test('an operator without two-step verification must enroll first and cannot turn it off', async (t) => {
  const env = await startApp();
  t.after(env.close);
  await seedFamily(env);
  await seedUser(env.store, { email: OP_EMAIL, role: 'operator', displayName: 'Site Dev' });
  const o = env.client();
  await o.login(OP_EMAIL);
  assert.equal((await o.get('/support')).location, '/settings/security');
  const page = await o.get('/settings/security');
  const secret = /class="setup-key"><code>([A-Z2-7 ]+)<\/code>/.exec(page.body)[1].replace(/ /g, '');
  await o.post('/settings/security/mfa/enable', { code: totp.generate(secret) });
  assert.equal((await o.get('/support')).status, 200);
  await o.post('/settings/security/mfa/disable', { password: PASSWORD, code: totp.generate(secret) });
  assert.equal((await env.store.findUserByEmail(OP_EMAIL)).mfaEnabled, true);
});

test('the Support page shows sign-in state, masked emails and no content', async (t) => {
  const { env, o } = await setup(t);
  await lockOut(env, 'member@test.com');
  const page = await o.get('/support');
  assert.match(page.body, /Locked/);
  assert.match(page.body, new RegExp(`<td>${config.security.maxLoginFailures}</td>`));
  assert.doesNotMatch(page.body, /member@test\.com/);
  assert.match(page.body, /m&#8226;&#8226;&#8226;@test\.com|m\u2022\u2022\u2022@test\.com/);
  assert.equal(maskEmail('parent@test.com'), 'p\u2022\u2022\u2022@test.com');
  // The operator's own row and other operators have no actions.
  assert.match(page.body, /<span class="muted">You<\/span>/);
});

test('unlock needs the typed word and a fresh code, then clears the lockout', async (t) => {
  const { env, o, op, member, freshCode } = await setup(t);
  await lockOut(env, member.email);
  const path = `/support/accounts/${member.id}/unlock`;
  assert.equal((await o.get(path)).status, 200);

  const wrongWord = await o.post(path, { confirm: 'yes', code: await freshCode() });
  assert.equal(wrongWord.status, 400);
  const badCode = await o.post(path, { confirm: 'UNLOCK', code: '000000' });
  assert.equal(badCode.status, 401);
  assert.equal((await events(env, 'support.mfa_failed')).length, 1);
  assert.equal((await env.client().post('/login', { email: member.email, password: PASSWORD })).status, 429);

  const code = await freshCode();
  const ok = await o.post(path, { confirm: 'unlock', code });
  assert.equal(ok.status, 200);
  assert.match(ok.body, /Unlock sign-in for Grandma is done/);
  // The same code cannot be used twice.
  const replay = await o.post(path, { confirm: 'UNLOCK', code });
  assert.equal(replay.status, 401);

  const [event] = await events(env, 'support.unlocked');
  assert.equal(event.actorId, op.id);
  assert.equal(event.targetId, member.id);
  assert.equal(event.details.action, 'unlock');
  assert.ok(event.at);

  // Notified by email (member and guardians), then in the app at sign-in.
  assert.ok(env.notifier.sent.some((m) => m.to === member.email && /developer/.test(m.subject)));
  assert.ok(env.notifier.sent.some((m) => m.to === 'parent@test.com' && /Support action/.test(m.subject)));
  const m = env.client();
  assert.equal((await m.login(member.email)).location, '/home');
  assert.match((await m.get('/home')).body, /the site&#39;s developer unlocked your sign-in/);
  assert.doesNotMatch((await m.get('/home')).body, /the site&#39;s developer/, 'the notice shows once');

  // The family audit trail shows it, under the operator's name.
  const p = env.client();
  await p.login('parent@test.com');
  const trail = (await p.get('/admin/audit')).body;
  assert.match(trail, /support\.unlocked/);
  assert.match(trail, /Site Dev/);
});

test('reset password: shown once, never stored, logged or emailed, and must be changed', async (t) => {
  const { env, o, member, freshCode } = await setup(t);
  const m = env.client();
  await m.login(member.email);
  assert.equal((await m.get('/home')).status, 200);

  // Capture every log call, whatever the configured level.
  const logged = [];
  const methods = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
  const saved = Object.fromEntries(methods.map((name) => [name, logger[name]]));
  for (const name of methods) {
    logger[name] = (...args) => logged.push(JSON.stringify(args));
  }
  t.after(() => Object.assign(logger, saved));

  const res = await o.post(`/support/accounts/${member.id}/reset-password`, {
    confirm: 'RESET PASSWORD',
    code: await freshCode(),
  });
  assert.equal(res.status, 200);
  assert.match(res.headers['cache-control'] || '', /no-store/);
  const temp = /<code>([A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4})<\/code>/.exec(res.body)[1];

  const stored = await env.store.findUserById(member.id);
  assert.ok(!JSON.stringify(stored).includes(temp), 'plaintext stored on the account');
  assert.ok(await verifyPassword(temp, stored.passwordHash));
  assert.equal(stored.mustChangePassword, true);
  const auditText = JSON.stringify(await env.store.listSecurityAuditEvents());
  assert.ok(!auditText.includes(temp), 'temporary password in the audit trail');
  assert.ok(!JSON.stringify(env.notifier.sent).includes(temp), 'temporary password emailed');
  assert.ok(!logged.join('\n').includes(temp), 'temporary password logged');
  assert.equal((await events(env, 'support.password_reset')).length, 1);

  // Not shown again.
  assert.ok(!(await o.get('/support')).body.includes(temp));
  // The old session ended, and the old password no longer works.
  assert.equal((await m.get('/home')).location, '/login');
  assert.equal((await env.client().post('/login', { email: member.email, password: PASSWORD })).status, 401);

  // The temporary password signs in only to the change-password gate.
  const n = env.client();
  assert.equal((await n.login(member.email, temp)).location, '/home');
  assert.equal((await n.get('/home')).location, '/settings#password');
  assert.equal((await n.get('/photos')).location, '/settings#password');
  await n.post('/settings/password', { currentPassword: temp, newPassword: NEW_PW, confirmPassword: NEW_PW });
  assert.equal((await n.get('/home')).status, 200);
  assert.equal((await env.store.findUserById(member.id)).tempPasswordExpiresAt, null);
});

test('an expired temporary password is refused', async (t) => {
  const { env, o, member, freshCode } = await setup(t);
  const res = await o.post(`/support/accounts/${member.id}/reset-password`, {
    confirm: 'RESET PASSWORD',
    code: await freshCode(),
  });
  const temp = /<code>([A-Z2-9-]{19})<\/code>/.exec(res.body)[1];
  await env.store.updateUser(member.id, { tempPasswordExpiresAt: new Date(Date.now() - 1000).toISOString() });
  assert.equal((await env.client().post('/login', { email: member.email, password: temp })).status, 401);
});

test('reset two-step verification: cleared, sessions ended, set up again at next sign-in', async (t) => {
  const { env, o, parent, freshCode } = await setup(t);
  const secret = totp.generateSecret();
  await env.store.updateUser(parent.id, {
    mfaEnabled: true,
    mfaSecretSealed: sealText(deriveKey(config.encryptionKey), secret, `mfa:${parent.id}`),
    mfaRecoveryCodes: ['hash-a', 'hash-b'],
  });
  const before = await env.store.findUserById(parent.id);
  const res = await o.post(`/support/accounts/${parent.id}/reset-mfa`, { confirm: 'RESET MFA', code: await freshCode() });
  assert.equal(res.status, 200);
  const after = await env.store.findUserById(parent.id);
  assert.equal(after.mfaEnabled, false);
  assert.equal(after.mfaSecretSealed, null);
  assert.deepEqual(after.mfaRecoveryCodes, []);
  assert.equal(after.mustEnrollMfa, true);
  assert.ok(after.sessionVersion > before.sessionVersion);
  assert.equal((await events(env, 'support.mfa_reset')).length, 1);

  // Password only now, then straight to enrollment.
  const p = env.client();
  assert.equal((await p.login('parent@test.com')).location, '/home');
  assert.equal((await p.get('/admin')).location, '/settings/security');
  const page = await p.get('/settings/security');
  const fresh = /class="setup-key"><code>([A-Z2-7 ]+)<\/code>/.exec(page.body)[1].replace(/ /g, '');
  await p.post('/settings/security/mfa/enable', { code: totp.generate(fresh) });
  assert.equal((await p.get('/admin')).status, 200);
});

test('the operator cannot act on itself, another operator, or a removed account', async (t) => {
  const { env, o, op, member, freshCode } = await setup(t);
  const { op: other } = await seedOperator(env, { email: 'support2@test.com', displayName: 'Other Dev' });
  for (const target of [op, other]) {
    assert.equal((await o.get(`/support/accounts/${target.id}/reset-password`)).status, 403);
    const res = await o.post(`/support/accounts/${target.id}/reset-password`, {
      confirm: 'RESET PASSWORD',
      code: await freshCode(),
    });
    assert.equal(res.status, 403);
  }
  assert.equal((await events(env, 'support.denied')).length, 2);
  assert.equal((await events(env, 'support.password_reset')).length, 0);
  assert.equal((await o.get(`/support/accounts/${member.id}/delete-everything`)).status, 404);

  await env.store.updateUser(member.id, { disabled: true });
  const removed = await o.post(`/support/accounts/${member.id}/unlock`, { confirm: 'UNLOCK', code: await freshCode() });
  assert.equal(removed.status, 409);
});

test('CSRF: a support action without a valid token is refused', async (t) => {
  const { env, o, member, freshCode } = await setup(t);
  await lockOut(env, member.email);
  const res = await o.post(
    `/support/accounts/${member.id}/unlock`,
    { _csrf: 'forged-token', confirm: 'UNLOCK', code: await freshCode() },
    { csrf: false }
  );
  assert.equal(res.status, 403);
  assert.equal((await events(env, 'support.unlocked')).length, 0);
  assert.equal((await env.client().post('/login', { email: member.email, password: PASSWORD })).status, 429);
});

test('guardians cannot grant, change or reset the operator role from the web', async (t) => {
  const { env, op, member } = await setup(t);
  const p = env.client();
  await p.login('parent@test.com');
  await p.post(`/admin/members/${member.id}/role`, { role: 'operator' });
  await p.post(`/admin/members/${op.id}/role`, { role: 'parent' });
  await p.post(`/admin/members/${op.id}/reset-signin`);
  assert.equal((await env.store.findUserById(member.id)).role, 'user');
  assert.equal((await env.store.findUserById(op.id)).role, 'operator');
  assert.equal((await events(env, 'account.reset_issued')).length, 0);
  // Even a governance request that somehow carries it is refused.
  const actions = createActions({ store: env.store, media: null, config });
  await actions.executors['user.setRole']({ userId: member.id, role: 'operator' });
  assert.equal((await env.store.findUserById(member.id)).role, 'user');
  // But the family can cut the support account off.
  await p.post(`/admin/members/${op.id}/remove`);
  assert.equal((await env.store.findUserById(op.id)).disabled, true);
});

test('the CLI helper creates an operator that must change its password and enroll', async (t) => {
  const env = await startApp();
  t.after(env.close);
  await seedFamily(env);
  const created = await createOperatorAccount(env.store, config, { email: 'Support@Test.com', displayName: 'Site Dev' });
  assert.equal(created.ok, true);
  assert.equal(created.user.role, 'operator');
  const dup = await createOperatorAccount(env.store, config, { email: 'parent@test.com' });
  assert.equal(dup.ok, false);
  assert.equal((await env.store.findUserByEmail('parent@test.com')).role, 'parent');

  const o = env.client();
  assert.equal((await o.login(OP_EMAIL, created.tempPassword)).location, '/home');
  assert.equal((await o.get('/support')).location, '/settings#password');
  await o.post('/settings/password', { currentPassword: created.tempPassword, newPassword: NEW_PW, confirmPassword: NEW_PW });
  assert.equal((await o.get('/support')).location, '/settings/security');
});

test('per-identity lockout lookup does not match a similar email', async () => {
  const { makeStore } = require('./storeFactory');
  const store = await makeStore();
  await store.setAuthFailureState('acct:a@test.com', { count: 3, lockedUntil: 0 });
  await store.setAuthFailureState('ip:127.0.0.1:a@test.com', { count: 3, lockedUntil: 0 });
  await store.setAuthFailureState('ip:127.0.0.1:aa@test.com', { count: 2, lockedUntil: 0 });
  await store.setAuthFailureState('acct:aa@test.com', { count: 2, lockedUntil: 0 });
  assert.equal((await store.listAuthFailureStatesFor('a@test.com')).length, 2);
  assert.equal(await store.clearAuthFailureStatesFor('a@test.com'), 2);
  assert.equal((await store.getAuthFailureState('acct:aa@test.com')).count, 2);
  assert.equal((await store.getAuthFailureState('ip:127.0.0.1:aa@test.com')).count, 2);
});
