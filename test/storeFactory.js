'use strict';

/**
 * Which data store the suite runs against.
 *
 *   default                      MemoryStore (no setup, runs anywhere)
 *   TEST_DATABASE_URL=postgres…  PgStore against a THROWAWAY database. Each
 *                                makeStore() empties every app table first.
 *
 * `npm run test:pg` runs the same suite against Postgres, one file at a time
 * (the files share one database). CI does this with a Postgres service
 * container; locally it skips with a message when no database is set.
 * Never point TEST_DATABASE_URL at a real family database.
 */

const { MemoryStore } = require('../src/store/memoryStore');

const PG_TABLES = [
  'app_users',
  'app_access_codes',
  'app_groups',
  'app_photos',
  'app_albums',
  'app_downloads',
  'app_comments',
  'app_reactions',
  'app_reports',
  'app_upload_profiles',
  'app_governance_requests',
  'app_reset_codes',
  'app_settings',
  'app_auth_failures',
  'app_sessions',
  'app_rate_limits',
  'app_usage_daily',
  'security_audit_events',
];

const pgUrl = process.env.TEST_DATABASE_URL || '';

let pgStore = null;

/** A fresh, empty store of the kind selected for this run. */
async function makeStore() {
  if (!pgUrl) {
    return new MemoryStore();
  }
  const { PgStore } = require('../src/store/pgStore');
  if (!pgStore) {
    pgStore = new PgStore(pgUrl);
    await pgStore.init();
  }
  await pgStore.pool.query(`TRUNCATE ${PG_TABLES.join(', ')}`);
  return pgStore;
}

module.exports = { makeStore, usingPostgres: Boolean(pgUrl) };
