#!/usr/bin/env bash
# "Did last night's backup run?" check. Exits non-zero (so systemd fires the
# OnFailure= alert) when the last successful backup is older than
# BACKUP_MAX_AGE_HOURS (default 26), or has never run. This catches the
# failure the backup unit itself cannot report: the timer not firing at all.
set -euo pipefail

STATE_DIR="${BACKUP_STATE_DIR:-/var/lib/family-photos-backup}"
MAX_AGE_HOURS="${BACKUP_MAX_AGE_HOURS:-26}"
NOW="${BACKUP_CHECK_NOW:-$(date -u +%s)}"

if [[ ! -s "$STATE_DIR/last-success" ]]; then
  echo "backup check FAILED: no successful backup has ever been recorded in $STATE_DIR" >&2
  exit 1
fi
last="$(tr -dc '0-9' < "$STATE_DIR/last-success")"
if [[ -z "$last" ]]; then
  echo "backup check FAILED: $STATE_DIR/last-success is unreadable" >&2
  exit 1
fi
age_hours=$(( (NOW - last) / 3600 ))
if (( age_hours >= MAX_AGE_HOURS )); then
  echo "backup check FAILED: last successful backup was ${age_hours}h ago (limit ${MAX_AGE_HOURS}h)" >&2
  exit 1
fi
echo "backup check ok: last successful backup ${age_hours}h ago"
