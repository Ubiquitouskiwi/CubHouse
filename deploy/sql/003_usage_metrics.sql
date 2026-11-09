-- Usage metrics for the guardian-only Usage page (src/usage.js). Run after
-- 002_data_store.sql, as the MIGRATION role (owner), never as the app role:
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f deploy/sql/003_usage_metrics.sql
--
-- Aggregate daily rollups ONLY: one number per (UTC day, metric name). There
-- is no account id, IP address, user agent, URL or per-person row anywhere in
-- this table. Metric names come from a fixed list in src/usage.js, e.g.
--   logins                  sign-ins that day
--   section.<name>          requests in one of a few named site sections
--   active7.all / active30.all / active1.all
--                           accounts that signed in during the 7/30/1 days
--                           before that day's snapshot (counted from the
--                           existing users.lastLoginAt, not a new record)
--   accounts.all            accounts that existed at that day's snapshot
-- Rows older than USAGE_RETENTION_DAYS (400, about 13 months) are deleted by
-- the daily retention job.

BEGIN;

CREATE TABLE IF NOT EXISTS app_usage_daily (
  day    date    NOT NULL,
  metric text    NOT NULL CHECK (metric ~ '^[a-z0-9]+(\.[a-z0-9]+)?$' AND char_length(metric) <= 40),
  value  integer NOT NULL CHECK (value >= 0),
  PRIMARY KEY (day, metric)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON app_usage_daily TO photos_app;

COMMIT;
