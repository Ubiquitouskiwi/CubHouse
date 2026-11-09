'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { startApp, seedFamily, seedUser, rawRequest, PASSWORD } = require('./helpers');
const { configFindings, storeFindings, assertNotDeployedDev } = require('../src/security/bootstrapChecks');
const { makeStore } = require('./storeFactory');

async function env(t, opts) {
  const e = await startApp(opts);
  t.after(e.close);
  await seedFamily(e);
  return e;
}

test('security headers: strict CSP with nonce, no-referrer, frame denial, noindex, nosniff', async (t) => {
  const e = await env(t);
  const res = await e.client().get('/login');
  const csp = res.headers['content-security-policy'];
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self' 'nonce-[A-Za-z0-9+/=]+'/);
  assert.match(csp, /img-src 'self' blob:/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval|data:/);
  assert.equal(res.headers['referrer-policy'], 'no-referrer');
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.match(res.headers['x-robots-tag'], /noindex/);
  assert.match(res.headers['permissions-policy'], /geolocation=\(\)/);
  assert.match(res.headers['cache-control'], /no-store/);
  assert.equal(res.headers['x-powered-by'], undefined);
  // The one inline script carries this response's nonce.
  const nonce = /'nonce-([^']+)'/.exec(csp)[1];
  assert.ok(res.body.includes(`<script nonce="${nonce}">`));
});

test('no page references a third-party origin or contains inline event handlers', async (t) => {
  const e = await env(t);
  const c = e.client();
  await c.login('parent@test.com');
  for (const path of ['/home', '/photos', '/admin', '/settings', '/settings/security', '/privacy']) {
    const { body } = await c.get(path);
    assert.doesNotMatch(body, /https?:\/\/(?!127\.0\.0\.1|localhost)[a-z0-9.-]+\.[a-z]{2,}/i, `${path} has an external URL`);
    assert.doesNotMatch(body, /\son(submit|click|change|load)=/i, `${path} has an inline handler`);
    assert.doesNotMatch(body, /src="data:/, `${path} inlines a data: image`);
  }
});

test('robots.txt disallows everything', async (t) => {
  const e = await env(t);
  const res = await e.client().get('/robots.txt');
  assert.equal(res.status, 200);
  assert.match(res.body, /Disallow: \//);
});

test('CSRF: every mutating route refuses a POST without a valid token', async (t) => {
  const e = await env(t);
  const anon = e.client();
  const noToken = await anon.post('/login', { email: 'parent@test.com', password: PASSWORD }, { csrf: false });
  assert.equal(noToken.status, 403);

  const c = e.client();
  await c.login('parent@test.com');
  const routes = [
    '/logout',
    '/settings/profile',
    '/settings/password',
    '/settings/theme',
    '/settings/export',
    '/albums',
    '/admin/access-codes',
    '/admin/groups',
    '/photos/bulk',
    '/settings/security/signout-all',
    '/settings/security/recovery-codes',
    '/settings/security/cancel-reset',
    '/admin/members/00000000-0000-0000-0000-000000000000/reset-signin',
  ];
  const anonReset = await anon.post('/reset', { _csrf: 'forged-token', email: 'x@test.com', code: 'RESET-AAAA-BBBB-CCCC' }, { csrf: false });
  assert.equal(anonReset.status, 403, '/reset accepted a forged token');
  for (const path of routes) {
    const res = await c.post(path, { _csrf: 'forged-token' }, { csrf: false });
    assert.equal(res.status, 403, `${path} accepted a forged token`);
  }
  // Still signed in: the forged logout did nothing.
  assert.equal((await c.get('/home')).status, 200);
});

test('session fixation: the session id changes at login', async (t) => {
  const e = await env(t);
  const c = e.client();
  await c.get('/login');
  const before = c.cookies.get(config.session.name);
  assert.ok(before);
  await c.login('parent@test.com');
  assert.notEqual(c.cookies.get(config.session.name), before);
});

test('session cookie is HttpOnly and SameSite=Strict', async (t) => {
  const e = await env(t);
  const res = await rawRequest(e.base, '/login');
  const cookie = [].concat(res.headers['set-cookie'])[0];
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Strict/i);
});

test('lockout: repeated failures lock the account, then even the right password is refused', async (t) => {
  const e = await env(t);
  const c = e.client();
  for (let i = 0; i < config.security.maxLoginFailures; i += 1) {
    const res = await c.post('/login', { email: 'parent@test.com', password: 'wrong password!!' });
    assert.equal(res.status, 401);
  }
  const locked = await c.post('/login', { email: 'parent@test.com', password: PASSWORD });
  assert.equal(locked.status, 429);
  const events = await e.store.listSecurityAuditEvents();
  assert.ok(events.some((ev) => ev.type === 'auth.lockout'));
  // The account owner is told.
  assert.ok(e.notifier.sent.some((m) => m.to === 'parent@test.com' && /blocked/.test(m.subject)));
});

test('unknown and known emails get the same sign-in error', async (t) => {
  const e = await env(t);
  const c = e.client();
  const known = await c.post('/login', { email: 'parent@test.com', password: 'wrong password!!' });
  const unknown = await c.post('/login', { email: 'nobody@test.com', password: 'wrong password!!' });
  assert.equal(known.status, unknown.status);
  const msg = (b) => /alert-error[^>]*><p>([^<]+)/.exec(b)[1];
  assert.equal(msg(known.body), msg(unknown.body));
});

test('repeated form fields return 400 instead of crashing the server', async (t) => {
  const e = await env(t);
  const c = e.client();
  await c.login('member@test.com');
  const res = await c.post('/albums', { name: ['a', 'b'] });
  assert.equal(res.status, 400);
  // The process is still serving.
  assert.equal((await c.get('/home')).status, 200);
});

test('oversized urlencoded bodies are refused with 413', async (t) => {
  const e = await env(t);
  const big = 'x'.repeat(200 * 1024);
  const res = await rawRequest(e.base, '/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'content-length': big.length + 6 },
    body: `email=${big}`,
  });
  assert.equal(res.status, 413);
});

test('an error thrown in an async handler becomes a 500, not a crash', async (t) => {
  const e = await env(t);
  const c = e.client();
  await c.login('member@test.com');
  const original = e.store.listAlbumsByOwner;
  e.store.listAlbumsByOwner = async () => {
    throw new Error('boom');
  };
  const res = await c.get('/albums');
  assert.equal(res.status, 500);
  assert.doesNotMatch(res.body, /boom/);
  e.store.listAlbumsByOwner = original;
  assert.equal((await c.get('/albums')).status, 200);
});

test('open redirects through a forged Referer are refused', async (t) => {
  const e = await env(t);
  const c = e.client();
  await c.login('parent@test.com');
  const res = await c.post('/photos/does-not-exist/toggle-hidden', {}, { headers: { referer: 'https://evil.example/phish' } });
  assert.equal(res.status, 302);
  assert.equal(res.location, '/photos');
});

test('dev role: no member emails and no invite codes on the admin page', async (t) => {
  const e = await env(t);
  await seedUser(e.store, { email: 'dev@test.com', role: 'dev' });
  const p = e.client();
  await p.login('parent@test.com');
  await p.post('/admin/access-codes', { note: 'for Grandpa' });
  const code = (await e.store.listAccessCodes())[0].code;

  const d = e.client();
  await d.login('dev@test.com');
  const res = await d.get('/admin');
  assert.equal(res.status, 200);
  assert.ok(!res.body.includes(code), 'dev can see an invite code');
  assert.ok(!res.body.includes('member@test.com'), 'dev can see member emails');
  assert.equal((await d.post('/admin/access-codes', { note: 'x' })).location, '/home');
});

test('rate limiting: a burst of registrations from one address gets 429', async (t) => {
  const e = await env(t);
  const c = e.client();
  let last;
  for (let i = 0; i < 12; i += 1) {
    last = await c.post('/register', { email: `x${i}@t.com`, accessCode: 'INVITE-NOPE' });
  }
  assert.equal(last.status, 429);
});

test('safe boot refuses unsafe production configuration', () => {
  const prodLike = {
    ...config,
    session: { ...config.session, secret: 'short', cookie: { ...config.session.cookie, secure: false } },
    encryptionKey: '',
    databaseUrl: '',
    trustProxyHops: 0,
    parentAuth: { ...config.parentAuth, requireMfa: false },
  };
  const findings = configFindings(prodLike, { storeKind: 'memory', sessionStoreKind: 'memory', rateLimitShared: false, mediaKind: 'local' }, { FORCE_SAFE_BOOT: 'false', SEED_TEST_ACCOUNTS: 'true' });
  const text = findings.join('\n');
  for (const needle of ['SESSION_SECRET', 'APP_ENCRYPTION_KEY', 'DATABASE_URL', 'Sessions', 'Rate limits', 'MEDIA_BACKEND', 'TRUST_PROXY_HOPS', 'Secure', 'PARENT_MFA_REQUIRED', 'FORCE_SAFE_BOOT', 'SEED_TEST_ACCOUNTS']) {
    assert.match(text, new RegExp(needle), `missing finding for ${needle}`);
  }
});

test('safe boot refuses a dev account in the store', async () => {
  const store = await makeStore();
  await seedUser(store, { email: 'dev@test.com', role: 'dev' });
  const findings = await storeFindings(store);
  assert.equal(findings.length, 1);
});

test('development mode refuses to start when the environment looks deployed', () => {
  const dev = { ...config, isProduction: false, isTest: false };
  assert.doesNotThrow(() => assertNotDeployedDev({ ...dev, trustProxyHops: 0, publicOrigin: 'http://localhost:3000', host: '127.0.0.1' }, {}));
  assert.throws(() => assertNotDeployedDev({ ...dev, trustProxyHops: 1 }, {}), /looks like a deployment/);
  assert.throws(
    () => assertNotDeployedDev({ ...dev, trustProxyHops: 0, publicOrigin: 'https://photos.example.org', host: '127.0.0.1' }, {}),
    /PUBLIC_ORIGIN/
  );
  assert.throws(() => assertNotDeployedDev({ ...dev, trustProxyHops: 0, host: '0.0.0.0' }, {}), /HOST/);
  assert.throws(
    () => assertNotDeployedDev({ ...dev, trustProxyHops: 0, host: '127.0.0.1' }, { INVOCATION_ID: 'x', JOURNAL_STREAM: 'y' }),
    /systemd/
  );
  // Production is judged by safe boot instead.
  assert.doesNotThrow(() => assertNotDeployedDev({ ...dev, isProduction: true, trustProxyHops: 1 }, {}));
});

test('a wildcard bind is allowed in development only inside the container image', () => {
  const dev = { ...config, isProduction: false, isTest: false, trustProxyHops: 0, publicOrigin: 'http://localhost:3000' };
  const inImage = { APP_IN_CONTAINER: 'true' };
  assert.doesNotThrow(() => assertNotDeployedDev({ ...dev, host: '0.0.0.0' }, inImage));
  assert.doesNotThrow(() => assertNotDeployedDev({ ...dev, host: '::' }, inImage));
  // Only wildcards: a specific non-loopback address is still a deployment signal.
  assert.throws(() => assertNotDeployedDev({ ...dev, host: '192.0.2.10' }, inImage), /HOST/);
  assert.throws(() => assertNotDeployedDev({ ...dev, host: '0.0.0.0' }, { APP_IN_CONTAINER: '1' }), /HOST/);
  // Dev mode is refused on StarlingTek even inside the image.
  assert.throws(
    () => assertNotDeployedDev({ ...dev, host: '0.0.0.0' }, { ...inImage, STK_PROJECT: 'photos' }),
    /StarlingTek/
  );
});

test('the development boot command refuses a deployed-looking environment', () => {
  const { spawnSync } = require('node:child_process');
  const env = { PATH: process.env.PATH, NODE_ENV: 'development', TRUST_PROXY_HOPS: '1' };
  const r = spawnSync(process.execPath, ['src/server.js'], { env, encoding: 'utf8', timeout: 20000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /looks like a deployment/);
});

test('the production boot command refuses to start with no secrets', async () => {
  const { spawnSync } = require('node:child_process');
  const env = { PATH: process.env.PATH, NODE_ENV: 'production' };
  const r = spawnSync(process.execPath, ['src/server.js'], { env, encoding: 'utf8', timeout: 20000 });
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /Safe boot check failed/);
});

test('the server exits cleanly on SIGTERM (a deploy swap or docker stop)', async () => {
  const { spawn } = require('node:child_process');
  const env = { PATH: process.env.PATH, NODE_ENV: 'development', PORT: '0', LOG_LEVEL: 'info' };
  const child = spawn(process.execPath, ['src/server.js'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  const killer = setTimeout(() => child.kill('SIGKILL'), 20000);
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => String(d).includes('photo site listening') && resolve());
    child.on('exit', (code) => reject(new Error(`exited early with ${code}`)));
  });
  child.kill('SIGTERM');
  const [code, signal] = await new Promise((resolve) => child.on('exit', (c, s) => resolve([c, s])));
  clearTimeout(killer);
  assert.equal(signal, null);
  assert.equal(code, 0);
});
