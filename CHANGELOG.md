# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Videos, phase 1. Phone clips (MP4/MOV, H.264 or HEVC, up to 3:00) go in the same bulk uploader
  as photos, with Waiting, Uploading %, Processing, then Added / Sent for approval / Failed with a
  plain reason. Videos upload in 8 MB chunks to a per-upload session (each chunk authenticated and
  CSRF-checked; resumes after a dropped connection; 500 MB cap; idle sessions expire and their temp
  files are deleted), are checked by magic bytes and ffprobe, and are processed by a background job
  queue in the database (one at a time, niced, 2 threads, retried a limited number of times) into
  720p H.264/AAC with every metadata tag removed, location included. The original is deleted. The
  stored copy is encrypted in 1 MiB AES-256-GCM segments and streamed with HTTP Range support.
  The gallery shows a poster with a play button and the length.
- Downloads are off for videos: no button, a short note, and the server refuses them.
- Migration `deploy/sql/004_video.sql` (table `app_video_jobs`). Run it before deploying.
- The image now installs Debian's `ffmpeg` package (`--no-install-recommends`), which makes it
  larger by an estimated 250-400 MB; measure with `docker image ls` after the first build. CI
  installs ffmpeg so the video tests run.
- Family time zone for emails: times written into emails are now in the family's time zone with
  the zone named, for example "Fri, Nov 13, 2026, 4:46 PM EST", instead of UTC. That covers the
  invite code's expiry, the solo safety delay's "takes effect" time (in the guardian email and on
  the Admin page), and when a guardian's delayed reset code starts working. A guardian picks the
  zone in Admin, **Family settings** (searchable list, "Use my current time zone", live example);
  any one guardian can change it, it is not governed, and each change is audit-logged as
  `settings.time_zone` (old and new zone). `APP_TIME_ZONE` (an IANA zone such as
  `America/New_York`) is now only the default when no guardian has chosen one; with neither, UTC.
  Stored in a new `app_site_settings` table: apply `deploy/sql/005_site_settings.sql`.
- Bulk photo upload on Home: pick or drag in many photos, three upload at a time, each with its own
  status (waiting, uploading %, saving, added or failed with a plain reason), Retry and Cancel per
  photo and for all, an end summary with a link to the new photos, and a warning before leaving
  mid-upload. Videos, HEIC and oversized files fail at once, before upload. With JavaScript off the
  form still uploads one photo.
- `POST /photos/upload` answers JSON (`{ ok, photo }` or `{ ok: false, error: { code, message } }`)
  when asked with `Accept: application/json`. So do the rate limiter and the error handler (codes
  `rate_limited`, `expired`, `signed_out`, `server_error`). All existing auth, CSRF, rate-limit
  and file checks are unchanged.
- Invite codes can be emailed. On **Invite a family member**, tick **Email the code to the address
  above** (optionally with a first name). The email goes out when the code is created: on the other
  guardian's approval, or after the solo safety delay. Nothing is sent if the request is declined,
  cancelled or expires. Open codes also get a **Send by email** action. The email is HTML plus plain
  text in the site's palette, with light and dark modes, and it loads nothing remote. The Join link
  carries the code in the URL fragment, so it stays out of server logs; the sign-up page only
  prefills it and validation is unchanged. Sends are rate-limited per guardian (10 an hour) and
  audited as `invite.emailed` with a masked address, never the code. Without working email the
  form says so and the code is still shown.

### Fixed

- Password managers no longer put the email into the authenticator code box on Confirm it is you,
  turning off two-step verification, support confirmations and the settings password forms. Those
  forms carry a hidden sign-in name (the account's email) before the password, which the server
  ignores, and the code boxes are marked as one-time codes. Confirm boxes (DELETE, ERASE, support
  words), reset codes and access codes tell password managers to leave them empty.

### Security

- Removing a guardian now needs the other guardian's approval, and nobody can approve their own
  governance request. Before, one guardian could remove the other and then approve their own
  pending requests, including erasing the archive. The removed guardian is emailed.
- Sharing a photo with every member by name, or with groups covering most of the family, now needs
  the other guardian, the same as sharing with "everyone".
- Development mode refuses to start in an environment that looks deployed. Production never
  creates a new media key when photos already exist.
- Turning on two-step verification needs a recent password confirmation.

### Added

- Two-step verification setup shows a QR code that any authenticator app can scan. It is drawn on
  the server as inline SVG (`qrcode` 1.5.4) and appears only on the signed-in user's own setup
  page until setup is confirmed. The setup key stays available under "Can't scan? Enter this key",
  with a copy button.
- Support operator account for the site's developer, created only with
  `node scripts/create-operator.js`. It must use two-step verification and can open only the
  Support page: unlock an account, reset a password (temporary password shown once, changed at
  sign-in) or reset two-step verification. Each action needs a typed confirmation and a fresh
  authenticator code, and is audited and announced to the person and the guardians. It cannot see
  family content or act on itself or another operator, and guardians can remove it.
- PostgreSQL data store (`src/store/pgStore.js`, `deploy/sql/002_data_store.sql`). The whole test
  suite runs against it with `npm run test:pg`, and in CI.
- Account recovery: guardian-issued one-time reset codes (delayed and cancellable for guardians),
  ten one-time two-step recovery codes, and re-inviting a removed member's email.
- Backups of both the database and the encrypted media to a separate bucket, systemd timers, a
  "backup did not run" check, failure email alerts, and a restore drill that decrypts sample photos.
- Email delivery self-check at startup and every 6 hours; `/healthz` reports database and email
  status for external uptime monitoring.
- `APP_NAME` (default "Cubhouse", a placeholder), `APP_SLUG` and `APP_DOMAIN` settings.
- A real-names guard (`scripts/check-forbidden-names.js`) for tracked files, paths and commit
  messages: a CI job reading the `FORBIDDEN_NAMES` secret, plus pre-commit and commit-msg hooks
  reading a names file outside the repository. The names are never stored in the repository.
- Deployment guide, key escrow, restore, lost-phone and forgotten-password procedures.
- License (AGPL-3.0-only), security policy, contributing guide, code of conduct, issue and pull
  request templates, CodeQL, secret scanning, dependency review, OpenSSF Scorecard, and Dependabot.

- User guide (`docs/guide/`), published to the GitHub wiki by `.github/workflows/wiki-sync.yml`
  (`scripts/wiki-sync.js`) whenever it changes on `main`.
- Production `Dockerfile` (multi-stage, Debian slim, non-root, `HEALTHCHECK`) and `.dockerignore`.
- StarlingTek deployment guide (`docs/DEPLOY-STARLINGTEK.md`) and a systemd drop-in so the backup
  and alert units run on a StarlingTek host (`deploy/starlingtek/`).

### Changed

- Product name, file names, cookie, invite-code prefix (`INVITE-`), systemd units
  (`family-photos*`), paths (`/etc/family-photos`, `/opt/family-photos`) and the database role
  (`photos_app`) are now generic.
- `deploy/SPACES.md`: the bucket policy step is correctly described as denying non-TLS access.
- `/healthz` is now liveness only (`{"status":"ok"}`, no database or email check), for platform
  health gates that restart or roll back on failure. The database and email check moved to
  `/readyz`; point external uptime monitors there.
- The server drains and exits cleanly on SIGTERM. Development mode accepts a wildcard `HOST` only
  inside the container image (`APP_IN_CONTAINER=true`), and refuses to run under StarlingTek.

### Fixed

- On phones the header now wraps, so the account menu button is no longer off screen under the
  nav and Settings, Security and Sign out can be reached. The menu is a plain disclosure button
  (`aria-expanded`, `aria-controls`): opening it from the keyboard moves focus to the first link,
  and Escape or tabbing away closes it.

- The daily download digest is sent once per UTC day. Before, every boot sent one a minute after
  starting, and two instances running side by side during a deploy swap each sent their own.

## [0.1.0]

### Added

- Initial private family photo site: upload sanitization, private-by-default audiences, envelope
  encryption, traced downloads, two-guardian governance, two-step sign-in, audit trail, safe boot.
