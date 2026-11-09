# Security Policy

Cubhouse stores photos of children and the personal details of their relatives. Security and
privacy are the product, not features of it.

## Hard rules

1. **No third parties.** No analytics, trackers, CDNs, remote fonts, or error reporters. Every
   response is served by the app itself. The only outbound requests are to the operator's own
   database, bucket and email provider, plus the optional k-anonymous breached-password check.
2. **Photos are stripped and private by default.** Every upload is re-encoded with no metadata.
   New photos are visible to guardians only. Unknown audiences fail closed.
3. **Media is never public.** Objects are encrypted before upload and served only through the app
   after a permission check. Never add public bucket URLs, signed links that outlive a request, or
   a CDN in front of the bucket.
4. **Widening needs two guardians.** Anything that shows photos to more people, invites people,
   changes roles, removes a guardian, or destroys data goes through `src/governance.js`. Nobody
   approves their own request.
5. **No real data in the repository.** No real photos, names, emails, or addresses in code, tests,
   fixtures, screenshots, or issues. Use generated images and `example.com` addresses.
6. **Safe boot stays on.** Production must keep refusing unsafe configuration. Do not add a switch
   that disables it.

## Reporting a vulnerability

Use GitHub's **private vulnerability reporting**: the "Report a vulnerability" button on the
repository's Security tab. Do not open a public issue with exploit details, and never attach real
photos. Include steps to reproduce and the impact, especially any path that could expose a photo,
a member's details, or bypass two-guardian approval.

Maintainers aim to acknowledge reports within 5 business days and to share a remediation plan
within 30 days. Reporters who wish to be credited will be acknowledged in the release notes.

## Supported versions

Cubhouse is pre-release. Only the latest commit on `main` receives security fixes.

## For operators

If you run an instance and suspect a compromise, follow [docs/RUNBOOK.md](./docs/RUNBOOK.md)
section 3. Keep `APP_ENCRYPTION_KEY` and the backup `age` identity offline as described in section 6.
