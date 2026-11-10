'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { startApp, seedFamily } = require('./helpers');
const { createNotifier } = require('../src/notify');
const { buildInviteEmail, joinLink } = require('../src/services/inviteEmail');
const { INVITE_EMAILS_PER_HOUR } = require('../src/security/rateLimiters');

const INVITEE = 'grandpa@test.com';
const MASKED = 'g\u2022\u2022\u2022@test.com';

const inviteMails = (env) => env.notifier.sent.filter((m) => m.to === INVITEE);

async function twoGuardians(t, options) {
  const env = await startApp(options);
  t.after(env.close);
  const people = await seedFamily(env, { twoGuardians: true });
  const a = env.client();
  const b = env.client();
  await a.login('parent@test.com');
  await b.login('parent2@test.com');
  return { env, a, b, ...people };
}

async function oneGuardian(t, { delayMs = 0, ...options } = {}) {
  const saved = config.governance.soloDelayMs;
  config.governance.soloDelayMs = delayMs;
  t.after(() => {
    config.governance.soloDelayMs = saved;
  });
  const env = await startApp(options);
  t.after(env.close);
  await seedFamily(env);
  const p = env.client();
  await p.login('parent@test.com');
  return { env, p };
}

const askToEmail = (client, extra = {}) =>
  client.post('/admin/access-codes', { intendedEmail: INVITEE, sendEmail: 'on', firstName: 'Grandpa', ...extra });

test('invite email: HTML and text carry the code, a correct join link and nothing external', () => {
  const code = 'INVITE-ABCD-EFGH-JKLM';
  const msg = buildInviteEmail({
    appName: 'Cubhouse',
    origin: 'https://photos.example.org/',
    code,
    inviterName: 'Pat <b>',
    firstName: 'Grandpa',
    expiresAt: new Date(Date.now() + 72 * 3600000).toISOString(),
  });
  assert.equal(msg.subject, "You're invited to join Cubhouse");
  assert.equal(msg.link, `https://photos.example.org/register#code=${code}`);
  assert.equal(joinLink('https://x.example', code), `https://x.example/register#code=${code}`);
  for (const body of [msg.html, msg.text]) {
    assert.ok(body.includes(code), 'code missing');
    assert.ok(body.includes(msg.link), 'join link missing');
    assert.match(body, /Grandpa/);
    assert.match(body, /expires in about 3 days/);
    assert.match(body, /weren't expecting this, you can ignore it|weren&#39;t expecting this, you can ignore it/);
  }
  assert.match(msg.html, /Join Cubhouse/);
  // The inviter's name is escaped, never raw HTML.
  assert.ok(msg.html.includes('Pat &lt;b&gt;'));
  assert.ok(!msg.html.includes('Pat <b>'));
  // Nothing is fetched when the email opens: no images, fonts, stylesheets.
  assert.doesNotMatch(msg.html, /<img|<link|@import|url\(|src=|background=/i);
  const urls = msg.html.match(/https?:\/\/[^"'\s<)]+/g) || [];
  assert.ok(urls.length > 0);
  assert.ok(urls.every((u) => u.startsWith('https://photos.example.org/register')), urls.join(' '));
  // Dark mode is supported where the client allows it.
  assert.match(msg.html, /prefers-color-scheme: dark/);
  assert.match(msg.html, /name="color-scheme" content="light dark"/);
});

test('invite email: without a first name it greets generically', () => {
  const msg = buildInviteEmail({ appName: 'Cubhouse', origin: 'http://localhost:3000', code: 'INVITE-AAAA-BBBB-CCCC' });
  assert.match(msg.text, /^Hi there,/);
  assert.match(msg.text, /A guardian has invited you/);
});

test('two guardians: the code is emailed only when the other guardian approves', async (t) => {
  const { env, a, b } = await twoGuardians(t);
  await askToEmail(a);
  assert.equal(inviteMails(env).length, 0, 'emailed before approval');
  const [request] = await env.store.listGovernanceRequests({ status: 'pending' });
  assert.equal(request.payload.sendEmail, true);
  assert.doesNotMatch(request.summary, /grandpa@/, 'full address in the summary');
  // The other guardian sees who the code is for in the approval list.
  const page = await b.get('/admin');
  assert.match(page.body, /Invite code for <strong>grandpa@test\.com<\/strong>/);
  // Guardian notification emails never carry the full address.
  assert.ok(env.notifier.sent.filter((m) => m.to !== INVITEE).every((m) => !m.text.includes(INVITEE)));

  await b.post(`/admin/governance/${request.id}/approve`);
  const [code] = await env.store.listAccessCodes();
  const [mail] = inviteMails(env);
  assert.ok(mail, 'not emailed after approval');
  assert.equal(mail.subject, `You're invited to join ${config.app.name}`);
  assert.ok(mail.text.includes(code.code));
  assert.ok(mail.html.includes(code.code));
  assert.match(mail.text, /Pat has invited you/);
  assert.match(mail.text, /Hi Grandpa,/);
  assert.equal(code.intendedEmail, INVITEE, 'an emailed code is bound to the address');
});

for (const [label, act] of [
  ['declined', ({ b, request }) => b.post(`/admin/governance/${request.id}/decline`)],
  ['cancelled', ({ a, request }) => a.post(`/admin/governance/${request.id}/decline`)],
  ['expired', ({ env }) => env.services.governance.runDue(Date.now() + config.governance.requestTtlMs + 1000)],
]) {
  test(`two guardians: an invite request that was ${label} sends nothing`, async (t) => {
    const { env, a, b } = await twoGuardians(t);
    await askToEmail(a);
    const [request] = await env.store.listGovernanceRequests({ status: 'pending' });
    await act({ env, a, b, request });
    assert.notEqual((await env.store.findGovernanceRequest(request.id)).status, 'pending');
    assert.equal((await env.store.listAccessCodes()).length, 0);
    assert.equal(inviteMails(env).length, 0);
  });
}

test('one guardian: the code is emailed when the safety delay runs out (runDue)', async (t) => {
  const { env, p } = await oneGuardian(t, { delayMs: 60 * 60 * 1000 });
  await askToEmail(p);
  assert.equal(await env.services.governance.runDue(Date.now()), 0);
  assert.equal(inviteMails(env).length, 0, 'emailed before the delay');
  assert.equal(await env.services.governance.runDue(Date.now() + 2 * 60 * 60 * 1000), 1);
  const [code] = await env.store.listAccessCodes();
  const [mail] = inviteMails(env);
  assert.ok(mail && mail.text.includes(code.code));
  // The background job has no request, so the audit names who asked.
  const events = await env.store.listSecurityAuditEvents();
  const emailed = events.find((e) => e.type === 'invite.emailed');
  assert.equal(emailed.details.to, MASKED);
  assert.ok(emailed.details.requestedBy);
});

test('audit: "invite emailed" carries a masked address and never the code', async (t) => {
  const { env, p } = await oneGuardian(t);
  await askToEmail(p);
  const [code] = await env.store.listAccessCodes();
  const events = await env.store.listSecurityAuditEvents();
  const emailed = events.filter((e) => e.type === 'invite.emailed');
  assert.equal(emailed.length, 1);
  assert.equal(emailed[0].details.to, MASKED);
  const all = JSON.stringify(events);
  assert.ok(!all.includes(code.code), 'code in the audit trail');
  assert.ok(!all.includes(INVITEE), 'full address in the audit trail');
  const page = await p.get('/admin');
  assert.match(page.body, /It was emailed to g\u2022\u2022\u2022@test\.com/);
});

test('invite emails are rate-limited per guardian', async (t) => {
  const { env, a, b } = await twoGuardians(t);
  for (let i = 0; i < INVITE_EMAILS_PER_HOUR; i += 1) {
    const res = await askToEmail(a);
    assert.equal(res.status, 302);
  }
  const limited = await askToEmail(a);
  assert.equal(limited.status, 429);
  // Codes without an email are not limited, and the other guardian has their own bucket.
  assert.equal((await a.post('/admin/access-codes', { note: 'no email' })).status, 302);
  assert.equal((await askToEmail(b)).status, 302);
  assert.equal((await env.store.listGovernanceRequests({ status: 'pending' })).length, INVITE_EMAILS_PER_HOUR + 2);
});

test('asking to email without an address is refused', async (t) => {
  const { env, p } = await oneGuardian(t);
  await p.post('/admin/access-codes', { sendEmail: 'on' });
  assert.equal((await env.store.listAccessCodes()).length, 0);
  assert.match((await p.get('/admin')).body, /Add their email address to send them the code/);
});

test('without working email the form says so and the code is still created and shown', async (t) => {
  const { env, p } = await oneGuardian(t, { notifier: createNotifier({ transport: 'console' }) });
  const form = await p.get('/admin');
  assert.match(form.body, /Email is not set up on this server/);
  assert.doesNotMatch(form.body, /name="sendEmail"/);
  await askToEmail(p);
  const [code] = await env.store.listAccessCodes();
  assert.ok(code, 'code not created');
  const page = await p.get('/admin');
  assert.ok(page.body.includes(`Invite code created: ${code.code}`));
  assert.match(page.body, /code was not emailed/);
  assert.ok(!(await env.store.listSecurityAuditEvents()).some((e) => e.type === 'invite.emailed'));
});

test('"Send by email" sends an open code, to its bound address only', async (t) => {
  const { env, p } = await oneGuardian(t);
  await p.post('/admin/access-codes', { intendedEmail: INVITEE });
  await p.post('/admin/access-codes', { note: 'unbound' });
  const codes = await env.store.listAccessCodes();
  const bound = codes.find((c) => c.intendedEmail);
  const unbound = codes.find((c) => !c.intendedEmail);
  assert.match((await p.get('/admin')).body, /Send by email/);

  // A bound code ignores any other address.
  await p.post(`/admin/access-codes/${bound.code}/email`, { email: 'someone@else.test' });
  assert.equal(inviteMails(env).length, 1);
  assert.ok(!env.notifier.sent.some((m) => m.to === 'someone@else.test'));

  await p.post(`/admin/access-codes/${unbound.code}/email`, { email: 'not-an-email' });
  assert.ok(!env.notifier.sent.some((m) => m.html && m.text.includes(unbound.code)));
  await p.post(`/admin/access-codes/${unbound.code}/email`, { email: 'Cousin@Test.com' });
  assert.ok(env.notifier.sent.some((m) => m.to === 'cousin@test.com' && m.text.includes(unbound.code)));

  // Revoked codes cannot be emailed.
  await p.post(`/admin/access-codes/${bound.code}/revoke`);
  await p.post(`/admin/access-codes/${bound.code}/email`);
  assert.equal(inviteMails(env).length, 1);
});

test('family members cannot email codes', async (t) => {
  const { env, p } = await oneGuardian(t);
  await p.post('/admin/access-codes', { intendedEmail: INVITEE });
  const [code] = await env.store.listAccessCodes();
  const m = env.client();
  await m.login('member@test.com');
  await m.post(`/admin/access-codes/${code.code}/email`);
  assert.equal(inviteMails(env).length, 0);
});

test('an SMTP failure log line masks the recipient address', async (t) => {
  const { logger } = require('../src/logger');
  const lines = [];
  const original = logger.error;
  logger.error = (obj, msg) => lines.push({ obj, msg });
  const savedUrl = config.notifications.smtpUrl;
  config.notifications.smtpUrl = 'smtp://127.0.0.1:1';
  t.after(() => {
    logger.error = original;
    config.notifications.smtpUrl = savedUrl;
  });
  const notifier = createNotifier({
    transport: 'smtp',
    createTransport: () => ({
      sendMail: async () => {
        throw new Error(`550 5.1.1 <${INVITEE}>: Recipient address rejected`);
      },
    }),
  });
  assert.equal(notifier.emailAvailable(), true);
  await assert.rejects(notifier.sendEmail({ to: INVITEE, subject: 's', text: 't', html: '<p>t</p>' }));
  assert.equal(lines.length, 1);
  assert.ok(!JSON.stringify(lines).includes(INVITEE));
  assert.match(lines[0].obj.err.message, /\[address\]/);
});

test('a failed send is reported and the code stays', async (t) => {
  const smtp = createNotifier({ transport: 'memory' });
  smtp.sendEmail = async () => {
    throw new Error(`550 <${INVITEE}>: rejected`);
  };
  const { env, p } = await oneGuardian(t, { notifier: smtp });
  await askToEmail(p);
  const [code] = await env.store.listAccessCodes();
  assert.ok(code);
  assert.match((await p.get('/admin')).body, /could not be emailed \(sending failed\)/);
  const failed = (await env.store.listSecurityAuditEvents()).find((e) => e.type === 'invite.email_failed');
  assert.equal(failed.details.to, MASKED);
});
