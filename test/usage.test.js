'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const totp = require('../src/security/totp');
const { deriveKey, sealText } = require('../src/security/secretBox');
const { runRetention } = require('../src/jobs/retention');
const {
  sectionFor,
  shown,
  shownPair,
  summaryLine,
  parseRange,
  utcDay,
  snapshotUsage,
  buildUsageReport,
  createUsageRecorder,
  METRICS,
} = require('../src/usage');
const { startApp, seedUser, PASSWORD } = require('./helpers');

const DAY = 24 * 60 * 60 * 1000;

async function seedOperator(env) {
  const op = await seedUser(env.store, { email: 'support@test.com', role: 'operator', displayName: 'Site Dev' });
  const secret = totp.generateSecret();
  await env.store.updateUser(op.id, {
    mfaEnabled: true,
    mfaSecretSealed: sealText(deriveKey(config.encryptionKey), secret, `mfa:${op.id}`),
    mfaLastCounter: -1,
  });
  const c = env.client();
  assert.equal((await c.post('/login', { email: 'support@test.com', password: PASSWORD })).location, '/login/mfa');
  assert.equal((await c.post('/login/mfa', { code: totp.generate(secret) })).location, '/home');
  c.authed = true;
  return c;
}

async function setup(t) {
  const env = await startApp();
  t.after(env.close);
  t.after(() => env.services.usage.stop());
  const parent = await seedUser(env.store, { email: 'parent@test.com', role: 'parent', displayName: 'Pat' });
  const member = await seedUser(env.store, { email: 'member@test.com', role: 'user', displayName: 'Aunt Example' });
  return { env, parent, member };
}

async function stored(env) {
  await env.services.usage.flush();
  const rows = await env.store.listUsageSince('2000-01-01');
  return Object.fromEntries(rows.filter((r) => r.day === utcDay(Date.now())).map((r) => [r.metric, r.value]));
}

// --- Access ---------------------------------------------------------------

test('usage page: guardian 200 and no-store; member, dev and operator 403; anonymous 404', async (t) => {
  const { env } = await setup(t);
  await seedUser(env.store, { email: 'dev@test.com', role: 'dev', displayName: 'Dev' });

  const anon = await env.client().get('/admin/usage');
  assert.equal(anon.status, 404);
  assert.doesNotMatch(anon.body, /Family accounts signed in/);

  for (const email of ['member@test.com', 'dev@test.com']) {
    const c = env.client();
    await c.login(email);
    const res = await c.get('/admin/usage');
    assert.equal(res.status, 403, `${email} reached /admin/usage`);
    assert.doesNotMatch(res.body, /Family accounts signed in/);
    assert.match(res.headers['cache-control'] || '', /no-store/);
    const home = await c.get('/home');
    assert.ok(!home.body.includes('href="/admin/usage"'), `${email} sees the Usage link`);
  }

  const op = await seedOperator(env);
  const opRes = await op.get('/admin/usage');
  assert.equal(opRes.status, 403);
  assert.doesNotMatch(opRes.body, /Family accounts signed in/);
  assert.ok(!(await op.get('/support')).body.includes('href="/admin/usage"'));

  const p = env.client();
  await p.login('parent@test.com');
  const res = await p.get('/admin/usage');
  assert.equal(res.status, 200);
  assert.match(res.headers['cache-control'] || '', /no-store/);
  assert.match(res.body, /<h1>Usage<\/h1>/);
  assert.ok((await p.get('/home')).body.includes('class="profile-dropdown-item" href="/admin/usage"'));
  assert.ok((await p.get('/admin')).body.includes('href="/admin/usage"'));
});

test('usage page: a demoted guardian loses access on the next request', async (t) => {
  const { env, parent } = await setup(t);
  const p = env.client();
  await p.login('parent@test.com');
  assert.equal((await p.get('/admin/usage')).status, 200);
  await env.store.updateUser(parent.id, { role: 'user' });
  assert.equal((await p.get('/admin/usage')).status, 403);
});

// --- Recording ------------------------------------------------------------

test('recording: sign-ins and named sections are counted; nothing else is stored', async (t) => {
  const { env } = await setup(t);
  const m = env.client();
  await m.login('member@test.com');
  await m.get('/photos?secret=query-string-is-never-kept');
  await m.get('/albums');
  await m.get('/home');
  await m.get('/media/does-not-exist/thumb'); // image bytes are not a section
  await m.get('/photos/no-such-photo'); // a 404 is not counted
  const counts = await stored(env);
  assert.equal(counts.logins, 1);
  assert.equal(counts['section.photos'], 1);
  assert.equal(counts['section.albums'], 1);
  assert.equal(counts['section.home'] >= 1, true);

  // Each stored row is exactly { day, metric, value }: no ids, IPs, agents or URLs.
  const rows = await env.store.listUsageSince('2000-01-01');
  for (const r of rows) {
    assert.deepEqual(Object.keys(r).sort(), ['day', 'metric', 'value']);
    assert.ok(METRICS.has(r.metric), r.metric);
  }
  assert.ok(!JSON.stringify(rows).includes('query-string'));
});

test('recording: operator, anonymous, prefetch and bot traffic do not count', async (t) => {
  const { env } = await setup(t);
  const op = await seedOperator(env);
  await op.get('/support');
  await env.client().get('/healthz');
  await env.client().get('/photos');
  const m = env.client();
  await m.login('member@test.com');
  const before = await stored(env);
  await m.get('/photos', { 'sec-purpose': 'prefetch' });
  await m.get('/photos', { 'user-agent': 'ExampleBot/1.0 (+https://example.test/bot)' });
  const after = await stored(env);
  assert.equal(after.logins, 1, 'only the member sign-in counts');
  assert.equal(after['section.photos'] || 0, before['section.photos'] || 0);
});

test('recording never breaks a request: store errors are swallowed and logged', async (t) => {
  const { env } = await setup(t);
  // t.mock restores the method after this test. Under test:pg every test in a
  // file shares one PgStore, so a plain assignment leaked into later tests.
  t.mock.method(env.store, 'addUsageCounts', async () => {
    throw new Error('database is down');
  });
  const m = env.client();
  await m.login('member@test.com');
  const res = await m.get('/photos');
  assert.equal(res.status, 200);
  await env.services.usage.flush(); // resolves, does not reject
});

test('recorder ignores unknown metric names and buffers until flush', async () => {
  const writes = [];
  const store = { addUsageCounts: async (day, counts) => writes.push({ day, counts }) };
  const r = createUsageRecorder({ store, now: () => Date.parse('2026-11-09T12:00:00Z') });
  r.count('logins');
  r.count('logins');
  r.count('section.photos');
  r.count('/photos/123?x=1');
  r.count('user.abc-123');
  assert.equal(writes.length, 0);
  await r.flush();
  r.stop();
  assert.deepEqual(writes, [{ day: '2026-11-09', counts: { logins: 2, 'section.photos': 1 } }]);
});

test('sections map routes to a few names and never keep the path', () => {
  assert.equal(sectionFor('GET', '/'), 'home');
  assert.equal(sectionFor('GET', '/home'), 'home');
  assert.equal(sectionFor('GET', '/photos'), 'photos');
  assert.equal(sectionFor('GET', '/photos/abc'), 'photos');
  assert.equal(sectionFor('GET', '/photos/abc/download'), 'downloads');
  assert.equal(sectionFor('GET', '/photos/downloads'), 'guardian');
  assert.equal(sectionFor('GET', '/admin/usage'), 'guardian');
  assert.equal(sectionFor('POST', '/photos/upload'), 'uploads');
  assert.equal(sectionFor('POST', '/photos/abc/comments'), 'comments');
  assert.equal(sectionFor('POST', '/photos/abc/react'), 'comments');
  assert.equal(sectionFor('POST', '/albums/abc/add'), 'albums');
  assert.equal(sectionFor('GET', '/settings/security'), 'settings');
  assert.equal(sectionFor('GET', '/media/abc/thumb'), null);
  assert.equal(sectionFor('POST', '/login'), null);
  assert.equal(sectionFor('GET', '/support'), null);
});

// --- Privacy of what is shown ---------------------------------------------

test('counts of 1 or 2 are hidden; pairs hide both sides', () => {
  assert.equal(shown(0).text, '0');
  assert.equal(shown(1).text, 'fewer than 3');
  assert.equal(shown(2).suppressed, true);
  assert.equal(shown(3).text, '3');
  assert.deepEqual(shownPair(5, 10).map((s) => s.text), ['5', '5']);
  assert.equal(shownPair(9, 10)[0].suppressed, true, 'the rest (1) would give it away');
  assert.equal(shownPair(1, 10)[1].suppressed, true);
  assert.equal(shownPair(10, 10)[0].text, '10');
  assert.equal(summaryLine(7, 12, 'this month'), '7 of 12 family accounts signed in this month.');
  assert.equal(summaryLine(2, 12, 'this month'), 'Fewer than 3 of the 12 family accounts signed in this month.');
  assert.equal(summaryLine(11, 12, 'this month'), 'All but fewer than 3 of the 12 family accounts signed in this month.');
  assert.equal(summaryLine(12, 12, 'this month'), 'All 12 family accounts signed in this month.');
  assert.equal(summaryLine(0, 12, 'this month'), 'None of the 12 family accounts signed in this month.');
  assert.equal(parseRange('90'), 90);
  assert.equal(parseRange('365'), 365);
  assert.equal(parseRange('7'), 30);
  assert.equal(parseRange(['90', '365']), 90);
  assert.equal(parseRange({ a: 1 }), 30);
});

test('report: summary, never-signed-in, and no names or ids on the page', async (t) => {
  const { env, parent, member } = await setup(t);
  const now = Date.now();
  const recent = new Date(now - 2 * DAY).toISOString();
  const old = new Date(now - 60 * DAY).toISOString();
  await env.store.updateUser(member.id, { lastLoginAt: recent });
  const people = [];
  for (let i = 0; i < 6; i += 1) {
    const u = await seedUser(env.store, { email: `cousin${i}@test.com`, displayName: `Sample Cousin ${i}` });
    people.push(u);
  }
  for (const u of people.slice(0, 3)) {
    await env.store.updateUser(u.id, { lastLoginAt: recent });
  }
  await env.store.updateUser(people[3].id, { lastLoginAt: old });
  // people[4] and [5] never signed in. A removed account is not counted.
  const gone = await seedUser(env.store, { email: 'gone@test.com', displayName: 'Removed Example' });
  await env.store.updateUser(gone.id, { disabled: true, lastLoginAt: recent });

  const p = env.client();
  await p.login('parent@test.com'); // parent signs in now
  const report = await buildUsageReport({ store: env.store });
  // 8 family accounts: parent, member, 6 cousins. Signed in within 30 days:
  // parent, member, 3 cousins = 5.
  assert.equal(report.total, 8);
  assert.equal(report.summary, '5 of 8 family accounts signed in during the last 30 days.');
  // Ever: 6 of 8, never: 2, so both are hidden.
  assert.equal(report.neverSignedIn.suppressed, true);
  assert.equal(report.everSignedIn.suppressed, true);
  // One or two guardians: no role split.
  assert.equal(report.roleSplitShown, false);

  const res = await p.get('/admin/usage');
  assert.equal(res.status, 200);
  assert.match(res.body, /5 of 8 family accounts signed in/);
  for (const name of ['Aunt Example', 'Sample Cousin', 'Removed Example', member.id, parent.id, 'member@test.com']) {
    assert.ok(!res.body.includes(name), `the page shows ${name}`);
  }
});

test('report: sign-ins and sections sum over 30/90/365 days with small counts hidden', async (t) => {
  const { env } = await setup(t);
  const now = Date.now();
  await env.store.addUsageCounts(utcDay(now), { logins: 4, 'section.photos': 2 });
  await env.store.addUsageCounts(utcDay(now - 40 * DAY), { logins: 5, 'section.photos': 9 });
  await env.store.addUsageCounts(utcDay(now - 200 * DAY), { logins: 6 });
  const report = await buildUsageReport({ store: env.store, now });
  assert.deepEqual(report.windows.map((w) => w.logins.text), ['4', '9', '15']);
  const photos = report.sections.find((s) => s.label === 'Browsing photos');
  assert.deepEqual(photos.counts.map((c) => c.text), ['fewer than 3', '11', '11']);
  assert.equal(report.buckets.length, 30);
  assert.equal(report.buckets[29].logins.text, '4');
  const year = await buildUsageReport({ store: env.store, now, range: 365 });
  assert.ok(year.buckets.length >= 12 && year.buckets.length <= 13);
  const quarter = await buildUsageReport({ store: env.store, now, range: 90 });
  assert.equal(quarter.buckets.length, 13);

  const p = env.client();
  await p.login('parent@test.com');
  for (const range of ['30', '90', '365', 'bogus']) {
    const res = await p.get(`/admin/usage?range=${range}`);
    assert.equal(res.status, 200, range);
    assert.match(res.body, /aria-current="page"/);
  }
});

// --- Snapshot and retention -----------------------------------------------

test('daily snapshot counts recent sign-ins; rollups past ~13 months are deleted', async (t) => {
  const { env, member } = await setup(t);
  const now = Date.now();
  await env.store.updateUser(member.id, { lastLoginAt: new Date(now - 3 * DAY).toISOString() });
  await env.store.addUsageCounts(utcDay(now - 401 * DAY), { logins: 3 });
  await env.store.addUsageCounts(utcDay(now - 399 * DAY), { logins: 3 });
  const result = await runRetention({ store: env.store, config, now });
  assert.equal(result.usagePurged, 1);
  const rows = await env.store.listUsageSince('2000-01-01');
  assert.equal(rows.filter((r) => r.metric === 'logins').length, 1);
  const today = Object.fromEntries(rows.filter((r) => r.day === utcDay(now)).map((r) => [r.metric, r.value]));
  assert.deepEqual(today, { 'accounts.all': 2, 'active1.all': 0, 'active7.all': 1, 'active30.all': 1 });
  // Running again the same day overwrites rather than adds.
  await snapshotUsage({ store: env.store, config, now });
  const again = await env.store.listUsageSince(utcDay(now));
  assert.equal(again.find((r) => r.metric === 'active7.all').value, 1);
});

test('a usage snapshot failure does not stop the retention job', async (t) => {
  const { env } = await setup(t);
  t.mock.method(env.store, 'setUsageValues', async () => {
    throw new Error('table missing');
  });
  const result = await runRetention({ store: env.store, config, now: Date.now() });
  assert.equal(result.usagePurged, 0);
});

// --- Privacy notice re-acknowledgement (notice bumped for usage counts) ---

test('a member who accepted the previous notice is asked to re-read it once', async (t) => {
  const { env, member } = await setup(t);
  assert.equal(config.privacy.noticeVersion, process.env.PRIVACY_NOTICE_VERSION || '2026-11-09');
  await env.store.updateUser(member.id, { privacyNoticeVersion: '2026-11-03' });
  const m = env.client();
  await m.login('member@test.com');

  assert.match((await m.get('/home')).body, /privacy notice has been updated/);
  const notice = await m.get('/privacy');
  assert.match(notice.body, /Usage counts:/);
  assert.match(notice.body, /action="\/privacy\/accept"/);

  const accepted = await m.post('/privacy/accept');
  assert.equal(accepted.location, '/home');
  assert.equal((await env.store.findUserById(member.id)).privacyNoticeVersion, config.privacy.noticeVersion);
  const events = (await env.store.listSecurityAuditEvents()).filter((e) => e.type === 'privacy.acknowledged');
  assert.equal(events.length, 1);
  assert.equal(events[0].details.version, config.privacy.noticeVersion);

  assert.doesNotMatch((await m.get('/home')).body, /privacy notice has been updated/);
  assert.doesNotMatch((await m.get('/privacy')).body, /action="\/privacy\/accept"/);
});
