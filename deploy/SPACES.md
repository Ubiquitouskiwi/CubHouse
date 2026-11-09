# Private media bucket (DigitalOcean Spaces)

Photos of the child live here, encrypted by the app before upload (envelope
encryption, see `src/media/keyring.js`). The bucket must still be private:
defense in depth, not either/or.

## Create and lock down

Create the bucket in the region where the family lives (EU region if family
members are in the EU or UK). Then apply all of the following **before the
first real photo is uploaded**, and verify the anonymous denial.

1. **File listing: Restricted.** In the Spaces settings, keep "File Listing"
   restricted (private).
2. **No CDN.** Do not enable the Spaces CDN for this bucket. The app serves
   every image itself after an authorization check.
3. **Deny non-TLS access.** Anonymous reads are already refused by the
   private object ACLs the app writes and the restricted listing (step 1),
   proven by the 403 check below; this policy additionally refuses any request over plain
   HTTP. Apply with `s3cmd setpolicy` or the AWS CLI against the Spaces
   endpoint:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       {
         "Sid": "DenyNonTLS",
         "Effect": "Deny",
         "Principal": "*",
         "Action": "s3:*",
         "Resource": ["arn:aws:s3:::BUCKET", "arn:aws:s3:::BUCKET/*"],
         "Condition": { "Bool": { "aws:SecureTransport": "false" } }
       }
     ]
   }
   ```

   Objects are written with `ACL: private` by the app; never grant public-read.
4. **Versioning on, with noncurrent versions expiring.** The app deletes
   every version when a photo is deleted, and this lifecycle rule is the
   backstop so nothing deleted survives longer than 30 days:

   ```json
   {
     "Rules": [
       {
         "ID": "expire-noncurrent",
         "Status": "Enabled",
         "Filter": { "Prefix": "photos/" },
         "NoncurrentVersionExpiration": { "NoncurrentDays": 30 },
         "AbortIncompleteMultipartUpload": { "DaysAfterInitiation": 1 }
       }
     ]
   }
   ```

5. **A dedicated access key** scoped to this one bucket (Spaces "limited
   access" keys), stored only in `/etc/family-photos/app.env`.

## Verify (required before upload)

From any machine, with no credentials:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://BUCKET.REGION.digitaloceanspaces.com/
curl -s -o /dev/null -w '%{http_code}\n' https://BUCKET.REGION.digitaloceanspaces.com/photos/
```

Both must return `403`. A `200` means stop: fix the bucket before any photo is
stored. After the first upload, fetch one object key anonymously and confirm
`403` again, then confirm the stored bytes are ciphertext (they do not start
with the JPEG marker `ffd8ff`).

## Backup bucket

`deploy/backup.sh` writes the encrypted database dumps (`db/`) and a mirror
of the encrypted media (`media/photos/`) to a SECOND private bucket. Set it up
the same way as the media bucket (restricted listing, no CDN, private ACLs,
the non-TLS deny policy, the anonymous 403 check), plus:

1. **Different region or provider** from the media bucket if you can, so one
   outage or account problem cannot take both.
2. **Versioning on**, with the same 30-day noncurrent expiry rule as above
   (Prefix `""` so it covers `db/` and `media/`). Deleting a photo in the app
   then leaves a recoverable copy in the backup for 30 days, and none after.
3. **Two separate limited keys**, each in its own s3cmd config file readable
   only by the `family-photos-backup` user:
   - `MEDIA_S3CMD_CONFIG`: READ-only on the media bucket;
   - `BACKUP_S3CMD_CONFIG`: read/write on the backup bucket only.
   The app's own key never touches the backup bucket.

## Data processing agreement

DigitalOcean acts as a processor. Accept their DPA in the account settings,
and note the chosen region in `docs/PRIVACY_RISK_NOTE.md`.
