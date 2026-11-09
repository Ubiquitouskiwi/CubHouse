<p align="center">
  <img src="docs/assets/cubhouse-logo.svg" alt="Cubhouse logo: a bear cub peeking out of a den" width="128" height="128">
</p>

# Cubhouse

**A private, invite-only photo site for a child's family. You host it yourself; nobody else sees the photos.**

<!-- Before publishing: replace OWNER/REPO in this file, CONTRIBUTING.md, docs/DEPLOY.md and
     .github/ISSUE_TEMPLATE/config.yml with the real repository (git grep -n OWNER/REPO). -->
Each deployment can show its own site name: set `APP_NAME` (it defaults to "Cubhouse").

[![CI](https://github.com/OWNER/REPO/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/OWNER/REPO/actions/workflows/ci.yml)
[![CodeQL](https://github.com/OWNER/REPO/actions/workflows/codeql.yml/badge.svg?branch=main)](https://github.com/OWNER/REPO/actions/workflows/codeql.yml)
[![Secret scan](https://github.com/OWNER/REPO/actions/workflows/gitleaks.yml/badge.svg?branch=main)](https://github.com/OWNER/REPO/actions/workflows/gitleaks.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/OWNER/REPO/badge)](https://scorecard.dev/viewer/?uri=github.com/OWNER/REPO)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)
![Status: pre-release](https://img.shields.io/badge/status-pre--release-orange.svg)
![Node 20+](https://img.shields.io/badge/node-20%2B-brightgreen.svg)
![No ads, no analytics, no third parties](https://img.shields.io/badge/privacy-no_third_parties-2e8b6e.svg)

Cubhouse lets a child's parents (the "guardians") share photos with the relatives they invite,
without handing those photos to a social network. There are no ads, no analytics, and no requests
to any third party. Every photo is private until a guardian chooses who sees it, and the files are
encrypted before they reach storage. It is a small Node.js app (Express, server-rendered pages)
that one family runs on one small server.

> [!IMPORTANT]
> **Pre-release.** The privacy and security controls below run and are tested, but the production
> path (PostgreSQL store, private bucket, email, Caddy, systemd, backups) has not yet been run
> against real infrastructure. Do not put real photos of a child on it until you have completed
> the checks in [docs/DEPLOY.md](./docs/DEPLOY.md), including a restore drill.

## Why

Sharing photos of a child usually means sharing them with a platform: its ads, its data
practices, its employees, and anyone it gets breached by. A family chat leaks the moment one phone
is lost or one photo is forwarded. Cubhouse is for parents who want relatives to see the
photos, and nobody else, with a clear record of who did what.

## What it does

- **Photos are stripped at upload.** Every image is decoded and re-encoded from pixels, so GPS
  coordinates, device serial numbers, owner names and all other metadata are gone.
- **Private by default.** New photos are visible to guardians only. Guardians choose who sees each
  photo: everyone, named people, or groups such as "Grandparents".
- **Encrypted at rest, served only after a permission check.** Media is encrypted with a data key
  that is itself wrapped by a key kept out of the database. Images are never public URLs.
- **Downloads are off by default, and traced when on.** Each download is logged and marked with an
  opaque reference and a visible watermark, so a leaked copy can be traced to who downloaded it.
- **Two-guardian control.** Restricting is always instant. Widening who can see photos, inviting
  people, changing roles, removing a guardian, or erasing the archive needs the other guardian.
- **Instant removal.** "Remove and revoke" ends someone's sessions on their next request.
- **Strong sign-in, with a way back.** Two-step verification (required for guardians), lockouts,
  breached-password checks, one-time recovery codes, and guardian-issued reset codes.
- **Audit trail.** A hash-chained, append-only record of every sensitive action.
- **The child's archive.** Full export, and erasure that needs both guardians.

## Threat model in brief

The people most likely to misuse a child's photos are usually people who were invited. The design
assumes:

| Who | What they might try | What stops it |
| --- | --- | --- |
| A relative who falls out with the family | Keep watching, or find where the child lives | Instant removal; GPS stripped from every photo |
| One guardian acting against the other | Share widely, or delete everything, alone | Two-guardian approval for widening and destructive actions |
| A family member who leaks photos | Repost a photo publicly | Downloads off by default; traced and watermarked when on |
| Someone with a stolen password | Browse the archive | Two-step sign-in, lockouts, new-device alerts |
| A forwarded invite | A stranger joins | Single-use, expiring invites, optionally bound to one email |
| Someone holding a copy of the bucket or database | Read the photos | Envelope encryption; the key-encryption key lives elsewhere |

The full analysis and the control-by-control plan are in
[docs/SECURITY_PRIVACY_PLAN.md](./docs/SECURITY_PRIVACY_PLAN.md).

## Status

| | |
| --- | --- |
| Privacy and security controls | Implemented, covered by automated tests |
| Data store | PostgreSQL (`src/store/pgStore.js`), tested in CI; in-memory store for development |
| Media storage | Any S3-compatible private bucket (written for DigitalOcean Spaces) |
| Deployment | Not deployed. Caddy, systemd, backup and restore files are in `deploy/` |
| Screenshots | Not yet added (they must use the generated sample photos, never real ones) |

## Quick start (development, no cost, no secrets)

Requires Node 20.19 or newer.

```bash
git clone https://github.com/OWNER/REPO.git
cd REPO
npm ci
npm run dev        # http://localhost:3000 (binds to 127.0.0.1 only)
```

Development runs entirely in memory: no database, no bucket, no email (notifications are printed
to the console). Nothing is kept when it stops. `npm run dev` seeds made-up accounts and generated
sample pictures, never real ones:

| Role | Email | Password |
| --- | --- | --- |
| Guardian | `parent@example.com` | `changeme-dev-only-123` |
| Developer | `dev@example.com` | `devpass-dev-only-123` |
| Family member | `user@example.com` | `userpass-dev-only-123` |

Development mode refuses to start if the environment looks like a deployment (behind a proxy, on a
public `https` address, or on a non-loopback interface).

Run the checks CI runs:

```bash
npm run check      # lint, tests, Postgres tests (skipped without a database), dependency audit
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/photos_test npm run test:pg
```

## Self-hosting

One small Linux server, a managed (or local) PostgreSQL database, two private S3-compatible
buckets (media and backups), an SMTP provider, and Caddy for automatic HTTPS. Step by step:
[docs/DEPLOY.md](./docs/DEPLOY.md). Operations, recovery and incident steps:
[docs/RUNBOOK.md](./docs/RUNBOOK.md).

On a StarlingTek host (one container per site behind its Caddy), the repository's `Dockerfile` is
used as-is; follow [docs/DEPLOY-STARLINGTEK.md](./docs/DEPLOY-STARLINGTEK.md). Other container
hosts work the same way: publish the container port to `127.0.0.1` only and put a TLS proxy in
front. Health: `/healthz` is liveness (for a platform health gate), `/readyz` checks the database
and email (for an uptime monitor).

Production refuses to start on any unsafe configuration: weak or missing secrets, no database,
in-memory sessions, local media storage, a missing proxy hop count, guardians without required
two-step sign-in, or a developer account present.

### Configuration

Everything is set through environment variables. [`.env.example`](./.env.example) lists them all.
The main ones:

| Variable | Required in production | Purpose |
| --- | --- | --- |
| `APP_NAME` | no (default `Cubhouse`) | Name shown to the family. Set it in your env file, not in code. |
| `APP_SLUG` | no (default `family-photos`) | Lower-case id for file names, logs and backups |
| `APP_DOMAIN` | yes (Caddy) | Your domain, read by `deploy/Caddyfile` |
| `APP_FOOTER_TEXT` | no (a generic line) | The one line shown in every page footer |
| `HOST` | no (default `127.0.0.1`) | Bind address. Keep loopback outside a container; the Docker image sets `0.0.0.0` and must be published to `127.0.0.1` only |
| `TRUST_PROXY_HOPS` | yes (`1` behind one Caddy) | Proxies in front of the app; used for `req.ip` and Secure cookies |
| `PUBLIC_ORIGIN` | yes | `https://your.domain`, used in email links |
| `SESSION_SECRET` | yes | `openssl rand -base64 48` |
| `APP_ENCRYPTION_KEY` | yes | `openssl rand -base64 32`. Keep offline copies: losing it loses every photo. |
| `DATABASE_URL` | yes | PostgreSQL, `sslmode=verify-full` |
| `MEDIA_BACKEND`, `DO_SPACES_*` | yes | The private media bucket |
| `SMTP_URL`, `NOTIFY_FROM`, `ALERT_EMAIL` | yes | Guardian notifications and operator alerts. Email subjects start with `[APP_NAME]`; `NOTIFY_FROM` defaults to `APP_NAME <no-reply@localhost>` |
| `BACKUP_BUCKET`, `AGE_RECIPIENTS_FILE`, `*_S3CMD_CONFIG` | yes | Encrypted backups |

## How it works

```
Browser ──HTTPS──> Caddy (TLS, headers) ──loopback──> Node app ──> PostgreSQL (records, wrapped key, audit)
                                                          └──────> private bucket (encrypted media only)
Nightly: backup.sh ──> separate backup bucket (age-encrypted DB dump + encrypted media mirror)
```

- `src/permissions.js` is the single source of truth for who may see or do what.
- `src/media/` sanitizes, encrypts and serves images; `src/governance.js` handles two-guardian
  approval; `src/audit.js` keeps the hash chain.
- Every request reloads the user from the database, so removal and role changes take effect at once.

## Repository layout

```
src/            app: routes, permissions, media pipeline, security middleware, stores, views
public/         CSS, self-hosted fonts, small page scripts
deploy/         Caddyfile, systemd units (app, backup, checks, alerts), SQL schema, bucket guide,
                backup and restore scripts, StarlingTek host drop-in (deploy/starlingtek/)
Dockerfile      production container image (non-root, HEALTHCHECK on /healthz)
scripts/        test runner for Postgres, restore verifier, alert sender, operator reset tool
docs/           security and privacy plan, deployment guide, runbook, privacy risk note
test/           node:test suites (run against the memory store, and Postgres in CI)
```

## Contributing

Bug reports, reviews of the security model, and fixes are welcome. Start with
[CONTRIBUTING.md](./CONTRIBUTING.md) and follow the [Code of Conduct](./CODE_OF_CONDUCT.md).
Report vulnerabilities privately as described in [SECURITY.md](./SECURITY.md), not in public
issues. **Never put real photos, names, or personal details in issues, tests, or screenshots.**

## License

Copyright (C) 2026 Cubhouse contributors.

[GNU Affero General Public License v3.0 only](./LICENSE). Anyone who runs a modified version as a
service must share their changes. Bundled fonts are under the SIL Open Font License
(`public/fonts/`).

## Disclaimer

This software is provided as is, without warranty. You are responsible for how you deploy it, who
you invite, and the photos you store. Read [docs/PRIVACY_RISK_NOTE.md](./docs/PRIVACY_RISK_NOTE.md)
before inviting anyone.
