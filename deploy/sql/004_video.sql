-- Video processing jobs (src/store/videoJobs.js, src/jobs/videoQueue.js).
-- Run after 003_usage_metrics.sql, as the MIGRATION role (owner), never as
-- the app role, BEFORE deploying the release that adds videos (the app
-- refuses to start without this table):
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f deploy/sql/004_video.sql
--
-- One row per uploaded video while it is processed: queued -> running ->
-- done | failed. The job survives restarts and release swaps; a job whose
-- lease ran out is retried a limited number of times, then marked failed.
-- The doc holds the uploader's id and name, the caption, the original's size
-- and duration, and the outcome (photo id or a reason code). No file names,
-- no location, nothing from the file's metadata. Finished rows are deleted by
-- the daily retention job after 7 days.
--
-- Videos themselves are rows in app_photos (doc.kind = 'video'); no change
-- is needed there.

BEGIN;

CREATE TABLE IF NOT EXISTS app_video_jobs (
  id         text PRIMARY KEY,
  owner_id   text NOT NULL,
  status     text NOT NULL CHECK (status IN ('queued', 'running', 'done', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  doc        jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS app_video_jobs_status_idx ON app_video_jobs (status);
CREATE INDEX IF NOT EXISTS app_video_jobs_owner_idx ON app_video_jobs (owner_id, created_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON app_video_jobs TO photos_app;

COMMIT;
