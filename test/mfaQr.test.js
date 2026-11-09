'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const QRCode = require('qrcode');
const config = require('../src/config');
const totp = require('../src/security/totp');
const { qrSvg, ARIA_LABEL } = require('../src/security/qr');
const { deriveKey, sealText } = require('../src/security/secretBox');
const { logger } = require('../src/logger');
const { seedAccounts } = require('../src/server');
const { startApp, seedFamily, seedUser, setupKeyFrom, PASSWORD } = require('./helpers');

const NEW_PW = 'a brand new long passphrase';
const SVG_RE = /<figure class="qr-code"[^>]*>(<svg [\s\S]*?<\/svg>)<\/figure>/;

/** Record every text handed to the QR library, still encoding it for real. */
function spyOnQr(t) {
  const original = QRCode.toString;
  const encoded = [];
  QRCode.toString = (text, ...rest) => {
    encoded.push(text);
    return original.call(QRCode, text, ...rest);
  };
  t.after(() => {
    QRCode.toString = original;
  });
  return encoded;
}

/** Capture every log call, whatever the configured level. */
function captureLogs(t) {
  const logged = [];
  const methods = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
  const saved = Object.fromEntries(methods.map((name) => [name, logger[name]]));
  for (const name of methods) {
    logger[name] = (...args) => logged.push(JSON.stringify(args));
  }
  t.after(() => Object.assign(logger, saved));
  return logged;
}

/**
 * The enrollment page shows a QR code built from exactly this user's otpauth
 * URI, the manual key below a disclosure, and no-store. Returns the secret.
 */
async function assertEnrollmentPage(c, email, encoded) {
  const page = await c.get('/settings/security');
  assert.equal(page.status, 200);
  assert.match(page.headers['cache-control'] || '', /no-store/);
  const svg = SVG_RE.exec(page.body);
  assert.ok(svg, 'no inline QR code on the enrollment page');
  assert.match(svg[1], new RegExp(`role="img" aria-label="${ARIA_LABEL}"`));
  assert.match(page.body, /Scan this code with any authenticator app \(Google Authenticator, Authy,\s+1Password, Microsoft Authenticator/);

  // Manual fallback is still there, grouped in fours, under the disclosure.
  assert.match(page.body, /<summary>Can't scan\? Enter this key<\/summary>/);
  const groups = /id="mfa-setup-key">([A-Z2-7 ]+)<\/code>/.exec(page.body)[1].split(' ');
  assert.ok(groups.length > 1 && groups.every((g, i) => g.length === 4 || (i === groups.length - 1 && g.length < 4)));
  const secret = setupKeyFrom(page.body);

  // The SVG encodes exactly this account's URI (issuer = site name, label = email).
  const expected = totp.otpauthUri({ secret, account: email, issuer: config.app.name });
  assert.equal(encoded.at(-1), expected);
  assert.equal(svg[1], await qrSvg(expected));
  // The secret is not written into the SVG as text (it is only in the modules).
  assert.ok(!svg[1].includes(secret));
  assert.ok(!svg[1].includes(email));
  return secret;
}

async function assertNoQr(c, secret) {
  const after = await c.get('/settings/security');
  assert.equal(after.status, 200);
  assert.ok(!after.body.includes('class="qr-code"'), 'QR shown after enrollment');
  assert.ok(!after.body.includes('<svg'), 'QR shown after enrollment');
  assert.ok(!after.body.includes(secret), 'secret shown after enrollment');
  assert.ok(!after.body.includes('otpauth://'), 'otpauth URI shown after enrollment');
}

test('qrSvg rebuilds only the library output, black on white, with role and label', async () => {
  const uri = totp.otpauthUri({ secret: 'JBSWY3DPEHPK3PXP', account: 'a@example.com', issuer: 'Cubhouse' });
  const svg = await qrSvg(uri);
  assert.match(
    svg,
    /^<svg viewBox="0 0 (\d+) \1" shape-rendering="crispEdges" role="img" aria-label="QR code for your authenticator app" focusable="false"><rect width="\1" height="\1" fill="#ffffff"\/><path stroke="#000000" d="[MmHhVv0-9. ]+"\/><\/svg>$/
  );
  // Same path data as the library's own rendering of that exact URI.
  const raw = await QRCode.toString(uri, { type: 'svg', errorCorrectionLevel: 'M', margin: 4 });
  assert.equal(/ d="([^"]+)"\/><\/svg>/.exec(svg)[1], /<path stroke="#000000" d="([^"]+)"/.exec(raw)[1]);
  // Quiet zone of 4 modules on each side is part of the viewBox.
  assert.match(raw, /M4 4\.5h7/);
});

test('qrSvg puts no user text in the markup and refuses unexpected library output', async (t) => {
  const hostile = '"><script>alert(1)</script>@example.com';
  const svg = await qrSvg(totp.otpauthUri({ secret: 'JBSWY3DPEHPK3PXP', account: hostile, issuer: '<b>Site</b>' }));
  assert.ok(!/script|<b>|alert|example/.test(svg));

  const original = QRCode.toString;
  t.after(() => {
    QRCode.toString = original;
  });
  QRCode.toString = async () =>
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 25" shape-rendering="crispEdges">' +
    '<path stroke="#000000" d="M4 4.5h7"/><script>alert(1)</script></svg>';
  await assert.rejects(qrSvg('otpauth://totp/x'), /unexpected QR code output/);
  QRCode.toString = async () =>
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 25 25" shape-rendering="crispEdges">' +
    '<path stroke="#000000" d="M4 4.5h7" onload="x"/></svg>';
  await assert.rejects(qrSvg('otpauth://totp/x'), /unexpected QR code output/);
});

test('otpauthUri percent-encodes the issuer and the email label', () => {
  const uri = totp.otpauthUri({ secret: 'JBSWY3DPEHPK3PXP', account: 'first+last@example.com', issuer: 'Our Site & Co' });
  assert.equal(
    uri,
    'otpauth://totp/Our%20Site%20%26%20Co:first%2Blast%40example.com' +
      '?secret=JBSWY3DPEHPK3PXP&issuer=Our%20Site%20%26%20Co&algorithm=SHA1&digits=6&period=30'
  );
  const parsed = new URL(uri);
  assert.equal(decodeURIComponent(parsed.pathname.slice(1)), 'Our Site & Co:first+last@example.com');
});

test('normal enrollment: QR shown, secret never logged, gone once enrollment is confirmed', async (t) => {
  const env = await startApp();
  t.after(env.close);
  const { member } = await seedFamily(env);
  const encoded = spyOnQr(t);
  const logged = captureLogs(t);
  const c = env.client();
  await c.login(member.email);
  const secret = await assertEnrollmentPage(c, member.email, encoded);
  // Reloading keeps the same provisional secret (same QR), until confirmed.
  assert.equal(await assertEnrollmentPage(c, member.email, encoded), secret);

  // A wrong code does not enroll, and the QR is still offered.
  await c.post('/settings/security/mfa/enable', { code: '000000' });
  assert.equal((await env.store.findUserById(member.id)).mfaEnabled, false);
  await assertEnrollmentPage(c, member.email, encoded);

  const res = await c.post('/settings/security/mfa/enable', { code: totp.generate(secret) });
  assert.equal(res.location, '/settings/security');
  assert.equal((await env.store.findUserById(member.id)).mfaEnabled, true);
  await assertNoQr(c, secret);
  assert.ok(!logged.join('\n').includes(secret), 'MFA secret logged');
});

test('the QR page is only for the signed-in user and the CSP is unchanged', async (t) => {
  const env = await startApp();
  t.after(env.close);
  const anon = await env.client().get('/settings/security');
  assert.equal(anon.status, 302);
  assert.equal(anon.location, '/login');
  assert.ok(!anon.body.includes('<svg'));

  const { member } = await seedFamily(env);
  const c = env.client();
  await c.login(member.email);
  const page = await c.get('/settings/security');
  const csp = page.headers['content-security-policy'];
  assert.match(csp, /img-src 'self' blob:;/);
  assert.ok(!/data:|unsafe-inline/.test(csp));
});

test('forced enrollment after an operator reset (mustEnrollMfa) shows the QR', async (t) => {
  const env = await startApp();
  t.after(env.close);
  const { member } = await seedFamily(env);
  await env.store.updateUser(member.id, { mustEnrollMfa: true, mfaEnabled: false });
  const encoded = spyOnQr(t);
  const c = env.client();
  await c.login(member.email);
  assert.equal((await c.get('/home')).location, '/settings/security');
  const secret = await assertEnrollmentPage(c, member.email, encoded);
  await c.post('/settings/security/mfa/enable', { code: totp.generate(secret) });
  assert.equal((await c.get('/home')).status, 200);
  await assertNoQr(c, secret);
});

test('the operator account forced enrollment shows the QR', async (t) => {
  const env = await startApp();
  t.after(env.close);
  await seedFamily(env);
  await seedUser(env.store, { email: 'support@example.com', role: 'operator', displayName: 'Site Dev' });
  const encoded = spyOnQr(t);
  const o = env.client();
  await o.login('support@example.com');
  assert.equal((await o.get('/support')).location, '/settings/security');
  const secret = await assertEnrollmentPage(o, 'support@example.com', encoded);
  await o.post('/settings/security/mfa/enable', { code: totp.generate(secret) });
  assert.equal((await o.get('/support')).status, 200);
  await assertNoQr(o, secret);
});

test('the first guardian, at first sign-in, changes the password and then sees the QR', async (t) => {
  const env = await startApp();
  t.after(env.close);
  const savedProd = config.isProduction;
  const savedMfa = config.parentAuth.requireMfa;
  t.after(() => {
    config.isProduction = savedProd;
    config.parentAuth.requireMfa = savedMfa;
  });
  // Seed as production would (must change password), with guardian MFA required.
  config.isProduction = true;
  await seedAccounts(env.store);
  config.isProduction = savedProd;
  config.parentAuth.requireMfa = true;

  const encoded = spyOnQr(t);
  const { email, password } = config.seedAdmin;
  const p = env.client();
  assert.equal((await p.login(email, password)).location, '/home');
  assert.equal((await p.get('/home')).location, '/settings#password');
  await p.post('/settings/password', { currentPassword: password, newPassword: NEW_PW, confirmPassword: NEW_PW });
  assert.equal((await p.get('/admin')).location, '/settings/security');
  const secret = await assertEnrollmentPage(p, email, encoded);
  await p.post('/settings/security/mfa/enable', { code: totp.generate(secret) });
  assert.equal((await p.get('/admin')).status, 200);
  await assertNoQr(p, secret);
});

test('an account that already has two-step verification never gets a QR', async (t) => {
  const env = await startApp();
  t.after(env.close);
  const { member } = await seedFamily(env);
  const secret = totp.generateSecret();
  await env.store.updateUser(member.id, {
    mfaEnabled: true,
    mfaSecretSealed: sealText(deriveKey(config.encryptionKey), secret, `mfa:${member.id}`),
    mfaLastCounter: -1,
  });
  const encoded = spyOnQr(t);
  const c = env.client();
  await c.post('/login', { email: member.email, password: PASSWORD });
  await c.post('/login/mfa', { code: totp.generate(secret) });
  c.authed = true;
  await assertNoQr(c, secret);
  assert.equal(encoded.length, 0, 'QR rendered for an enrolled account');
});
