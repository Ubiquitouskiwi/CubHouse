# Deploying on StarlingTek

StarlingTek runs each site as one container behind the host's Caddy, deploys from GitHub, and
swaps releases with zero downtime. This guide puts Cubhouse on it. The plain-server setup in
[DEPLOY.md](./DEPLOY.md) (Caddy and systemd on one box) still works and is unchanged; use one or
the other.

Do every step, in order, **before the first real photo**. Steps marked **Verify** prove the setup is
private. Examples use `photos.example.org` and the project name `family-photos`; use your own.

## How it fits

| Need | Who does it |
| --- | --- |
| TLS, routing by hostname, HTTP to HTTPS | StarlingTek's Caddy |
| Building the image | this repo's `Dockerfile` (StarlingTek always uses a repo Dockerfile) |
| Health gate and runtime probes | StarlingTek, on `GET /healthz` (liveness only, see below) |
| Config and secrets | `stk env family-photos KEY=VALUE` |
| Database | DigitalOcean managed PostgreSQL (never in the container) |
| Photos | the private media bucket (never in the container or `/data`) |
| Nightly encrypted backup, backup check, failure alerts | this repo's systemd timers, on the host |
| Security headers | the app; three StarlingTek defaults are overridden in step 6 |
| 20 MB upload cap at the edge | `stk caddy set ... maxBodyBytes` in step 6 |

**Network.** StarlingTek publishes every container port to `127.0.0.1` only (a
`-p 127.0.0.1:<port>:3000` mapping, ports 21000-21990) and puts each project on its own Docker
network; the firewall allows only 22, 80 and 443. Inside the container the image binds
`HOST=0.0.0.0`, which is required for the published port to reach it and exposes nothing beyond
loopback. Outside a container the default stays `HOST=127.0.0.1`.

**Proxy hops.** Exactly one proxy reads the client connection: Caddy. Docker's port forwarding is
not an HTTP proxy and adds no `X-Forwarded-For`. Caddy replaces any client-sent `X-Forwarded-For`
with the real client address and sets `X-Forwarded-Proto`. So `TRUST_PROXY_HOPS=1` is correct,
the same as on the plain server.

**Health.** `/healthz` returns `{"status":"ok"}` whenever the process is serving. It does not check
the database or email, on purpose: StarlingTek restarts and rolls back on failed probes, and neither
fixes a database or email outage (a rollback during a database outage would also mark good
releases bad). A new release still cannot pass the deploy gate without a working database, because
the app refuses to listen until it has connected and found the schema. Dependency health is
`/readyz` (database and email), for an external uptime monitor.

**Two copies during a swap.** For a few seconds the old and new containers both run. That is safe:
sessions and rate limits live in Postgres, the media key is insert-once, governance requests are
claimed under a row lock, the retention clean-up is idempotent, and the daily download digest is
claimed once per UTC day. The first guardian is seeded only into an empty database, which only
happens on the very first deploy, when only one container exists.

## 1. Before you start

On a trusted computer, not the server, create the secrets and keys and do the key escrow, exactly
as in [DEPLOY.md, step 1](./DEPLOY.md#1-secrets-and-keys-on-a-trusted-computer-not-the-server) and
[RUNBOOK.md, section 6](./RUNBOOK.md#6-key-escrow-do-this-before-the-first-real-photo).

## 2. DNS

Add an `A` record for `photos.example.org` pointing at the droplet. Do it before `stk add`, because
Caddy requests the certificate on the first request. Add `www` only if you want it; see
StarlingTek's "Adding a project".

## 3. Database

1. Create a DigitalOcean managed PostgreSQL 14+ cluster. Under **Trusted sources**, allow only this
   droplet.
2. Download the cluster's CA certificate (`ca-certificate.crt`).
3. Apply the schema from the droplet (it is the only trusted source). This needs the SQL files on
   the droplet: after step 5 has registered the project, do the "Host checkout" block of step 9,
   then:

   ```bash
   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f /opt/family-photos/deploy/sql/001_security.sql
   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f /opt/family-photos/deploy/sql/002_data_store.sql
   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f /opt/family-photos/deploy/sql/003_usage_metrics.sql
   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f /opt/family-photos/deploy/sql/004_video.sql
   psql "$MIGRATION_DATABASE_URL" -c "ALTER ROLE photos_app PASSWORD '<long random>'"
   ```

   `MIGRATION_DATABASE_URL` is the owner (doadmin) connection string. Type it into the shell; do not
   save it on the server. The app connects as `photos_app`, which cannot change the schema or edit
   the audit trail.

## 4. Buckets

Follow [deploy/SPACES.md](../deploy/SPACES.md) for BOTH buckets: the media bucket and the separate,
versioned backup bucket, each with its own limited key.

**Verify:** the anonymous `curl` checks in that guide return `403`.

## 5. Add the project

Register it without deploying, so the first build does not run before the settings exist (safe
boot would refuse to start, and StarlingTek would alert):

```bash
stk add https://github.com/OWNER/REPO --name family-photos --domain photos.example.org \
  --port 3000 --health /healthz --no-deploy
```

**Private repository.** The first run stops and prints a read-only deploy key. In GitHub, open the
repository's Settings, Deploy keys, Add deploy key, paste it, and leave **Allow write access**
unchecked. Then run the same `stk add` command again. `stk deploy-key family-photos` reprints the
key. A public repository needs no key.

Optionally add the webhook that `stk add` prints (GitHub, Settings, Webhooks; push events only) for
instant deploys. Without it the poller deploys within 5 minutes.

Give image and video processing room. Large photos are decoded in memory, and ffmpeg decoding a
phone's 4K HEVC clip while encoding 720p uses a few hundred MB more (the default limit is 512 MB):

```bash
stk set family-photos memoryLimit=1280m
```

Videos are processed one at a time, niced and limited to 2 threads (`VIDEO_THREADS`), so the other
sites on the droplet keep their CPU. Upload temp files and transcode scratch live in
`/data/video-work` (from `STK_DATA_DIR`), so a queued video survives a release swap; an upload is
at most 500 MB and the app refuses new ones when less than 1 GB beyond that is free.

## 6. Settings, headers and upload cap

Put the database CA certificate where the container can read it (`/data` in the container):

```bash
sudo install -D -m 0644 ca-certificate.crt /srv/starlingtek/projects/family-photos/data/do-ca-certificate.crt
```

Set the environment. Values here are placeholders: type the real ones on the server. Use no quotes
or backslashes inside values (the env file is passed through literally, and the backup units read
the same file). Quote a value with spaces or `<` `>` for the shell, as shown.

```bash
stk env family-photos APP_NAME='<site name>' PUBLIC_ORIGIN=https://photos.example.org TRUST_PROXY_HOPS=1
stk env family-photos SESSION_SECRET=<openssl rand -base64 48> APP_ENCRYPTION_KEY=<openssl rand -base64 32>
stk env family-photos DATABASE_URL='postgres://photos_app:<password>@<host>:25060/<db>?sslmode=verify-full' \
  PGSSLROOTCERT=/data/do-ca-certificate.crt
stk env family-photos MEDIA_BACKEND=spaces DO_SPACES_ENDPOINT=<region>.digitaloceanspaces.com \
  DO_SPACES_REGION=us-east-1 DO_SPACES_BUCKET=<media bucket> DO_SPACES_KEY=<key> DO_SPACES_SECRET=<secret>
stk env family-photos SMTP_URL='smtps://<user>:<pass>@<smtp host>:465' \
  NOTIFY_FROM='<site name> <no-reply@photos.example.org>'
stk env family-photos SEED_ADMIN_EMAIL=<first guardian email> SEED_ADMIN_PASSWORD=<strong one-time password>
stk env family-photos              # check: values are redacted
```

Optional: `APP_SLUG`, `APP_FOOTER_TEXT`, and the policy knobs in [.env.example](../.env.example).
StarlingTek provides `PORT`, `NODE_ENV=production`, `STK_PROJECT`, `STK_SHA` and `STK_DATA_DIR`
itself; do not set them. Keep `SEED_ADMIN_PASSWORD` set and strong after the first sign-in: safe
boot checks it on every start, and it is only ever used for an empty database.

StarlingTek's Caddy adds default security headers, and three of them would replace the app's
stricter values (its header block is deferred, so it wins over the app). Put the app's values back,
and cap request bodies at the edge (the app enforces its own 15 MB upload limit as well):

```bash
stk caddy set family-photos \
  headers='{"Referrer-Policy":"no-referrer","X-Frame-Options":"DENY","Strict-Transport-Security":"max-age=63072000; includeSubDomains"}' \
  maxBodyBytes=20MB
stk caddy get family-photos
```

The app's own `Content-Security-Policy`, `Permissions-Policy`, `X-Robots-Tag`, and cache headers
pass through untouched.

## 7. Deploy

```bash
stk deploy family-photos
stk deploys family-photos          # wait for it to succeed
stk deploy-log <id>                # it should say it used the repository Dockerfile
stk logs family-photos -f          # look for "photo site listening"
```

The app refuses to start (and says why in the logs) on any unsafe setting. Fix what it reports
with `stk env`, then `stk restart family-photos`.

## 8. First guardian

Sign in at `https://photos.example.org` as `SEED_ADMIN_EMAIL`. You must change the password, then
turn on two-step verification. **Print the ten recovery codes.** Invite the second guardian (Admin,
Invite codes) and have them do the same.

## 9. Backups and alerts (host timers)

StarlingTek runs one container per site and has no sidecars, and the app image deliberately carries
no `pg_dump`, `age`, `s3cmd` or backup keys. So the existing backup, backup-check and alert units
run on the host, reading the same env file StarlingTek gives the container.

**Host checkout** and tools. A private repository is cloned with the read-only deploy key
`stk add` already created (through StarlingTek's SSH wrapper), so it needs no second key. Do not
clone from StarlingTek's own mirror: it is a blobless partial clone.

```bash
sudo apt-get install -y age s3cmd postgresql-client   # pg_dump must be >= the cluster's major version
sudo useradd --system --home /opt/family-photos --shell /usr/sbin/nologin family-photos
sudo useradd --system --shell /usr/sbin/nologin family-photos-backup
# private repository:
sudo GIT_SSH_COMMAND=/srv/starlingtek/projects/family-photos/keys/ssh_wrapper \
  git clone git@github.com:OWNER/REPO.git /opt/family-photos
# public repository instead:  sudo git clone https://github.com/OWNER/REPO.git /opt/family-photos
cd /opt/family-photos && sudo npm ci --omit=dev       # for the alert email script
```

If Ubuntu's `postgresql-client` is older than the cluster, install the matching
`postgresql-client-NN` from the PostgreSQL apt repository.

Host-only settings (the app never reads them):

```bash
sudo install -d -m 0750 -o root -g family-photos-backup /etc/family-photos
sudo install -m 0640 -o root -g family-photos-backup /opt/family-photos/deploy/starlingtek/host.env.example /etc/family-photos/host.env
sudoedit /etc/family-photos/host.env
sudo install -m 0644 ca-certificate.crt /etc/family-photos/do-ca-certificate.crt
```

Put the two s3cmd config files (media read-only, backup read/write) and the guardians' age public
keys under `/etc/family-photos/`, readable only by `family-photos-backup` (mode 0640,
group `family-photos-backup`). The alert unit runs as `family-photos` and only needs the SMTP
settings, which systemd passes it.

Install the units (not `family-photos.service`: the app runs in its container), plus the
StarlingTek drop-in that points them at the StarlingTek env file and `host.env`:

```bash
cd /opt/family-photos
sudo cp deploy/systemd/family-photos-alert@.service \
  deploy/systemd/family-photos-backup.service deploy/systemd/family-photos-backup.timer \
  deploy/systemd/family-photos-backup-check.service deploy/systemd/family-photos-backup-check.timer \
  /etc/systemd/system/
sudo install -D -m 0644 deploy/starlingtek/env.conf /etc/systemd/system/family-photos-backup.service.d/starlingtek.conf
sudo install -D -m 0644 deploy/starlingtek/env.conf /etc/systemd/system/family-photos-alert@.service.d/starlingtek.conf
sudo systemctl daemon-reload
sudo systemctl enable --now family-photos-backup.timer family-photos-backup-check.timer
sudo systemctl start family-photos-alert@test.service     # you should get an email
sudo systemctl start family-photos-backup.service         # first backup now
journalctl -u family-photos-backup -n 20                  # "backup ok"
```

If your project is not named `family-photos`, edit the env file path in
`/etc/systemd/system/*.service.d/starlingtek.conf`. To update the scripts later, run the same
`git pull` (with `GIT_SSH_COMMAND` for a private repository) in `/opt/family-photos`, then
`sudo npm ci --omit=dev` and `sudo systemctl daemon-reload`.

Upload one throwaway test picture (not a real family photo), run the backup again, then run the
restore drill from [RUNBOOK.md, section 7](./RUNBOOK.md#7-restore-drill-quarterly-and-for-real-after-data-loss)
on a scratch machine. It must end with `drill ok`.

### StarlingTek's own backups hold the app's secrets

StarlingTek's nightly backup and `stk export` bundles include every project's env file, so they
contain `APP_ENCRYPTION_KEY`, `SESSION_SECRET` and the database and bucket credentials. This app's
design keeps the encryption key away from the encrypted backups. Keep that true:

```bash
stk config set backup.passphrase='<long random string>'   # encrypt StarlingTek backups at rest
```

and ship StarlingTek's offsite copy (`backup.remote.command`) somewhere that is **not** the
family-photos backup bucket or media bucket, with different credentials. Treat any `stk export`
bundle like the escrowed key itself.

## 10. Monitoring

Point an external uptime monitor at `https://photos.example.org/readyz` every 5 minutes, alerting on
any non-200. StarlingTek already probes `/healthz` every 30 seconds and alerts on its own channels.

## 11. Operating

| Task | Command |
| --- | --- |
| Logs | `stk logs family-photos -f` |
| Change a setting | `stk env family-photos KEY=VALUE` then `stk restart family-photos` |
| End every session (compromise) | new `SESSION_SECRET` via `stk env`, then `stk restart family-photos` |
| Roll back a bad release | `stk rollback family-photos` |
| Break-glass reset code (RUNBOOK 1b, step 4) | `sudo docker exec "$(sudo docker ps -q --filter label=dev.starlingtek.project=family-photos | head -1)" node scripts/issue-reset-code.js you@example.org` |

The RUNBOOK's commands that use `/etc/family-photos/app.env` or `journalctl -u family-photos`
map to `stk env` and `stk logs` here.

## 12. Verification checklist

- [ ] Anonymous bucket checks return 403 (both buckets)
- [ ] `curl -s https://photos.example.org/healthz` returns exactly `{"status":"ok"}`
- [ ] `curl -s https://photos.example.org/readyz` returns `"database":"ok"` and `"email":"ok"`
- [ ] `curl -sI https://photos.example.org/login` shows `Referrer-Policy: no-referrer`,
      `X-Frame-Options: DENY`, `Strict-Transport-Security: max-age=63072000`, a
      `Content-Security-Policy`, and `X-Robots-Tag: noindex, ...`
- [ ] `curl -sI http://photos.example.org/` redirects to https
- [ ] On the droplet, `sudo ss -ltnp | grep 210` shows the container port on `127.0.0.1` only, and
      from another computer `curl -m 5 http://<droplet ip>:21000/` fails
- [ ] An upload over 20 MB is rejected
- [ ] `stk status family-photos` is healthy, and a second `stk deploy family-photos --force` swaps
      without errors and without a duplicate download-summary email
- [ ] Both guardians have 2FA on and printed recovery codes
- [ ] Key escrow done (two offline copies), recorded in the RUNBOOK
- [ ] Alert email received from `family-photos-alert@test`
- [ ] Backup ran (`backup ok`) and the restore drill passed, with its date recorded
- [ ] StarlingTek `backup.passphrase` set and its offsite target separate from the app's buckets
- [ ] Uptime monitor on `/readyz`

Only then upload real photos.
