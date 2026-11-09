# Contributing to Cubhouse

Thanks for helping families share photos privately. Reviews of the security model are as welcome
as code.

## Ground rules

1. **Never use real people's data.** No real photos, names, emails, or places in code, tests,
   fixtures, screenshots, issues, or pull requests. Tests generate their images
   (`test/fixtures/makeImages.js`) and use `example.com` or `test.com` addresses.
2. **Privacy controls are tested, or they do not exist.** A setting that no code reads, or a
   control without a test that proves it, does not get documented. Every behavior change ships
   with a test that fails without it.
3. **Access decisions go through `src/permissions.js`**, and widening or destructive actions
   through `src/governance.js`. Do not check roles inline.
4. **No third-party requests.** Do not add analytics, remote assets, or new outbound calls.
5. **Prefer no new dependencies.** If one is truly needed, explain why in the pull request.

Maintainers: `scripts/check-forbidden-names.js` fails if a real name appears in a tracked file,
a file or folder name, or a commit message. The names are never in the repository. CI reads the
`FORBIDDEN_NAMES` repository secret (one name per line). Locally, the hooks in `scripts/hooks/` read
`~/.config/family-photos/forbidden-names`, which is outside the repo. Install the hooks once with
`git config core.hooksPath scripts/hooks`. Each name matches in any case and with any separator
(`First Last` also catches `first-last` and `FirstLast`).

## Setup

```bash
git clone https://github.com/OWNER/REPO.git && cd REPO
npm ci
npm run check      # lint, tests, Postgres tests (skipped without a database), audit
npm run dev        # http://localhost:3000, in-memory, sample data only
```

To run the suite against PostgreSQL, point `TEST_DATABASE_URL` at a **throwaway** database
(every test empties it):

```bash
docker run --rm -d --name photos-pg -e POSTGRES_PASSWORD=postgres -p 127.0.0.1:5432:5432 postgres:16
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npm run test:pg
```

## Workflow

1. Open or find an issue, and say you are working on it.
2. Branch from `main`: `feat/<short-name>`, `fix/<short-name>`, `docs/<short-name>`.
3. Keep the change to one concern, with tests.
4. Commit with [Conventional Commits](https://www.conventionalcommits.org/), for example
   `fix(permissions): treat a listed-everyone audience as widening`. If an AI agent wrote or
   substantially drafted the commit, add an `Assisted-by: <agent or model>` trailer.
5. Open a pull request with the template, and add user-visible changes to `CHANGELOG.md` under
   `Unreleased`.
6. A maintainer reviews every pull request. CI must be green.
7. The GitHub wiki is generated from `docs/guide` (`scripts/wiki-sync.js`). Edit the guide, not
   the wiki. A new guide page needs a wiki name in `PAGE_NAMES` in that script.

## Using AI tools

AI-assisted contributions are welcome. You are responsible for every line you submit: read the
diff and run the checks. Never paste real people's photos or details into an AI tool.

## Conduct and security

This project follows the [Code of Conduct](./CODE_OF_CONDUCT.md). Report vulnerabilities privately
as described in [SECURITY.md](./SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the project's
[AGPL-3.0-only](./LICENSE) license. You keep the copyright to your own contributions.
