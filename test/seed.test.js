'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { makeStore } = require('./storeFactory');
const { seedAccounts } = require('../src/server');
const config = require('../src/config');

// seedAccounts reads config.seed.testAccountsEnabled (the real key; an earlier
// version read a non-existent `config.seedTestAccounts`, and this test set that
// same wrong key, hiding the bug). Toggle and restore around each case.
function withTestAccounts(enabled, fn) {
  const original = config.seed.testAccountsEnabled;
  config.seed.testAccountsEnabled = enabled;
  return Promise.resolve(fn()).finally(() => {
    config.seed.testAccountsEnabled = original;
  });
}

test('seedAccounts creates parent, dev, and user when test accounts are on', async () => {
  await withTestAccounts(true, async () => {
    const store = await makeStore();
    await seedAccounts(store);
    assert.equal((await store.findUserByEmail(config.seedAdmin.email)).role, 'parent');
    assert.equal((await store.findUserByEmail(config.seedDev.email)).role, 'dev');
    assert.equal((await store.findUserByEmail(config.seedUser.email)).role, 'user');
  });
});

test('seedAccounts seeds only the parent when test accounts are off', async () => {
  await withTestAccounts(false, async () => {
    const store = await makeStore();
    await seedAccounts(store);
    const users = await store.listUsers();
    assert.equal(users.length, 1);
    assert.equal(users[0].role, 'parent');
  });
});

test('seedAccounts is idempotent and does not overwrite a changed password', async () => {
  await withTestAccounts(true, async () => {
    const store = await makeStore();
    await seedAccounts(store);
    const dev = await store.findUserByEmail(config.seedDev.email);
    await store.updateUser(dev.id, { passwordHash: 'changed-by-user' });
    await seedAccounts(store);
    const devAfter = await store.findUserByEmail(config.seedDev.email);
    assert.equal(devAfter.id, dev.id);
    assert.equal(devAfter.passwordHash, 'changed-by-user');
    assert.equal((await store.listUsers()).length, 3);
  });
});

test('test accounts are never enabled in production, whatever the env says', () => {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync(
    process.execPath,
    ['-e', "console.log(require('./src/config').seed.testAccountsEnabled)"],
    { env: { PATH: process.env.PATH, NODE_ENV: 'production', SEED_TEST_ACCOUNTS: 'true' }, encoding: 'utf8' }
  );
  assert.equal(out.trim(), 'false');
});

test('the seeded guardian must change the default password at first production sign-in', async () => {
  const saved = config.isProduction;
  config.isProduction = true;
  try {
    const store = await makeStore();
    await seedAccounts(store);
    assert.equal((await store.findUserByEmail(config.seedAdmin.email)).mustChangePassword, true);
  } finally {
    config.isProduction = saved;
  }
});
