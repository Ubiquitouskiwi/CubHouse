'use strict';

/**
 * Run the whole test suite against PostgreSQL (src/store/pgStore.js).
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/family_photos_test npm run test:pg
 *
 * The database must be THROWAWAY: every test empties every app table. The
 * schema (deploy/sql/*.sql) is applied first. Without TEST_DATABASE_URL this
 * exits 0 with a clear "skipped" message, so `npm run check` stays usable on
 * a laptop with no Postgres. CI always sets it (see .github/workflows/ci.yml).
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

async function main() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    process.stdout.write(
      'SKIPPED: Postgres store tests (set TEST_DATABASE_URL to a throwaway database to run them; CI always does).\n'
    );
    return 0;
  }
  const { Client } = require('pg');
  const client = new Client({ connectionString: url });
  await client.connect();
  const dir = path.join(__dirname, '..', 'deploy', 'sql');
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    // Fixed files from this repository, applied in name order.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
    process.stdout.write(`applied ${file}\n`);
  }
  await client.end();
  // One file at a time: the test files share this one database.
  const run = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'test/**/*.test.js'], {
    stdio: 'inherit',
    env: { ...process.env, TEST_DATABASE_URL: url },
  });
  return run.status === null ? 1 : run.status;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`test:pg failed: ${err.message}\n`);
    process.exit(1);
  }
);
