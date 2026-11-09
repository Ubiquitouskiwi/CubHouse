#!/usr/bin/env bash
# Nightly encrypted backup of BOTH halves of the archive:
#
#   1. the database (users, photo records, audit trail, and the WRAPPED media
#      data key), dumped and encrypted with `age` to the guardians' public
#      key(s), uploaded to a separate private backup bucket;
#   2. the media objects (already AES-256-GCM ciphertext from the app),
#      mirrored to that backup bucket. The backup bucket MUST have
#      versioning on with noncurrent versions expiring after 30 days
#      (deploy/SPACES.md, "Backup bucket"). A photo deleted in the app then
#      stays recoverable from the backup for 30 days, and is gone after that,
#      which is what the privacy notice promises.
#
# Run by systemd (deploy/systemd/family-photos-backup.timer), which loads the
# env file. When run by hand it loads the env file itself.
#
# Restoring needs three things kept apart on purpose: this backup bucket, the
# guardians' offline `age` identity, and the offline copy of
# APP_ENCRYPTION_KEY. See docs/RUNBOOK.md, "Restore".
#
# Requires: pg_dump, age, s3cmd.
set -euo pipefail

ENV_FILE="${APP_ENV_FILE:-/etc/family-photos/app.env}"
if [[ -z "${DATABASE_URL:-}" && -r "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

: "${DATABASE_URL:?set DATABASE_URL in the env file}"
: "${BACKUP_BUCKET:?set BACKUP_BUCKET (a separate private bucket) in the env file}"
: "${AGE_RECIPIENTS_FILE:?set AGE_RECIPIENTS_FILE (the guardians age public keys) in the env file}"
: "${DO_SPACES_BUCKET:?set DO_SPACES_BUCKET (the media bucket) in the env file}"
# s3cmd config files: one with READ access to the media bucket, one with
# WRITE access to the backup bucket. Separate keys, so the app's key cannot
# delete backups.
: "${MEDIA_S3CMD_CONFIG:?path to an s3cmd config that can read the media bucket}"
: "${BACKUP_S3CMD_CONFIG:?path to an s3cmd config that can write the backup bucket}"

STATE_DIR="${BACKUP_STATE_DIR:-/var/lib/family-photos-backup}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
PREFIX="${APP_SLUG:-family-photos}"

umask 077
mkdir -p "$STATE_DIR/media-mirror"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

# --- 1. Database -----------------------------------------------------------
dump="$work/$PREFIX-$stamp.dump.age"
pg_dump --format=custom --no-owner --no-privileges "$DATABASE_URL" \
  | age --encrypt --recipients-file "$AGE_RECIPIENTS_FILE" > "$dump"
if [[ ! -s "$dump" ]]; then
  echo "backup FAILED: empty database dump" >&2
  exit 1
fi
s3cmd -c "$BACKUP_S3CMD_CONFIG" put --acl-private "$dump" "s3://$BACKUP_BUCKET/db/$(basename "$dump")"

# --- 2. Media (ciphertext), incremental; deletions become 30-day versions ----
s3cmd -c "$MEDIA_S3CMD_CONFIG" sync --delete-removed "s3://$DO_SPACES_BUCKET/photos/" "$STATE_DIR/media-mirror/photos/"
s3cmd -c "$BACKUP_S3CMD_CONFIG" sync --delete-removed --acl-private \
  "$STATE_DIR/media-mirror/photos/" "s3://$BACKUP_BUCKET/media/photos/"

# --- 3. Database dump retention (the bucket lifecycle rule is the backstop) --
cutoff="$(date -u -d "$RETENTION_DAYS days ago" +%Y%m%d 2>/dev/null || date -u -v-"$RETENTION_DAYS"d +%Y%m%d)"
s3cmd -c "$BACKUP_S3CMD_CONFIG" ls "s3://$BACKUP_BUCKET/db/" | awk '{print $4}' | while read -r obj; do
  day="$(basename "$obj" | sed -E 's/^.*-([0-9]{8})T[0-9]{6}Z\.dump\.age$/\1/')"
  if [[ "$day" =~ ^[0-9]{8}$ && "$day" < "$cutoff" ]]; then
    s3cmd -c "$BACKUP_S3CMD_CONFIG" del "$obj"
  fi
done

# --- 4. Proof of life for deploy/backup-check.sh ------------------------------
date -u +%s > "$STATE_DIR/last-success"
echo "backup ok: $(basename "$dump") and media mirror"
