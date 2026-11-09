'use strict';

/**
 * Create the support operator account (the site developer's account for the
 * Support page: unlock an account, reset a password, reset two-step
 * verification). This is the ONLY way to create one; the web app cannot
 * create the role or grant it to anyone. Runs on the server with the app's
 * env file:
 *
 *   sudo -u family-photos bash -c 'set -a; . /etc/family-photos/app.env; set +a; \
 *     node scripts/create-operator.js support@example.org "Site developer"'
 *
 * Prints a temporary password once. At first sign-in the account must choose
 * a new password and turn on two-step verification before it can do anything.
 * The guardians are emailed, and it is recorded in the audit trail as
 * "operator.created" with actor "System".
 */

const { createStore } = require('../src/store');
const { createNotifier } = require('../src/notify');
const { createOperatorAccount } = require('../src/services/support');
const { audit } = require('../src/audit');
const config = require('../src/config');

async function main(email, displayName) {
  if (!email) {
    process.stderr.write('usage: node scripts/create-operator.js <email> ["Display name"]\n');
    return 2;
  }
  const store = createStore();
  if (store.kind === 'memory') {
    process.stderr.write('DATABASE_URL is not set: load the env file first.\n');
    return 2;
  }
  await store.init();
  const created = await createOperatorAccount(store, config, { email, displayName });
  if (!created.ok) {
    process.stderr.write(`${created.message}\n`);
    return 1;
  }
  await audit(store, null, 'operator.created', {
    targetType: 'user',
    targetId: created.user.id,
    details: { via: 'operator-cli' },
  });
  await createNotifier().notifyGuardians(store, {
    subject: 'A support account was created',
    text:
      `The site's developer created a support account (${created.user.displayName}) on the server. ` +
      'It can unlock accounts and reset passwords or two-step verification, and cannot see photos. ' +
      'Every use is emailed to you and recorded in the audit trail. You can remove it in Admin, Members.',
  });
  process.stdout.write(
    `${created.tempPassword}\n` +
      `Temporary password for ${created.user.email}, valid until ${created.expiresAt}. Sign in, choose a new ` +
      'password, then turn on two-step verification.\n'
  );
  return 0;
}

main(process.argv[2], process.argv[3]).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`failed: ${err.message}\n`);
    process.exit(1);
  }
);
