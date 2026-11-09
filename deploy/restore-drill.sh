#!/usr/bin/env bash
# Quarterly restore drill. Proves the backup can be turned back into viewable
# photos, using ONLY the backup bucket and the guardians' offline secrets.
#
# Run it on a SCRATCH machine or droplet, never the production database:
#
#   SCRATCH_DATABASE_URL=postgres://postgres:...@127.0.0.1:5432/drill \
#   AGE_IDENTITY_FILE=/path/to/guardian-age-identity.txt \
#   APP_ENCRYPTION_KEY=<offline escrow copy> \
#   BACKUP_BUCKET=<backup bucket> BACKUP_S3CMD_CONFIG=<read-only s3cmd config> \
#   deploy/restore-drill.sh
#
# Steps: download the newest DB dump, decrypt it with age, restore it into the
# scratch database, mirror the media backup locally, then run
# scripts/verify-restore.js (audit chain + decrypt sample photos). Record the
# date and result in docs/RUNBOOK.md. Delete the scratch data afterwards.
set -euo pipefail

: "${SCRATCH_DATABASE_URL:?a THROWAWAY database to restore into}"
: "${AGE_IDENTITY_FILE:?the guardians offline age identity file}"
: "${APP_ENCRYPTION_KEY:?the offline escrow copy of APP_ENCRYPTION_KEY}"
: "${BACKUP_BUCKET:?the backup bucket}"
: "${BACKUP_S3CMD_CONFIG:?an s3cmd config that can read the backup bucket}"
SAMPLE="${DRILL_SAMPLE:-5}"

case "$SCRATCH_DATABASE_URL" in
  *prod*|*production*)
    echo "refusing: SCRATCH_DATABASE_URL looks like production" >&2
    exit 2
    ;;
esac

umask 077
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
here="$(cd "$(dirname "$0")/.." && pwd)"

latest="$(s3cmd -c "$BACKUP_S3CMD_CONFIG" ls "s3://$BACKUP_BUCKET/db/" | awk '{print $4}' | sort | tail -n 1)"
if [[ -z "$latest" ]]; then
  echo "drill FAILED: no database dumps in s3://$BACKUP_BUCKET/db/" >&2
  exit 1
fi
echo "restoring $(basename "$latest")"
s3cmd -c "$BACKUP_S3CMD_CONFIG" get "$latest" "$work/db.dump.age"
age --decrypt --identity "$AGE_IDENTITY_FILE" "$work/db.dump.age" > "$work/db.dump"
pg_restore --clean --if-exists --no-owner --no-privileges -d "$SCRATCH_DATABASE_URL" "$work/db.dump"

mkdir -p "$work/mirror/photos"
s3cmd -c "$BACKUP_S3CMD_CONFIG" sync "s3://$BACKUP_BUCKET/media/photos/" "$work/mirror/photos/"

DATABASE_URL="$SCRATCH_DATABASE_URL" node "$here/scripts/verify-restore.js" "$work/mirror" "$SAMPLE"
echo "drill ok: $(basename "$latest") restored and $SAMPLE sample photo(s) decrypted. Record today's date in docs/RUNBOOK.md."
