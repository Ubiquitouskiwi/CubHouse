# Privacy risk note (DPIA style)

A short record of what this service processes, why, and how risk is reduced.
Reviewed yearly. This is an engineering record, not legal advice.

## Purpose

Let a child's guardians share photos privately with invited family, as an
alternative to public social media.

## Data subjects and data

| Who | Data | Why | Kept |
|---|---|---|---|
| The child (not a user) | Photos, captions | The purpose of the service | Until a guardian deletes, or the archive is erased or handed over |
| Family members | Email, name, optional username, password hash, MFA secret (encrypted) | Accounts and sign-in | Until account deletion |
| Family members | Comments, reactions, albums | Family interaction | Until deleted by author, guardian, or account deletion |
| Family members | Download records: who, which photo, when, /24 network prefix, opaque token | Leak tracing | 90 days |
| Everyone | Security audit events, truncated network prefix | Detect and investigate misuse | Details 365 days; the bare event and hash stay for chain integrity |

Not collected: analytics, advertising identifiers, third-party trackers, full
IP addresses in the ledger, user agents (off by default), photo location or
device metadata (stripped at upload).

## Lawful basis and the child

- Photos of the child: processed at the direction of the guardians (parental
  responsibility). The child cannot consent, so their interests are weighed
  first: private-by-default sharing, metadata stripping, two-guardian approval
  to widen exposure, and an export / erase path for when the child is grown.
- COPPA: the child never has an account and adults supply the images, so the
  service is not "directed to children". If a child account is ever added,
  verifiable parental consent must be designed first.
- Family members' data (EU/UK members): legitimate interests of the guardians
  in running a private family service.

## Legitimate-interest balancing test: download tracing

- **Interest:** if a photo of the child leaks, the guardians need to know
  which copy it was, so they can act.
- **Necessity:** a server-side ledger plus an opaque reference in the file is
  the least intrusive way that still works after re-sharing. A visible mark
  is the only control that survives screenshots.
- **Balance:** the file never contains the member's name or email; the
  network prefix is truncated; records expire after 90 days; members are told
  plainly before joining and on the download button. Guardians are not
  watermarked on their own downloads.
- **Outcome:** proportionate.

## Processors and locations

| Processor | Role | Location / region | DPA |
|---|---|---|---|
| DigitalOcean | Droplet, Managed Postgres, Spaces | (fill in region) | Accepted (date) |
| Email provider | Guardian notifications | (fill in) | (date) |

## Main risks and controls

| Risk | Controls (and the test that proves each) |
|---|---|
| Photo reveals where the child lives | Re-encode on upload, all metadata dropped (`test/photoUpload.test.js`) |
| Ex-partner or estranged relative keeps access | Remove and revoke ends sessions immediately (`test/revocation.test.js`) |
| One guardian acts against the other | Two-guardian approval for widening and erasure (`test/governance.test.js`) |
| Account takeover | Lockout, breached-password check, MFA required for guardians, new-device alerts (`test/security.test.js`, `test/mfa.test.js`) |
| Leak by a member | Downloads off by default, traced, watermarked (`test/downloadLedger.test.js`) |
| Bucket or database exposure | Envelope encryption; bucket and DB private (`test/media.test.js`, `deploy/SPACES.md`) |
| Tampering hides misuse | Hash-chained audit trail (`test/governance.test.js`) |

## Review log

| Date | Reviewer | Changes |
|---|---|---|
| 2026-11-03 | Initial | Created alongside the security and privacy plan |
