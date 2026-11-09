# Deploying Cubhouse

An ordered guide for one family on one small Linux server (any provider; examples use DigitalOcean
names). Do every step, in order, **before the first real photo**. The steps marked **Verify** are
the ones that prove the setup is private.

You will need: a domain, a Linux server (Ubuntu LTS, 1 GB RAM is enough), a PostgreSQL database,
two private S3-compatible buckets (media and backups), and an SMTP provider. Install `node` (20.19+),
`caddy`, `pg_dump`/`pg_restore`, `age`, and `s3cmd` on the server.

## 1. Secrets and keys (on a trusted computer, not the server)

```bash
openssl rand -base64 48   # SESSION_SECRET
openssl rand -base64 32   # APP_ENCRYPTION_KEY
age-keygen -o guardian-age-identity.txt   # backup key pair; keep the identity OFFLINE
```

Follow **docs/RUNBOOK.md, section 6 (Key escrow)** now: two offline copies of
`APP_ENCRYPTION_KEY` and the age identity, one per guardian. Only the age PUBLIC key (the
`# public key:` line) goes on the server.

## 2. Database

1. Create a PostgreSQL 14+ database. Allow connections only from your server ("trusted sources").
2. As the owner (migration) role, apply the schema:

   ```bash
   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f deploy/sql/001_security.sql
   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f deploy/sql/002_data_store.sql
   psql "$MIGRATION_DATABASE_URL" -c "ALTER ROLE photos_app PASSWORD '<long random>'"
   ```

3. The app connects as `photos_app` with `sslmode=verify-full` and the provider's CA certificate
   (`PGSSLROOTCERT`). `photos_app` cannot change the schema or edit the audit trail.

## 3. Buckets

Follow [deploy/SPACES.md](../deploy/SPACES.md) for BOTH buckets: the media bucket and the separate,
versioned backup bucket, each with its own limited key.

**Verify:** the anonymous `curl` checks in that guide return `403`.

## 4. Server

```bash
sudo useradd --system --home /opt/family-photos --shell /usr/sbin/nologin family-photos
sudo useradd --system --shell /usr/sbin/nologin family-photos-backup
sudo git clone https://github.com/OWNER/REPO.git /opt/family-photos
cd /opt/family-photos && sudo npm ci --omit=dev
sudo install -d -m 0750 -o root -g family-photos /etc/family-photos
sudo install -m 0640 -o root -g family-photos .env.example /etc/family-photos/app.env
sudoedit /etc/family-photos/app.env   # fill in every production value (see the README table)
```

Set at least: `NODE_ENV=production`, `APP_NAME`, `PUBLIC_ORIGIN`, `SESSION_SECRET`,
`APP_ENCRYPTION_KEY`, `DATABASE_URL`, `PGSSLROOTCERT`, `MEDIA_BACKEND=spaces`, `DO_SPACES_*`,
`SMTP_URL`, `NOTIFY_FROM`, `ALERT_EMAIL`, `SEED_ADMIN_EMAIL`, a strong one-time
`SEED_ADMIN_PASSWORD`, and the backup keys. Put the two s3cmd config files and the age recipients
file under `/etc/family-photos/`, readable only by `family-photos-backup`.

## 5. Services

```bash
sudo cp deploy/systemd/*.service deploy/systemd/*.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now family-photos
journalctl -u family-photos -n 50     # look for "photo site listening"
```

The app refuses to start (and says why) on any unsafe setting. Fix what it reports.

## 6. HTTPS (Caddy)

```bash
sudo cp deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl edit caddy     # add:  [Service]  Environment=APP_DOMAIN=photos.example.org
sudo systemctl restart caddy
```

**Verify** from another computer:

```bash
curl -sI https://photos.example.org/login | grep -iE 'strict-transport|content-security|x-frame'
curl -s  https://photos.example.org/healthz      # {"status":"ok"} (liveness)
curl -s  https://photos.example.org/readyz       # {"status":"ok","database":"ok","email":"ok"}
curl -sI http://photos.example.org/ | head -1    # a redirect to https
```

The app itself must not be reachable directly: `curl http://<server-ip>:3000/` from outside must
fail.

## 7. First guardian

Sign in as `SEED_ADMIN_EMAIL`. You must change the password, then turn on two-step verification.
**Print the ten recovery codes.** Invite the second guardian (Admin, Invite codes) and have them do
the same.

## 8. Backups, alerts, and the restore drill

```bash
sudo systemctl enable --now family-photos-backup.timer family-photos-backup-check.timer
sudo systemctl start family-photos-alert@test.service     # you should get an email
sudo systemctl start family-photos-backup.service         # first backup now
journalctl -u family-photos-backup -n 20                  # "backup ok"
```

Upload one throwaway test picture (not a photo of the child), run the backup again, then run the
restore drill from **docs/RUNBOOK.md, section 7** on a scratch machine. It must end with `drill ok`.

## 9. Monitoring

Point an external uptime monitor at `https://photos.example.org/readyz` (every 5 minutes, alert
on any non-200). See **docs/RUNBOOK.md, Monitoring**.

## 10. Go-live checklist

- [ ] Anonymous bucket checks return 403 (both buckets)
- [ ] HTTPS headers verified; port 3000 not reachable from outside
- [ ] Both guardians have 2FA on and printed recovery codes
- [ ] Key escrow done (two offline copies), recorded in the RUNBOOK
- [ ] Alert email received from `family-photos-alert@test`
- [ ] Restore drill passed and its date recorded
- [ ] Uptime monitor on `/readyz`

Only then upload real photos.
