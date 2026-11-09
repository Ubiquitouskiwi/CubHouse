# Incident runbook

One page for the worst day. Keep a printed copy with the guardians.

## Contacts

| Role | Who | How |
|---|---|---|
Fill this in on your PRINTED copy only. Do not commit real names or phone
numbers to the repository.

| Role | Who | How |
|---|---|---|
| Guardian 1 | (name) | (phone) |
| Guardian 2 | (name) | (phone) |
| Hosting account owner | (name) | Hosting console, MFA on |
| Email provider account | (name) | Provider console |
| Who gets `ALERT_EMAIL` | (name) | (email) |

## 1. Someone should not have access (fastest path)

1. Sign in as a guardian, open **Admin, Members**, choose **Remove and revoke**.
   Their sessions end on their very next request; their group memberships and
   any invite codes they created are revoked.
2. Open **Admin, Invite codes** and revoke any open codes you did not expect.
3. If a guardian account itself is compromised, the OTHER guardian removes it.
   If you cannot sign in at all, go to step 3 below.

## 1a. A family member forgot their password, or lost their phone

1. Confirm it is really them (call them; do not trust an email or text).
2. **Admin, Members, Reset sign-in** next to their name. The page shows a
   one-time code like `RESET-ABCD-EFGH-JKMN`. It works once, for 24 hours.
3. Read it to them by phone or in person. Never send it by email or text.
4. They open `/reset` (the "Use a reset code from a parent" link on the
   sign-in page), enter their email, the code, and a new password. This also
   turns off two-step verification and signs out their other devices.

## 1b. A guardian lost their phone (two-step codes)

1. First try a **recovery code**: each guardian was shown ten when they
   turned on two-step verification. Type one in place of the 6-digit code.
   Then make new ones under Settings, Security.
2. No recovery codes? The OTHER guardian uses **Reset sign-in** on them. For
   a guardian the code only starts working after 24 hours, and the locked-out
   guardian is emailed at once and can cancel it. This is on purpose: it stops
   one guardian from quietly taking over the other's account.
3. After 24 hours, follow 1a step 4. Turn two-step verification back on
   right away (the site requires it for guardians) and save the new codes.
4. If you are the ONLY guardian and have no recovery codes, there is no
   in-app path. Whoever runs the server issues a code there:

   ```bash
   sudo -u family-photos bash -c 'set -a; . /etc/family-photos/app.env; set +a; cd /opt/family-photos; \
     node scripts/issue-reset-code.js you@example.org'
   ```

   It is recorded in the audit trail. Add a second guardian, and print your
   recovery codes, to avoid needing this.

## 2. A photo appeared somewhere it should not be

1. Save a copy of the file exactly as found (do not screenshot it yourself).
2. **Photos, Download history, Trace a copy you found**: upload it. The hidden
   reference resolves to who downloaded it and when.
3. If it was screenshotted, read the "Ref" code printed in the corner and find
   it in the Download history table.
4. Remove that member (section 1). Ask the platform to take the copy down.

## 3. Suspected server or account compromise

1. **Rotate `SESSION_SECRET`** in `/etc/family-photos/app.env` and restart:
   `sudo systemctl restart family-photos`. Every session everywhere ends.
2. Rotate the **database password** (`ALTER ROLE photos_app PASSWORD ...`) and
   the **Spaces access key** (create a new limited key, update the env file,
   delete the old key).
3. **Do not rotate `APP_ENCRYPTION_KEY`.** There is no rotation tool yet.
   The key seals two things: the wrapped media data key (one row in
   `app_settings`) AND every member's two-step secret. Changing the env value
   alone makes every photo AND every authenticator unreadable, and the app
   refuses to start with photos but an unusable key. If you believe the key
   leaked, the photos are still safe from anyone who lacks the database and
   the bucket as well; rotate the database password and the Spaces keys
   (step 2), keep the old `APP_ENCRYPTION_KEY`, and treat building a rotation
   tool as the follow-up.
4. **Preserve evidence before changing anything else:** export the audit trail
   (Admin, Audit trail; check the integrity banner), copy
   `/var/log/caddy/photos-access.log` and `journalctl -u family-photos`.
5. Check the audit trail integrity banner. A failed check means the database
   was modified outside the app: treat the database as compromised.

## 4. Tell the family (within 72 hours of knowing)

Decide with this tree:

- Were photos, or members' emails, possibly seen by someone outside the
  family? **Yes:** message every member plainly: what happened, what was
  affected, what we did, what they should do (change password, delete
  downloaded copies). **No:** record the decision and reason in the audit notes.
- Are any members in the EU or UK? Their data protection law may require
  notifying the regulator within 72 hours if there is a risk to them.
- US state breach laws may apply to members' emails and passwords.
- For images of the child, consider whether a report to the platform where
  they appeared, or to the NCMEC CyberTipline, is appropriate.

## 5. Afterward

Write a short review: timeline, cause, what worked, what to change. Add any
new control to `docs/SECURITY_PRIVACY_PLAN.md` with a test that proves it.

## 6. Key escrow (do this before the first real photo)

Three secrets are needed to get the photos back, and they are kept apart on
purpose. Losing `APP_ENCRYPTION_KEY` and every copy of it makes every photo
permanently unreadable. There is no recovery.

| Secret | What it unlocks | Where the copies live |
|---|---|---|
| `APP_ENCRYPTION_KEY` | Unwraps the media data key (stored, wrapped, in the database) and the 2FA secrets | `/etc/family-photos/app.env` on the server, plus **two offline copies**, one per guardian |
| `age` identity (private key) | Decrypts the database dumps | **Offline only**, one copy per guardian. Never on the server. |
| Backup bucket key | Reads the backups | Password manager of each guardian |

Procedure:

1. Print `APP_ENCRYPTION_KEY` and the `age` identity on paper (or write them
   to two encrypted USB drives). Do not email them, photograph them, or keep
   them in the same place as each other's copy.
2. Each guardian keeps one set in a separate safe place (home safe, deposit
   box). Label them "Family photos recovery, keep private".
3. Confirm both copies work by running the restore drill (section 7) with
   them, not with the server's copy.
4. Write the date and where each copy is (not the values) here:
   Guardian 1: ____  Guardian 2: ____

## 7. Restore (drill quarterly, and for real after data loss)

Use `deploy/restore-drill.sh` on a scratch machine, never on the production
database. It downloads the newest database dump from the backup bucket,
decrypts it with the offline `age` identity, restores it into a throwaway
database, mirrors the media backup, then runs `scripts/verify-restore.js`.
That checks the audit chain and decrypts sample photos end to end with the
offline `APP_ENCRYPTION_KEY`.

```bash
SCRATCH_DATABASE_URL=postgres://postgres:<pw>@127.0.0.1:5432/drill \
AGE_IDENTITY_FILE=/media/usb/guardian-age-identity.txt \
APP_ENCRYPTION_KEY='<offline copy>' \
BACKUP_BUCKET=<backup bucket> BACKUP_S3CMD_CONFIG=~/.s3cfg-backup-readonly \
deploy/restore-drill.sh
```

It must end with `drill ok`. Any failure is a real finding: fix it before
the next photo upload. Afterwards drop the scratch database and delete the
downloaded files.

For a real restore, follow the same steps but restore into the new
production database, apply `deploy/sql/*.sql` first, copy the media mirror
back into the media bucket (`s3cmd sync`), put the escrowed
`APP_ENCRYPTION_KEY` in the env file, then start the app. The app refuses
to start with photos but no media key, which means the `app_settings`
table did not restore.

## Monitoring

- Point a free external uptime monitor at `https://<your domain>/readyz`
  every 5 minutes, alerting your phone on any non-200. It returns
  `{"status","database","email"}` and nothing else: no data, no error text.
  It turns 503 when the database is unreachable, or when email delivery is
  failing (email carries every security alert and approval request).
- `/healthz` is liveness only (`{"status":"ok"}` while the process serves).
  It is what a platform health gate or a Docker `HEALTHCHECK` should probe,
  because restarting the app cannot fix a database or email outage.
- The app checks email delivery at boot and every 6 hours; a failure is
  logged (`journalctl -u family-photos`) and shows on `/readyz`.

## Routine checks

- Daily (automatic): `family-photos-backup.timer` runs the backup at 03:15 and
  `family-photos-backup-check.timer` checks at 09:00 that it succeeded. Either one
  failing emails `ALERT_EMAIL`. Test the alert path once after install:
  `sudo systemctl start family-photos-alert@test.service`.
- Monthly: review Admin, Audit trail and Download history.
- Quarterly: **restore drill** (section 7). Date and result: ____
- Yearly: re-read `docs/PRIVACY_RISK_NOTE.md` and the privacy notice.
