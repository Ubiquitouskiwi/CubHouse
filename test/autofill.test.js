'use strict';

// Password-manager autofill on forms that ask for the current password and/or
// an authenticator code. Managers need a username field before the password,
// a code box marked as a one-time code, and hints to skip non-credential boxes.
// The hidden username is a hint only: the server must never act on it.

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const totp = require('../src/security/totp');
const { deriveKey, sealText } = require('../src/security/secretBox');
const { verifyPassword } = require('../src/auth');
const { startApp, seedFamily, seedUser, PASSWORD } = require('./helpers');

const OTHER_EMAIL = 'other@test.com';
const OTHER_PASSWORD = 'a different long passphrase';
const IGNORE_HINTS = [
  'autocomplete="off"',
  'data-1p-ignore',
  'data-lpignore="true"',
  'data-bwignore',
  'data-form-type="other"',
];

/** The first <form> whose action matches, as raw HTML. */
function formFor(body, action) {
  const forms = body.match(/<form\b[\s\S]*?<\/form>/g) || [];
  const found = forms.find((f) => f.includes(`action="${action}"`));
  assert.ok(found, `no form posting to ${action}`);
  return found;
}

/** Every <input ...> tag in the HTML. */
function inputs(html) {
  return html.match(/<input\b[^>]*>/g) || [];
}

function inputNamed(html, name) {
  const tag = inputs(html).find((t) => t.includes(`name="${name}"`) && !t.includes('type="hidden"'));
  assert.ok(tag, `no input named ${name}`);
  return tag;
}

/** The hidden autofill username sits before the first password box and carries the account's email. */
function assertHiddenUsername(form, email) {
  const tag = inputs(form).find((t) => t.includes('class="autofill-username"'));
  assert.ok(tag, 'hidden username field missing');
  for (const attr of [
    'name="username"',
    'autocomplete="username"',
    `value="${email}"`,
    'readonly',
    'tabindex="-1"',
    'aria-hidden="true"',
  ]) {
    assert.ok(tag.includes(attr), `hidden username lacks ${attr}: ${tag}`);
  }
  const pw = form.indexOf('type="password"');
  if (pw >= 0) {
    assert.ok(form.indexOf(tag) < pw, 'hidden username must come before the password');
  }
  // Exactly one username-like field per form, so managers have no second guess.
  assert.equal(form.match(/autocomplete="username"/g).length, 1);
}

/** A box that accepts only authenticator (TOTP) codes. */
function assertTotpBox(form) {
  const tag = inputNamed(form, 'code');
  for (const attr of [
    'autocomplete="one-time-code"',
    'inputmode="numeric"',
    'pattern="[0-9 ]*"',
    'autocapitalize="off"',
    'spellcheck="false"',
  ]) {
    assert.ok(tag.includes(attr), `code box lacks ${attr}: ${tag}`);
  }
  assert.match(form, /6-digit code from your authenticator app/);
  // Bitwarden refuses to treat a field as a code box if its label mentions these.
  const label = /<label>([\s\S]*?)<input[^>]*name="code"/.exec(form)[1];
  assert.doesNotMatch(label, /recovery|backup/i);
  const pw = form.indexOf('type="password"');
  if (pw >= 0) {
    assert.ok(pw < form.indexOf(tag), 'password must come before the code');
  }
  assert.equal(form.match(/type="submit"/g).length, 1, 'one submit button');
}

function assertIgnored(tag) {
  for (const attr of IGNORE_HINTS) {
    assert.ok(tag.includes(attr), `non-credential box lacks ${attr}: ${tag}`);
  }
}

async function turnOnMfa(env, user) {
  const secret = totp.generateSecret();
  await env.store.updateUser(user.id, {
    mfaEnabled: true,
    mfaSecretSealed: sealText(deriveKey(config.encryptionKey), secret, `mfa:${user.id}`),
    mfaLastCounter: -1,
  });
  // Each check needs a code newer than the last one used.
  const freshCode = async () => {
    await env.store.updateUser(user.id, { mfaLastCounter: -1 });
    return totp.generate(secret);
  };
  return { secret, freshCode };
}

async function signInWithMfa(env, email, secret) {
  const c = env.client();
  assert.equal((await c.post('/login', { email, password: PASSWORD })).location, '/login/mfa');
  const page = await c.get('/login/mfa');
  assert.equal((await c.post('/login/mfa', { code: totp.generate(secret) })).location, '/home');
  c.authed = true;
  return { c, challenge: page.body };
}

async function setup(t) {
  const env = await startApp();
  t.after(env.close);
  const people = await seedFamily(env);
  const other = await seedUser(env.store, { email: OTHER_EMAIL, password: OTHER_PASSWORD, displayName: 'Other' });
  return { env, other, ...people };
}

async function events(env, type) {
  return (await env.store.listSecurityAuditEvents()).filter((e) => e.type === type);
}

test('reauth: hidden username before the password; TOTP box when two-step is on', async (t) => {
  const { env, member } = await setup(t);
  const c = env.client();
  await c.login(member.email);
  const plain = formFor((await c.get('/reauth')).body, '/reauth');
  assertHiddenUsername(plain, member.email);
  assert.doesNotMatch(plain, /name="code"/);

  const { secret } = await turnOnMfa(env, member);
  const { c: m, challenge } = await signInWithMfa(env, member.email, secret);
  const withCode = formFor((await m.get('/reauth')).body, '/reauth');
  assertHiddenUsername(withCode, member.email);
  assertTotpBox(withCode);
  // The rerendered form after a failure keeps both.
  const failed = await m.post('/reauth', { password: 'not my password at all', code: '000000' });
  assert.equal(failed.status, 401);
  assertHiddenUsername(formFor(failed.body, '/reauth'), member.email);

  // The sign-in code box also takes recovery codes (letters), so it is not numeric-only.
  const box = inputNamed(formFor(challenge, '/login/mfa'), 'code');
  assert.ok(box.includes('autocomplete="one-time-code"'));
  assert.ok(!box.includes('inputmode="numeric"') && !box.includes('pattern='), box);
  const hint = /id="code-help">([\s\S]*?)<\/p>/.exec(challenge)[1];
  assert.doesNotMatch(hint, /recovery|backup/i, 'Bitwarden reads aria-describedby text');
});

test('reauth ignores a posted username: it never signs in as, or checks, another account', async (t) => {
  const { env, member, other } = await setup(t);
  const c = env.client();
  await c.login(member.email);
  // The other account's own password, with the other account named: refused.
  const asOther = await c.post('/reauth', { username: OTHER_EMAIL, password: OTHER_PASSWORD });
  assert.equal(asOther.status, 401);
  const [failed] = await events(env, 'auth.stepup_failed');
  assert.equal(failed.targetId, member.id);
  // The session user's password with someone else's name: accepted, for the session user.
  const ok = await c.post('/reauth', { username: OTHER_EMAIL, password: PASSWORD });
  assert.equal(ok.status, 302);
  const [stepup] = await events(env, 'auth.stepup');
  assert.equal(stepup.targetId, member.id);
  assert.notEqual(stepup.targetId, other.id);
});

test('settings: hidden username on the password and delete forms; handle and DELETE box ignored', async (t) => {
  const { env, member } = await setup(t);
  const c = env.client();
  await c.login(member.email);
  const page = (await c.get('/settings')).body;
  assertHiddenUsername(formFor(page, '/settings/password'), member.email);
  const del = formFor(page, '/settings/delete-account');
  assertHiddenUsername(del, member.email);
  assertIgnored(inputNamed(del, 'confirm'));
  // The profile form has its own email box, so no hidden field; its handle is not a sign-in name.
  const profile = formFor(page, '/settings/profile');
  assert.doesNotMatch(profile, /autofill-username/);
  const handle = inputNamed(profile, 'username');
  assert.ok(handle.includes('autocomplete="nickname"'), handle);
  assertIgnored(handle.replace('autocomplete="nickname"', 'autocomplete="off"'));
});

test('settings: a posted username cannot change or delete another account', async (t) => {
  const { env, member, other } = await setup(t);
  const c = env.client();
  await c.login(member.email);
  const NEW_PW = 'my brand new long passphrase';
  const changed = await c.post('/settings/password', {
    username: OTHER_EMAIL,
    currentPassword: PASSWORD,
    newPassword: NEW_PW,
    confirmPassword: NEW_PW,
  });
  assert.equal(changed.status, 302);
  assert.ok(await verifyPassword(NEW_PW, (await env.store.findUserById(member.id)).passwordHash));
  assert.ok(await verifyPassword(OTHER_PASSWORD, (await env.store.findUserById(other.id)).passwordHash));

  // The other account's password, naming the other account: refused, nothing deleted.
  const d = env.client();
  await d.login(member.email, NEW_PW);
  await d.post('/settings/delete-account', { username: OTHER_EMAIL, confirm: 'DELETE', password: OTHER_PASSWORD });
  assert.ok(await env.store.findUserById(member.id));
  assert.ok(await env.store.findUserById(other.id));
  // Own password with another name: deletes the session user only.
  await d.post('/settings/delete-account', { username: OTHER_EMAIL, confirm: 'DELETE', password: NEW_PW });
  assert.equal(await env.store.findUserById(member.id), null);
  assert.ok(await env.store.findUserById(other.id));
});

test('security: turn-off form has the hidden username and TOTP box; a posted username changes nothing', async (t) => {
  const { env, member, other } = await setup(t);
  const fresh = env.client();
  await fresh.login(OTHER_EMAIL, OTHER_PASSWORD);
  assertTotpBox(formFor((await fresh.get('/settings/security')).body, '/settings/security/mfa/enable'));

  const { secret, freshCode } = await turnOnMfa(env, member);
  const otherMfa = await turnOnMfa(env, other);
  const { c } = await signInWithMfa(env, member.email, secret);
  const off = formFor((await c.get('/settings/security')).body, '/settings/security/mfa/disable');
  assertHiddenUsername(off, member.email);
  assertTotpBox(off);

  // Another account's password and code, naming it: refused, both stay on.
  await c.post('/settings/security/mfa/disable', {
    username: OTHER_EMAIL,
    password: OTHER_PASSWORD,
    code: await otherMfa.freshCode(),
  });
  assert.equal((await env.store.findUserById(member.id)).mfaEnabled, true);
  assert.equal((await env.store.findUserById(other.id)).mfaEnabled, true);
  // Own credentials with another name: turns off the session user's only.
  await c.post('/settings/security/mfa/disable', {
    username: OTHER_EMAIL,
    password: PASSWORD,
    code: await freshCode(),
  });
  assert.equal((await env.store.findUserById(member.id)).mfaEnabled, false);
  assert.equal((await env.store.findUserById(other.id)).mfaEnabled, true);
});

test('support confirm: hidden username, ignored confirm box, TOTP box; posted username ignored', async (t) => {
  const { env, member } = await setup(t);
  const op = await seedUser(env.store, { email: 'support@test.com', role: 'operator', displayName: 'Site Dev' });
  const { secret, freshCode } = await turnOnMfa(env, op);
  const { c } = await signInWithMfa(env, op.email, secret);
  const path = `/support/accounts/${member.id}/unlock`;
  const form = formFor((await c.get(path)).body, path);
  assertHiddenUsername(form, op.email);
  assertIgnored(inputNamed(form, 'confirm'));
  assertTotpBox(form);

  const res = await c.post(path, { username: OTHER_EMAIL, confirm: 'UNLOCK', code: await freshCode() });
  assert.equal(res.status, 200);
  const [event] = await events(env, 'support.unlocked');
  assert.equal(event.actorId, op.id);
});

test('non-credential boxes carry the password-manager ignore hints; reset keeps its username', async (t) => {
  const { env, parent } = await setup(t);
  const anon = env.client();
  const reset = formFor((await anon.get('/reset')).body, '/reset');
  assertIgnored(inputNamed(reset, 'code'));
  assert.ok(inputNamed(reset, 'email').includes('autocomplete="username"'));
  assertIgnored(inputNamed(formFor((await anon.get('/register')).body, '/register'), 'accessCode'));

  const p = env.client();
  await p.login(parent.email);
  const admin = (await p.get('/admin')).body;
  assertIgnored(inputNamed(formFor(admin, '/admin/archive/erase'), 'confirm'));
});
