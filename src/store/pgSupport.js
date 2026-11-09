'use strict';

/**
 * Postgres-backed infrastructure used when DATABASE_URL is set:
 *   - a shared session store (connect-pg-simple), so sessions survive
 *     restarts and work across instances;
 *   - a shared rate-limit store, so limits hold across instances without a
 *     paid Redis.
 *
 * Loaded lazily: development without DATABASE_URL never requires `pg`.
 * Schema lives in deploy/sql/001_security.sql (applied by the migration
 * role; the app role has only the privileges listed there).
 */

let pool = null;

function getPool(databaseUrl) {
  if (!pool) {
    const { Pool } = require('pg');
    const ssl =
      process.env.PGSSLROOTCERT || process.env.DATABASE_CA_CERT
        ? {
            rejectUnauthorized: true,
            ca:
              process.env.DATABASE_CA_CERT ||
              // Operator-configured CA bundle path, never request input.
              // eslint-disable-next-line security/detect-non-literal-fs-filename
              require('fs').readFileSync(process.env.PGSSLROOTCERT, 'utf8'),
          }
        : undefined;
    // allowExitOnIdle: idle clients never keep a script or test process alive.
    pool = new Pool({ connectionString: databaseUrl, ssl, max: 10, allowExitOnIdle: true });
  }
  return pool;
}

function createPgSessionStore(session, databaseUrl) {
  const PgSession = require('connect-pg-simple')(session);
  return new PgSession({
    pool: getPool(databaseUrl),
    tableName: 'app_sessions',
    createTableIfMissing: false,
    pruneSessionInterval: 15 * 60,
  });
}

/** express-rate-limit Store backed by one upsert per hit. */
class PgRateLimitStore {
  constructor(databaseUrl, prefix) {
    this.pool = getPool(databaseUrl);
    this.prefix = `${prefix}:`;
    this.localKeys = false;
    this.windowMs = 60000;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  async increment(key) {
    const k = this.prefix + key;
    const { rows } = await this.pool.query(
      `INSERT INTO app_rate_limits (key, hits, reset_at)
         VALUES ($1, 1, now() + ($2::int * interval '1 millisecond'))
       ON CONFLICT (key) DO UPDATE SET
         hits = CASE WHEN app_rate_limits.reset_at <= now() THEN 1 ELSE app_rate_limits.hits + 1 END,
         reset_at = CASE WHEN app_rate_limits.reset_at <= now()
                         THEN now() + ($2::int * interval '1 millisecond')
                         ELSE app_rate_limits.reset_at END
       RETURNING hits, reset_at`,
      [k, this.windowMs]
    );
    return { totalHits: rows[0].hits, resetTime: new Date(rows[0].reset_at) };
  }

  async decrement(key) {
    await this.pool.query('UPDATE app_rate_limits SET hits = GREATEST(hits - 1, 0) WHERE key = $1', [this.prefix + key]);
  }

  async resetKey(key) {
    await this.pool.query('DELETE FROM app_rate_limits WHERE key = $1', [this.prefix + key]);
  }
}

module.exports = { getPool, createPgSessionStore, PgRateLimitStore };
