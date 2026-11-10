'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { startApp, seedFamily, seedUser } = require('./helpers');
const { MemoryStore } = require('../src/store/memoryStore');
const {
  validTimeZone,
  formatInZone,
  effectiveTimeZone,
  saveTimeZone,
  supportedTimeZones,
} = require('../src/timeZone');

const ROUTE = '/admin/settings/time-zone';

/** Run with APP_TIME_ZONE (config.app.timeZone) set to `zone` for one test. */
function withServerZone(t, zone) {
  const saved = config.app.timeZone;
  config.app.timeZone = zone;
  t.after(() => {
    config.app.timeZone = saved;
  });
}

async function family(t, { delayMs = 0 } = {}) {
  const savedDelay = config.governance.soloDelayMs;
  config.governance.soloDelayMs = delayMs;
  t.after(() => {
    config.governance.soloDelayMs = savedDelay;
  });
  const env = await startApp();
  t.after(env.close);
  await seedFamily(env);
  const guardian = env.client();
  await guardian.login('parent@test.com');
  return { env, guardian };
}

const zoneEvents = async (env) =>
  (await env.store.listSecurityAuditEvents()).filter((e) => e.type === 'settings.time_zone');

test('time zone: validation accepts IANA names (canonicalized) and rejects anything else', () => {
  assert.equal(validTimeZone('America/New_York'), 'America/New_York');
  assert.equal(validTimeZone(' america/new york '), 'America/New_York');
  assert.equal(validTimeZone('UTC'), 'UTC');
  for (const bad of ['Mars/Olympus', 'EST5EDT; DROP', '', null, ['UTC'], 'x'.repeat(65), '<script>']) {
    assert.equal(validTimeZone(bad), null, `accepted ${JSON.stringify(bad)}`);
  }
  assert.ok(supportedTimeZones().includes('UTC'));
  assert.ok(supportedTimeZones().includes('America/Chicago'));
  assert.equal(formatInZone('2026-11-13T21:46:00.000Z', 'America/New_York'), 'Fri, Nov 13, 2026, 4:46 PM EST');
  assert.equal(formatInZone('nonsense', 'UTC'), null);
});

test('time zone: fallback order is the guardian setting, then APP_TIME_ZONE, then UTC', async (t) => {
  const store = new MemoryStore();
  withServerZone(t, null);
  assert.deepEqual(await effectiveTimeZone(store, config), { zone: 'UTC', source: 'utc' });
  config.app.timeZone = 'Europe/London';
  assert.deepEqual(await effectiveTimeZone(store, config), { zone: 'Europe/London', source: 'server' });
  await saveTimeZone(store, 'Asia/Tokyo');
  assert.deepEqual(await effectiveTimeZone(store, config), { zone: 'Asia/Tokyo', source: 'family' });
  // A store failure never breaks an email: it falls back to the server default.
  const broken = { getSiteSetting: async () => Promise.reject(new Error('relation does not exist')) };
  assert.deepEqual(await effectiveTimeZone(broken, config), { zone: 'Europe/London', source: 'server' });
});

test('time zone: a guardian saves it, it is audit-logged old -> new, and clearing falls back', async (t) => {
  withServerZone(t, 'Europe/London');
  const { env, guardian } = await family(t);

  let page = await guardian.get('/admin');
  assert.match(page.body, /id="family-settings"/);
  assert.match(page.body, /<label for="tz-input">Time zone for emails<\/label>/);
  assert.match(page.body, /In effect: <strong>Europe\/London<\/strong>\s*\(server default, from APP_TIME_ZONE\)/);
  assert.match(page.body, /<option value="America\/Chicago">/);
  assert.match(page.body, /Use my current time zone/);

  const res = await guardian.post(ROUTE, { timeZone: 'America/Chicago' });
  assert.equal(res.status, 302);
  assert.equal(res.location, '/admin#family-settings');
  assert.equal((await env.store.getSiteSetting('timeZone')).zone, 'America/Chicago');
  page = await guardian.get('/admin');
  assert.match(page.body, /Time zone set to America\/Chicago/);
  assert.match(page.body, /In effect: <strong>America\/Chicago<\/strong>\s*\(set here\)/);
  assert.match(page.body, /Invite codes will say: <strong data-tz-example>[^<]+ C[SD]T<\/strong>/);

  await guardian.post(ROUTE, { timeZone: 'Asia/Tokyo' });
  await guardian.post(ROUTE, { timeZone: '' });
  assert.equal(await env.store.getSiteSetting('timeZone'), null);
  page = await guardian.get('/admin');
  assert.match(page.body, /server default, Europe\/London/);

  const events = await zoneEvents(env);
  assert.deepEqual(
    events.map((e) => ({ from: e.details.from, to: e.details.to })),
    [
      { from: null, to: 'America/Chicago' },
      { from: 'America/Chicago', to: 'Asia/Tokyo' },
      { from: 'Asia/Tokyo', to: null },
    ]
  );
  // Not governed: nothing is waiting for the other guardian.
  assert.equal((await env.store.listGovernanceRequests()).length, 0);
});

test('time zone: an unknown zone is rejected with a plain message and nothing changes', async (t) => {
  const { env, guardian } = await family(t);
  await guardian.post(ROUTE, { timeZone: 'America/Chicago' });
  const res = await guardian.post(ROUTE, { timeZone: 'Mars/Olympus' });
  assert.equal(res.status, 302);
  const page = await guardian.get('/admin');
  assert.match(page.body, /&#34;Mars\/Olympus&#34; is not a time zone this server knows|"Mars\/Olympus" is not a time zone/);
  assert.equal((await env.store.getSiteSetting('timeZone')).zone, 'America/Chicago');
  assert.equal((await zoneEvents(env)).length, 1);
});

test('time zone: family members are refused and never see the card', async (t) => {
  const { env } = await family(t);
  const member = env.client();
  await member.login('member@test.com');
  const res = await member.post(ROUTE, { timeZone: 'Asia/Tokyo' });
  assert.equal(res.status, 302);
  assert.notEqual(res.location, '/admin#family-settings');
  assert.equal(await env.store.getSiteSetting('timeZone'), null);
  assert.equal((await zoneEvents(env)).length, 0);
  const anon = env.client();
  await anon.post(ROUTE, { timeZone: 'Asia/Tokyo' });
  assert.equal(await env.store.getSiteSetting('timeZone'), null);
});

test('time zone: saving needs a valid CSRF token', async (t) => {
  const { env, guardian } = await family(t);
  for (const fields of [{ timeZone: 'Asia/Tokyo' }, { timeZone: 'Asia/Tokyo', _csrf: 'forged' }]) {
    const res = await guardian.post(ROUTE, fields, { csrf: false });
    assert.equal(res.status, 403);
  }
  assert.equal(await env.store.getSiteSetting('timeZone'), null);
  assert.equal((await zoneEvents(env)).length, 0);
});

test('time zone: saves are rate-limited per guardian', async (t) => {
  const { env, guardian } = await family(t);
  let last;
  for (let i = 0; i < 31; i += 1) {
    last = await guardian.post(ROUTE, { timeZone: i % 2 ? 'Asia/Tokyo' : 'America/Chicago' });
  }
  assert.equal(last.status, 429);
  assert.equal((await zoneEvents(env)).length, 30);
});

test('time zone: the invite email, the solo-delay email and the guardian reset email use the saved zone', async (t) => {
  withServerZone(t, null);
  const { env, guardian } = await family(t, { delayMs: 24 * 3600000 });
  await guardian.post(ROUTE, { timeZone: 'Asia/Tokyo' });

  // Solo delay: "It will take effect after the safety delay (<time>)".
  await guardian.post('/admin/access-codes', { intendedEmail: 'grandpa@test.com', sendEmail: 'on' });
  const [request] = await env.store.listGovernanceRequests({ status: 'pending' });
  const scheduled = env.notifier.sent.find((m) => m.subject.endsWith('A protected change is scheduled'));
  assert.ok(scheduled.text.includes(`(${formatInZone(request.executeAfter, 'Asia/Tokyo')})`), scheduled.text);
  assert.match(scheduled.text, /GMT\+9/);

  // Invite email once the code exists.
  config.governance.soloDelayMs = 0;
  await guardian.post('/admin/access-codes', { intendedEmail: 'grandma2@test.com', sendEmail: 'on' });
  const code = (await env.store.listAccessCodes()).find((c) => c.intendedEmail === 'grandma2@test.com');
  const invite = env.notifier.sent.find((m) => m.to === 'grandma2@test.com');
  const when = formatInZone(code.expiresAt, 'Asia/Tokyo');
  assert.ok(invite.text.includes(when), invite.text);
  assert.ok(invite.html.includes(when));

  // A guardian's delayed reset code says when it starts working.
  const savedReset = config.security.guardianResetDelayMs;
  config.security.guardianResetDelayMs = 24 * 3600000;
  t.after(() => {
    config.security.guardianResetDelayMs = savedReset;
  });
  const other = await seedUser(env.store, { email: 'parent3@test.com', role: 'parent', displayName: 'Lee' });
  const before = Date.now();
  await env.services.actions.issueResetCode(other.id, {});
  const reset = env.notifier.sent.find((m) => m.to === 'parent3@test.com');
  assert.match(reset.text, /It starts working in 24 hours \([^)]+GMT\+9\)/);
  assert.ok(reset.text.includes(formatInZone(before + 24 * 3600000, 'Asia/Tokyo').slice(0, 17)));
});
