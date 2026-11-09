# Security and Privacy Plan

Status: implemented in code (Phases 0 to 5), with follow-up hardening listed in `CHANGELOG.md`.
Owner: the project maintainers.

## Implementation status

All items below are implemented and covered by `npm test`, except the ones
marked here:

- **Postgres data store** (`src/store/pgStore.js`, `deploy/sql/002_data_store.sql`)
  is implemented and the whole suite runs against it in CI (`npm run test:pg`).
  It has not yet run against a managed production database.
- **Written, not verified live** (no cloud account was touched): the Spaces
  storage backend, SMTP delivery, Caddy, the systemd units, backup and
  restore scripts, and the CI workflows. Each is wired, reviewed and (for the
  scripts) unit-tested against stubs, but needs a first real run
  (`docs/DEPLOY.md`).
- **2.2 Spaces lockdown** is a checklist (`deploy/SPACES.md`) the account owner
  applies; it includes the required anonymous-403 verification.
- **1.2 HEIC:** the prebuilt image library cannot decode HEIC, so HEIC uploads
  are refused with instructions (iPhone "Most Compatible", or share as JPEG).
  Safari usually converts to JPEG on upload already. AVIF is accepted.
- **3.6 passkeys:** TOTP is implemented; passkeys (WebAuthn) are a follow-up.
- **4.5 notifications:** implemented with console (dev) and SMTP (prod)
  transports; the email provider and its DPA are an account step.
- **Single-photo delete** stays a one-guardian action (it reduces exposure),
  with step-up, audit, and a notification to the other guardian. Bulk delete
  and archive erasure are governed.

This plan comes from a five-person review panel that read the whole codebase:

- application security
- child privacy and data protection
- media pipeline and storage
- trust and safety / threat modeling
- platform and operations

The site's promise is simple: parents share photos of their child with invited family, and nobody else ever sees them. Every item below is measured against that promise. The child is the main person whose data is at stake, even though the child never logs in.

Every finding here was confirmed by reading or running the code, not assumed.

---

## 1. Where the codebase stands today

### Good foundations worth keeping

- **One permissions module.** Authorization lives in `src/permissions.js`. Single-photo views, downloads, comments, reactions and album adds all re-check `canViewPhoto`. No IDOR was found on photo or album reads.
- **No raw output in templates.** Every `<%-` is an `include`, and user data goes through `<%=`. No stored-XSS path was found.
- **Sound credential basics.** bcrypt cost 12, CSPRNG access codes, session regeneration on login, `httpOnly` + `sameSite: strict` cookies, and a 15-minute idle timeout.
- **Parents control contributions.** Uploads from non-parents wait for approval and stay hidden until a parent approves them.
- **The download ledger** is the right primary leak-tracing control.

### The core problem: the security described is mostly not running

The README's "Implemented baseline" and the Phase 2/3 settings in `config.js` describe protections that are not in effect.

| Claimed control | Reality |
|---|---|
| CSRF protection | `csurf` is required but not installed. Only 4 of 10 views that have forms include a token, so login, register, logout, settings and albums would all return 403 once it loads. |
| Rate limiting | `express-rate-limit` is required but not installed. `accessCodeLimiter` is imported and never applied. |
| Login lockout | `routes/auth.js` passes `req.store`, which is never set. The first login attempt throws, and Express 4 does not catch async errors. |
| EXIF/GPS stripping | `uploads.stripExif` is never read, and there is no image library. Photos keep GPS coordinates. |
| Private media, signed URLs | `media.privateByDefault` and `serveMode` are never read. Originals are inlined into HTML as data URIs. |
| Parent MFA, step-up | `parentAuth.*` is never read. |
| Audit trail | `appendSecurityAuditEvent` is never called from any route. |
| Audit retention | `audit.retentionDays` is never enforced. The ledger is documented as never deleted. |
| Dev restricted in prod | `canUseDevPrivileges` is defined and never called. |
| Visible watermark | `applyTrace` hardcodes `watermarkApplied = false`, but the UI offers the toggle. |

On top of that:

- The app cannot boot at all. Besides the missing packages, `server.js` imports `{ createStore }`, but `store/index.js` exports a store instance.
- All 11 test files fail on load.
- `config.seedTestAccounts` does not exist, because the real key is `config.seed.testAccountsEnabled`. The seed test hides this mismatch.

This gap matters more than any single bug. A parent reading the README or the settings would believe protections exist that do not. **Principle for this plan: a control either runs and has a test that proves it, or it is removed from the docs and config.**

---

## 2. Threat model summary

The adversaries that matter most for a child's photos are rarely strangers. They are people who were invited.

| Adversary | Worst realistic outcome | Today's protection |
|---|---|---|
| Estranged or abusive relative, ex-partner (custody dispute, stalking) | Locates the child's home or school from photo GPS or captions, and keeps watching after falling out | Group removal only. No disable, no session kill, `everyone` photos stay visible, GPS is retained. **Critical** |
| A parent account used against the other parent | Unilaterally shares photos widely or deletes the archive | None. Any parent can do anything alone, with no audit. **Critical** |
| Family member who leaks to social media | Child's photos become public | Download gate is cosmetic because full bytes are in the page source. Metadata only works on PNG. No watermark. **High** |
| Compromised family account | Stranger browses the archive | No MFA, no breached-password check, no new-login alerts. Lockout is per IP + email, so rotating IPs bypass it. **High** |
| Forwarded or intercepted invite code | Stranger joins | No expiry, no binding to an email, no revoke. A race lets one code create many accounts. **High** |
| Dev role insider | Hidden extra account, reads every member's email | `/admin` shows dev all unused codes and emails. **High** |
| Malicious contributor | Harmful or illegal upload | Approval queue (good), but approval defaults to publishing to `everyone`. **Medium** |
| Lost or shared device | Someone else browses | 15-minute rolling idle, but no absolute lifetime and no "sign out everywhere". **Medium** |

---

## 3. Panel decisions on contested points

Where panelists disagreed, these are the resolutions:

1. **Download tracing.** All panels agreed that embedding the downloader's name, UUID and the caption into files is harmful. A leaked file would also expose a grandparent's identity and context about the child. **Decision:** embed only an opaque, random per-download token that the ledger resolves on the server. Tell members plainly that downloads are traced, because that notice is the real deterrent.
2. **Ledger retention.** 365 days (current config) versus 90. **Decision:** 90 days by default, with IPs truncated (/24 for IPv4, /48 for IPv6), no user agent by default, and no email or caption copied into ledger rows.
3. **Two-parent governance.** Dual approval versus notify-and-delay. **Decision:** any one guardian can always *restrict* alone: hide, revoke, remove a member, lock downloads. Actions that *widen* exposure or destroy data need the other guardian's approval when there are two. Those actions are widening an audience to `everyone`, enabling download, adding a member, bulk delete, deleting the archive, and changing roles. If only one guardian is registered, they get a 24-hour delay plus a notification. This protects the child in a custody dispute without blocking an emergency lockdown.
4. **Watermark default.** Opt-in versus default-on. **Decision:** downloads stay off by default, as today. When a parent enables download on a photo, the burned-in watermark defaults to on and can be turned off per photo.
5. **Dev role.** **Decision:** no `dev` role on the production family instance. Dev access exists only in non-production environments. `canUseDevPrivileges` gets enforced, or the role is removed in production.
6. **Encryption at rest.** Provider-side encryption versus envelope encryption. **Decision:** provider-side encryption (Spaces SSE, DO Managed PG) is the Phase 2 baseline. Per-family envelope encryption is the Phase 4 golden-standard target.
7. **CSAM handling.** Must be proportionate for a private family site. **Decision:**
   - Keep the approval queue.
   - Add gentle guidance discouraging unclothed photos of the child.
   - Document a removal and NCMEC CyberTipline reporting path.
   - Rely on the storage provider's own hash matching.
   - Do not build in-house nudity classifiers, which mislabel family photos.
8. **COPPA.** Likely out of scope, since the child is not a user and adults supply the images. GDPR / UK GDPR apply to family members' data if any live in the EU or UK. **Decision:** build to the stricter standard anyway, and never give the child an account without a verified consent design.

---

## 4. Development plan

The work is grouped into phases that ship independently. Each item has acceptance criteria, and every item must ship with an automated test. The plan respects the zero-cost development constraint: every shared service has an in-memory fallback in dev, and production refuses to boot on that fallback.

### Phase 0: Make the existing baseline real (blocker, about 1 to 2 days)

Nothing else matters until the app boots and the controls it claims actually run.

| # | Task | Acceptance |
|---|---|---|
| 0.1 | Fix `store/index.js` to export `createStore`, and make creation lazy (no singleton at require time). | `npm start` boots. Requiring the module with `DATABASE_URL` set does not throw at import. |
| 0.2 | Pass the `store` closure into the lockout helpers instead of `req.store`. | Login works. 8 bad attempts lock the account, and the test proves it. |
| 0.3 | Add an async error wrapper (or move to Express 5), plus `process.on('unhandledRejection')` logging. | A thrown error in any handler returns 500, and the process stays up. Test included. |
| 0.4 | Replace `csurf` (deprecated) with `csrf-sync`, pinned. Add `_csrf` to every form: login, register, logout, settings (x3), albums, album (x2). Move the CSRF error handler beside the final error handler. | A POST without a token returns 403. Every form works with a token. Test per route. |
| 0.5 | Add `express-rate-limit`, pinned. Apply `accessCodeLimiter`. Add an IP-only limiter on `/register`, separate from the IP+email key. | Limits return 429 in tests. |
| 0.6 | Make redeeming an access code atomic: consume the code before `createUser`, and release it on failure. | A parallel redemption test creates exactly one account. |
| 0.7 | Regenerate the session on registration, the same as login. | Fixation test: the session id changes after register. |
| 0.8 | Coerce all body fields with `String()`, or validate with a schema. | `name=a&name=b` returns 400, not a crash. |
| 0.9 | Fix the `seedTestAccounts` key mismatch, and fix the seed test that masks it. | Test accounts seed in dev and never in prod. |
| 0.10 | Drop the global body limit to 100 KB. Allow the large limit only on `/photos/upload`. | A 1 MB POST to `/login` returns 413. |
| 0.11 | Run `npm update express` to clear the body-parser advisory. | `npm audit --omit=dev --audit-level=high` is clean. |
| 0.12 | Rewrite the README security section so it lists only what is implemented and tested. Delete or comment out config flags until their phase lands. | No config key exists that no code reads. |

### Phase 1: Protect the child's location and identity (about 3 to 5 days)

This is the highest real-world risk: a photo revealing where the child lives, sleeps or goes to school.

| # | Task | Acceptance |
|---|---|---|
| 1.1 | Add `sharp`. Re-encode every upload on the server: `.rotate()` to bake in orientation, output JPEG or WebP, no `withMetadata()`, keep an sRGB ICC profile, `limitInputPixels` of about 50 MP, `failOn: 'error'`. Reject anything that cannot be re-encoded. | A test uploads a JPEG with GPS, Make, Model and serial tags, and asserts none survive. Decompression-bomb test rejected. |
| 1.2 | Verify magic bytes with `file-type`. Ignore the declared MIME. Accept JPEG, PNG, WebP and HEIC (convert HEIC server-side so parents never use online converters). Drop GIF and never allow SVG. Unify all size caps into `config.uploads.maxBytes`. | A file declared PNG that is actually HTML is rejected. HEIC from an iPhone uploads. |
| 1.3 | Move to multipart streaming upload (`busboy`) instead of base64 in a urlencoded body. | Upload works at 10 MB with flat memory use. |
| 1.4 | Generate derivatives: thumbnail about 400 px, display about 1600 px, and a sanitized full-size copy. | Gallery pages ship thumbnails only. |
| 1.5 | Private-by-default audience. New photos and approved contributions default to "parents only" or a parent-chosen upload profile, never `everyone`. Approving requires choosing an audience. | Approve without an audience returns a validation error. Test included. |
| 1.6 | Show a caption and comment PII nudge: "Avoid school names, full names, addresses." | Shown on upload and comment forms. |
| 1.7 | Self-host fonts and remove Google Fonts from `partials/header.ejs`. | No third-party origin in any response. |

### Phase 2: Private media architecture (about 1 to 2 weeks)

Make "can view" and "can download" technically real, not cosmetic.

| # | Task | Acceptance |
|---|---|---|
| 2.1 | Put a media storage interface in front of two backends: local disk in dev (`$DATA_DIR/media`, not under `public/`) and a private DigitalOcean Spaces bucket in prod. Same code, picked by environment variable. | Dev costs nothing. Prod refuses to boot with local disk. |
| 2.2 | Spaces bucket rules: no public ACL, a bucket policy denying anonymous access, versioning on, noncurrent versions expire in 30 days or less, SSE on, a pinned region (EU if family members are there), and object keys that are random 128-bit ids (`photos/<uuid>/<variant>`) with no names or captions. | Anonymous GET to any object returns 403. Verified before the first real upload. |
| 2.3 | App-gated streaming at `/media/:id/:variant`. Run `canViewPhoto` on every byte request. Viewers get `thumb` and `display`. `full` is only served through `/download` with `cap.download`. Headers: `Cache-Control: private, no-store`, `X-Content-Type-Options: nosniff`, and `Content-Disposition: inline` or `attachment`. | A view-only member cannot fetch `full`. The data URI is gone from the HTML. |
| 2.4 | Remove `parseImageBytes`' arbitrary `fetch` and the `redirect(photo.url)` fallback. Use the SDK `GetObject` against the configured bucket only. | No SSRF or open-redirect path. Test included. |
| 2.5 | Redesign tracing: an opaque per-download token in metadata (works for JPEG and PNG), and a visible watermark composited with `sharp`, defaulting on when download is enabled. Fix `watermarkApplied` reporting. | Downloaded files contain no name, email, UUID or caption. The watermark is visibly present in the test output. |
| 2.6 | Derive the ledger IP from `req.ip`, with `trust proxy` set to the exact hop count *before* the session middleware. Remove the raw `X-Forwarded-For` read. | A forged XFF header does not reach the ledger. Test included. |
| 2.7 | Complete deletion. Remove every variant and every noncurrent version, purge any CDN cache, keep the ledger event but remove its content (caption, IP), and write a tombstone audit event. The UI states that copies already downloaded cannot be recalled, and how long backups keep data. | A deletion test asserts that no storage object and no caption text remain. |

### Phase 3: Account lifecycle, revocation and governance (about 1 to 2 weeks)

This is what a parent needs on the worst day: removing someone instantly.

| # | Task | Acceptance |
|---|---|---|
| 3.1 | Persistent session store with fallback: `connect-pg-simple` when `DATABASE_URL` is set, MemoryStore in dev only. Safe boot refuses MemoryStore in prod. Use a `__Host-` cookie name in prod. | Restarting does not log anyone out in prod. |
| 3.2 | Add `sessionVersion` and `disabled` fields to the user. Every request loads the user from the store and rejects them if disabled or the version does not match. Read the role from the store, never the session. | Disabling a user or changing a role takes effect on their very next request. Test included. |
| 3.3 | A "Remove and revoke" action for parents: disable the account, bump the session version, remove the user from all groups, and revoke codes they created. | One click ends access everywhere. Test included. |
| 3.4 | Access-code lifecycle: `expiresAt` (72-hour default), an optional bound email, a revoke action, unused codes visible only to parents, and a single generic error message for invalid or used codes. Notify parents when a code is redeemed. | An expired or revoked code fails. Dev sees no codes. |
| 3.5 | Account security: require the current password to change email, regenerate the session and bump `sessionVersion` on a password change, add "sign out all devices", an absolute session lifetime (7 days), a password minimum of 12 characters and maximum of 72 bytes, a breached-password check (k-anonymity HIBP range API, which never sends the password), and run bcrypt against a dummy hash when the email does not exist so timing does not reveal accounts. | Tests for each. |
| 3.6 | Parent MFA: TOTP or passkeys, required for parents in prod. Offered to family members. Step-up re-authentication (5-minute window) before destructive or widening actions. | A parent cannot reach `/admin` in prod without MFA enrolled. |
| 3.7 | Two-guardian governance as described in Section 3, item 3. A pending-approval queue for widening and destructive actions. | Widening an audience with two guardians creates a pending request until the second approves. |
| 3.8 | Remove the `dev` role from production. In dev, mask emails and hide codes from dev. | Safe boot fails if a dev account exists in prod. |
| 3.9 | Member self-service: delete my account (choose anonymize or delete for comments and reactions), and export my data as JSON. | Both work end to end. Test included. |
| 3.10 | Comment safety: rate limit, a report button, parent mute, soft-delete with history kept for parents, a role badge on authors, and reserved display names ("Parent", "Parents", "Admin"). | A member cannot post as "Parents". |

### Phase 4: Audit, transparency and the child's future (about 1 week)

| # | Task | Acceptance |
|---|---|---|
| 4.1 | Call `appendSecurityAuditEvent` for logins, failed logins, lockouts, audience and permission changes, group membership changes, code creation, redemption and revocation, role changes, downloads, deletes and governance decisions. | Every listed action has a test asserting an event. |
| 4.2 | Append-only, tamper-evident audit storage: a PG table with UPDATE and DELETE revoked from the app role, and a `prev_hash` hash chain. Visible to every guardian, and no single parent can purge it. | Tampering with a row breaks chain verification. |
| 4.3 | Enforce retention: a daily job that purges ledger rows past 90 days and audit detail past the configured window, keeping hashed tombstones for chain integrity. | Purge test included. |
| 4.4 | A privacy notice at `/privacy`, plus a short invite-time disclosure on the register page covering what is collected, download tracing and watermarking, retention, who the guardians are, and how to delete your account. Store the notice version each user accepted. | Registration requires acknowledgment. |
| 4.5 | Parent notifications: new-device login, downloads (as a digest), code redemption, lockouts, and governance requests. Use email through a provider with a DPA. In dev, write to the console only. | Notifications fire in tests through a fake transport. |
| 4.6 | The child's archive: a full export (sanitized originals plus captions as JSON), plus "transfer archive" and "erase everything" flows that need both guardians. Record which guardian published each photo. | Export produces a complete zip. Erase removes all media and data. |
| 4.7 | Envelope encryption (golden-standard target): a per-family data key wrapped by a key-encryption key outside the database, with AES-256-GCM per object. Encrypt `pg_dump` backups with `age` and store them separately from the key material. | Media in the bucket cannot be read with bucket credentials alone. |

### Phase 5: Platform and operations hardening (ongoing, starts alongside Phase 0)

| # | Task | Acceptance |
|---|---|---|
| 5.1 | Add `helmet` with a strict CSP. Move inline scripts out of `header.ejs`, `admin.ejs` and `photo.ejs` into `/public`, or give them per-request nonces. Policy: `default-src 'self'; script-src 'self'; img-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'; object-src 'none'`. Also HSTS (2 years), `Referrer-Policy: no-referrer`, a Permissions-Policy denying camera, microphone and geolocation, `X-Robots-Tag: noindex, nofollow, noarchive`, and a `robots.txt` that disallows everything. | A header snapshot test passes. No `'unsafe-inline'` anywhere. |
| 5.2 | TLS through Caddy on the droplet (free Let's Encrypt). The app binds `127.0.0.1` only. HTTP redirects to HTTPS. | Verified externally. |
| 5.3 | Structured logging with `pino` and `redact` covering body, cookies, email, password and image data. Remove the plaintext seed-password logs. Force a password change on the first login of a seeded account. | No PII in logs, per test. |
| 5.4 | Strengthen safe boot. Run it in every environment, warning outside prod and refusing in prod. Check for MemoryStore session or rate-limit backends, local media storage, a dev account, missing `trust proxy`, and a seeded account that still uses its default password. `FORCE_SAFE_BOOT=false` must not exist in prod. | A boot smoke test with `NODE_ENV=production` and no secrets exits non-zero. |
| 5.5 | Database: `sslmode=verify-full` with the DigitalOcean CA certificate, an app role limited to DML, and a separate migration role. | Documented and verified. |
| 5.6 | CI (GitHub Actions, free tier): `npm ci`, `node --test`, `npm audit --audit-level=high`, CodeQL, gitleaks, `eslint-plugin-security`, Dependabot weekly, and the boot smoke test. | Required checks before merge. |
| 5.7 | Backups: DigitalOcean point-in-time recovery plus encrypted dumps, a quarterly restore drill, and a stated window ("deleted data is gone from backups within 30 days"). | Restore drill logged. |
| 5.8 | One-page incident runbook: contacts, how to rotate `SESSION_SECRET`, database and Spaces keys, how to disable accounts and revoke codes, how to preserve logs, and a 72-hour family notification decision tree. | Written and reviewed. |
| 5.9 | A short processing record and risk note (DPIA style) that includes the legitimate-interest balancing test for leak tracing. Review once a year. | Written. |

---

## 5. Suggested order and rough effort

1. **Phase 0 + 5.1 (headers).** The app boots, and the claimed baseline is real and tested. About 2 to 3 days.
2. **Phase 1.** No location or identity leaks through image bytes. About 1 week.
3. **Phase 3.1 to 3.4.** Instant revocation and safe invites. About 1 week.
4. **Phase 2.** Private media and honest tracing. About 1 to 2 weeks. This is required before any real photos go into production.
5. **Rest of Phase 3, then Phase 4.** Governance, MFA, audit, transparency and the child's archive. About 2 weeks.
6. **Phase 5 remainder.** In parallel and ongoing.

**Gate for real photos of the child:** Phases 0, 1, 2 and 3.1 to 3.6, plus 5.1 to 5.4, must be complete and green in CI before the first real photo is uploaded to a production instance.

## 6. Security test matrix to add

- Boot smoke, and production boot refusal
- Login success, failure and lockout; timing-equalized unknown email
- CSRF 403 on every mutating route; rate-limit 429
- Session regeneration on login and register; absolute lifetime; disable and role change taking effect on the next request
- Access code: expiry, revoke, bound email, parallel redemption
- Upload: EXIF/GPS removed, MIME spoof rejected, pixel bomb rejected, HEIC accepted
- Media: view-only member denied `full`, anonymous denied, no data URIs in HTML
- Download: opaque token only, watermark present, forged XFF ignored
- Deletion: no objects, versions or caption text remain
- Audit: event per sensitive action; hash chain detects tampering; retention purge
- Headers snapshot; no third-party origins in responses
- Governance: widening action pending until the second guardian approves; restricting action immediate
