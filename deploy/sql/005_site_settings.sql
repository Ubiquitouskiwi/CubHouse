-- Editable site settings (today: the family time zone for emails, chosen in
-- Admin, Family settings). Run after 003_usage_metrics.sql (and 004_video.sql
-- where that is applied), as the MIGRATION role (owner), never as the app
-- role:
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f deploy/sql/005_site_settings.sql
--
-- Unlike app_settings (insert-once, holds the wrapped media key), a guardian
-- changes and clears these from the app, so the app role may update and
-- delete them. Never store keys or secrets here. A missing row means "use the
-- server default" (APP_TIME_ZONE, else UTC).
--
-- The same table the branding editor uses (feature/branding-settings), so
-- the two can share it; IF NOT EXISTS makes running both files harmless.

BEGIN;

CREATE TABLE IF NOT EXISTS app_site_settings (
  key        text PRIMARY KEY,
  value      jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON app_site_settings TO photos_app;

COMMIT;
