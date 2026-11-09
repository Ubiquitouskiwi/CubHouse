-- Main data store for src/store/pgStore.js. Run after 001_security.sql, as
-- the MIGRATION role (owner), never as the app role:
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f deploy/sql/002_data_store.sql
--
-- Each entity is one row holding the same JSON document the in-memory store
-- keeps, plus the few columns that need a unique constraint or an index.
-- Every multi-row change runs in one transaction (see pgStore.js), and every
-- "exactly once" operation (claim an invite, decide a governance request,
-- create the media data key) locks the row it changes.
--
-- shortcut: list queries load whole tables and filter in the app. Fine for
-- one family (hundreds to low thousands of rows); add per-query SQL filters
-- and pagination before hosting many families on one database.

BEGIN;

CREATE TABLE IF NOT EXISTS app_users (
  id         text PRIMARY KEY,
  email      text NOT NULL,
  username   text,
  created_at timestamptz NOT NULL DEFAULT now(),
  doc        jsonb NOT NULL,
  CONSTRAINT app_users_email_key UNIQUE (email),
  CONSTRAINT app_users_username_key UNIQUE (username)
);

CREATE TABLE IF NOT EXISTS app_access_codes (
  id  text PRIMARY KEY,           -- the code itself
  doc jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS app_groups (
  id  text PRIMARY KEY,
  doc jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS app_photos (
  id  text PRIMARY KEY,
  doc jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS app_albums (
  id       text PRIMARY KEY,
  owner_id text NOT NULL,
  doc      jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS app_albums_owner_idx ON app_albums (owner_id);

CREATE TABLE IF NOT EXISTS app_downloads (
  id            text PRIMARY KEY,
  token         text UNIQUE,
  downloaded_at timestamptz NOT NULL,
  doc           jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS app_downloads_at_idx ON app_downloads (downloaded_at);

CREATE TABLE IF NOT EXISTS app_comments (
  id       text PRIMARY KEY,
  photo_id text NOT NULL,
  doc      jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS app_comments_photo_idx ON app_comments (photo_id);

CREATE TABLE IF NOT EXISTS app_reactions (
  id       text PRIMARY KEY,
  photo_id text NOT NULL,
  user_id  text NOT NULL,
  emoji    text NOT NULL,
  doc      jsonb NOT NULL,
  CONSTRAINT app_reactions_once UNIQUE (photo_id, user_id, emoji)
);

CREATE TABLE IF NOT EXISTS app_reports (
  id  text PRIMARY KEY,
  doc jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS app_upload_profiles (
  id  text PRIMARY KEY,
  doc jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS app_governance_requests (
  id  text PRIMARY KEY,
  doc jsonb NOT NULL
);

CREATE TABLE IF NOT EXISTS app_reset_codes (
  id  text PRIMARY KEY,           -- SHA-256 of the code; the code itself is never stored
  doc jsonb NOT NULL
);

-- Small key/value settings, e.g. the WRAPPED media data key. Insert-once:
-- the app role can never update or delete a setting (grants below), so a
-- bug or an attacker with the app's DB password cannot replace the key.
CREATE TABLE IF NOT EXISTS app_settings (
  key   text PRIMARY KEY,
  value text NOT NULL
);

CREATE TABLE IF NOT EXISTS app_auth_failures (
  key          text PRIMARY KEY,
  count        integer NOT NULL,
  locked_until bigint NOT NULL
);

-- Audit actor ids are app ids (text), matching the other tables.
ALTER TABLE security_audit_events ALTER COLUMN actor_id TYPE text;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  app_users, app_access_codes, app_groups, app_photos, app_albums, app_downloads,
  app_comments, app_reactions, app_reports, app_upload_profiles, app_governance_requests,
  app_reset_codes, app_auth_failures
TO photos_app;
GRANT SELECT, INSERT ON app_settings TO photos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON app_settings FROM photos_app;

COMMIT;
