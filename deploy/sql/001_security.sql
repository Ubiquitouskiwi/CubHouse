-- Security schema and least-privilege roles for the production database.
--
-- Run as the MIGRATION role (owner), never as the app role:
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f deploy/sql/001_security.sql
--
-- The app connects as photos_app, which can read and write its tables but:
--   - cannot change schema,
--   - cannot UPDATE or DELETE audit events (append-only), and can only
--     redact old details through a narrowly scoped SECURITY DEFINER function.
--
-- Connection: Managed Postgres with sslmode=verify-full and the provider CA
-- certificate (PGSSLROOTCERT). Restrict "trusted sources" to the droplet only;
-- the database is never reachable from the internet.

BEGIN;

-- Roles (passwords are set out of band: ALTER ROLE ... PASSWORD from a vault).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'photos_app') THEN
    CREATE ROLE photos_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END $$;

REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO photos_app;

-- Sessions (connect-pg-simple). Server-side, so they can be revoked.
CREATE TABLE IF NOT EXISTS app_sessions (
  sid    varchar PRIMARY KEY,
  sess   json NOT NULL,
  expire timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS app_sessions_expire_idx ON app_sessions (expire);
GRANT SELECT, INSERT, UPDATE, DELETE ON app_sessions TO photos_app;

-- Shared rate limits (replaces a paid Redis).
CREATE TABLE IF NOT EXISTS app_rate_limits (
  key      text PRIMARY KEY,
  hits     integer NOT NULL,
  reset_at timestamptz NOT NULL
);
GRANT SELECT, INSERT, UPDATE, DELETE ON app_rate_limits TO photos_app;

-- Tamper-evident audit trail. See src/audit.js for the hash chain.
CREATE TABLE IF NOT EXISTS security_audit_events (
  seq          bigint PRIMARY KEY,
  id           uuid NOT NULL UNIQUE,
  at           timestamptz NOT NULL,
  type         text NOT NULL,
  actor_id     uuid,
  target_type  text,
  target_id    text,
  details      jsonb,
  details_hash char(64) NOT NULL,
  prev_hash    char(64) NOT NULL,
  hash         char(64) NOT NULL UNIQUE,
  redacted     boolean NOT NULL DEFAULT false
);
-- Append and read only. No UPDATE, no DELETE, no TRUNCATE for the app.
GRANT SELECT, INSERT ON security_audit_events TO photos_app;
REVOKE UPDATE, DELETE, TRUNCATE ON security_audit_events FROM photos_app;

-- Belt and braces: block row changes even from a role that gains UPDATE,
-- except the retention redaction below.
CREATE OR REPLACE FUNCTION security_audit_block_changes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'security_audit_events is append-only';
  END IF;
  IF current_setting('app.audit_redaction', true) IS DISTINCT FROM 'on'
     OR NEW.seq <> OLD.seq OR NEW.hash <> OLD.hash OR NEW.prev_hash <> OLD.prev_hash
     OR NEW.details_hash <> OLD.details_hash OR NEW.type <> OLD.type OR NEW.at <> OLD.at THEN
    RAISE EXCEPTION 'security_audit_events is append-only';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS security_audit_no_changes ON security_audit_events;
CREATE TRIGGER security_audit_no_changes
  BEFORE UPDATE OR DELETE ON security_audit_events
  FOR EACH ROW EXECUTE FUNCTION security_audit_block_changes();

-- Retention: the only permitted change is dropping old DETAILS. The hashes
-- stay, so the chain still verifies (detailsHash covers what was removed).
CREATE OR REPLACE FUNCTION redact_audit_details_before(cutoff timestamptz) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n integer;
BEGIN
  PERFORM set_config('app.audit_redaction', 'on', true);
  UPDATE security_audit_events SET details = NULL, redacted = true
   WHERE at < cutoff AND NOT redacted;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE ALL ON FUNCTION redact_audit_details_before(timestamptz) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION redact_audit_details_before(timestamptz) TO photos_app;

COMMIT;
