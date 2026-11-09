'use strict';

/**
 * Operator break-glass: issue a one-time sign-in reset code from the server,
 * for when NO guardian can sign in (a single guardian who lost their phone
 * and their recovery codes). Runs on the server with the app's env file:
 *
 *   sudo -u family-photos bash -c 'set -a; . /etc/family-photos/app.env; set +a; \
 *     node scripts/issue-reset-code.js guardian@example.org'
 *
 * Prints the code once. The account owner is NOT emailed by this script
 * (whoever runs it already has the server). It is recorded in the audit
 * trail as "account.reset_issued" with actor "System".
 */

const { createStore } = require('../src/store');
const { createActions } = require('../src/services/actions');
const { audit } = require('../src/audit');
const config = require('../src/config');

async function main(email) {
  if (!email) {
    process.stderr.write('usage: node scripts/issue-reset-code.js <account email>\n');
    return 2;
  }
  const store = createStore();
  if (store.kind === 'memory') {
    process.stderr.write('DATABASE_URL is not set: load the env file first.\n');
    return 2;
  }
  await store.init();
  const user = await store.findUserByEmail(email);
  if (!user) {
    process.stderr.write('No account with that email.\n');
    return 1;
  }
  // No notifier and no delay: the operator is acting directly.
  const actions = createActions({ store, media: null, config: { ...config, security: { ...config.security, guardianResetDelayMs: 0 } } });
  const issued = await actions.issueResetCode(user.id, { issuedBy: null });
  if (!issued.ok) {
    process.stderr.write(`${issued.message}\n`);
    return 1;
  }
  await audit(store, null, 'account.reset_issued', { targetType: 'user', targetId: user.id, details: { via: 'operator-cli' } });
  process.stdout.write(`${issued.code}\nIt works once, for ${Math.round(config.security.resetCodeTtlMs / 3600000)} hours, at /reset.\n`);
  return 0;
}

main(process.argv[2]).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`failed: ${err.message}\n`);
    process.exit(1);
  }
);
