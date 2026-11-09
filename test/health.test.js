'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const config = require('../src/config');
const { createNotifier } = require('../src/notify');
const { startApp, seedFamily, rawRequest } = require('./helpers');

function smtpNotifier({ verifyFails = false, sendFails = false } = {}) {
  const sent = [];
  const createTransport = () => ({
    verify: async () => {
      if (verifyFails) {
        throw new Error('connect ECONNREFUSED smtp.example.org:465 user@example.org');
      }
      return true;
    },
    sendMail: async (m) => {
      if (sendFails) {
        throw new Error('550 rejected');
      }
      sent.push(m);
    },
  });
  return { notifier: createNotifier({ transport: 'smtp', createTransport }), sent };
}

test('startup email check reports ok, or failing without throwing', async () => {
  const good = smtpNotifier();
  assert.equal(await good.notifier.verify(), 'ok');
  const bad = smtpNotifier({ verifyFails: true });
  assert.equal(await bad.notifier.verify(), 'failing');
  assert.ok(bad.notifier.status().lastFailureAt);
  assert.equal(await createNotifier({ transport: 'memory' }).verify(), 'not_configured');
});

test('a failed send marks email as failing; a later success clears it', async () => {
  let fail = true;
  const createTransport = () => ({
    verify: async () => true,
    sendMail: async () => {
      if (fail) {
        throw new Error('550 rejected');
      }
    },
  });
  const notifier = createNotifier({ transport: 'smtp', createTransport });
  await notifier.notifyUser({ email: 'a@test.com' }, { subject: 's', text: 't' });
  assert.equal(notifier.status().email, 'failing');
  fail = false;
  await notifier.notifyUser({ email: 'a@test.com' }, { subject: 's', text: 't' });
  assert.equal(notifier.status().email, 'ok');
});

test('/readyz is public, uncached, and carries no personal data or error text', async (t) => {
  const { notifier } = smtpNotifier({ verifyFails: true });
  await notifier.verify();
  const env = await startApp({ notifier });
  t.after(env.close);
  await seedFamily(env);
  const res = await rawRequest(env.base, '/readyz');
  assert.equal(res.status, 200, 'development: failing email does not fail health');
  const body = JSON.parse(res.body);
  assert.deepEqual(Object.keys(body).sort(), ['database', 'email', 'status']);
  assert.equal(body.email, 'failing');
  assert.match(res.headers['cache-control'], /no-store/);
  assert.doesNotMatch(res.body, /@|ECONNREFUSED|parent|test\.com/);
});

test('/readyz returns 503 when email is failing in production, or the database is down', async (t) => {
  const { notifier } = smtpNotifier({ verifyFails: true });
  await notifier.verify();
  const env = await startApp({ notifier });
  t.after(env.close);
  const saved = config.isProduction;
  config.isProduction = true;
  t.after(() => {
    config.isProduction = saved;
  });
  assert.equal((await rawRequest(env.base, '/readyz')).status, 503);
  config.isProduction = saved;

  const ok = await startApp();
  t.after(ok.close);
  assert.equal((await rawRequest(ok.base, '/readyz')).status, 200);
  ok.store.ping = async () => {
    throw new Error('connection refused');
  };
  const down = await rawRequest(ok.base, '/readyz');
  assert.equal(down.status, 503);
  assert.equal(JSON.parse(down.body).database, 'failing');
});

test('/healthz is liveness only: 200 while the database and email are down', async (t) => {
  const { notifier } = smtpNotifier({ verifyFails: true });
  await notifier.verify();
  const env = await startApp({ notifier });
  t.after(env.close);
  const saved = config.isProduction;
  config.isProduction = true;
  t.after(() => {
    config.isProduction = saved;
  });
  env.store.ping = async () => {
    throw new Error('connection refused');
  };
  const res = await rawRequest(env.base, '/healthz');
  assert.equal(res.status, 200);
  assert.deepEqual(JSON.parse(res.body), { status: 'ok' });
  assert.match(res.headers['cache-control'], /no-store/);
  assert.equal(res.headers['set-cookie'], undefined, 'no session is created');
});
