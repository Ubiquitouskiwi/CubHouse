# Branches and workflows

Code moves `feature -> beta -> production`, and StarlingTek deploys whatever `production` points
at. There is no release bundle: promoting is deploying.

```
feature branch --PR--> beta --Promote (button / monthly)--> production --> StarlingTek deploys
      |                  |                |                      |
  CI on the PR      CI on the push   CI gate, then a        CI on the push;
  (must be green    to beta          fast-forward of        StarlingTek polls
   to merge)                         production             or gets the webhook
```

The human gate is the pull request into `beta`. Everything after it is a deliberate click (or the
monthly run). `production` never gets a commit of its own, so it is always an ancestor of `beta`.

## The workflows

| File | Trigger | What it does |
| --- | --- | --- |
| `ci.yml` | push to `beta`/`production`, PRs into them; called by `promote.yml` | lint, in-memory tests, audit, safe production boot, shellcheck (Node 20, 22, 24); the suite on PostgreSQL; the forbidden-names check |
| `promote.yml` | the button, and monthly (1st, 15:00 UTC) | runs `ci.yml` on beta, checks the commit, fast-forwards `production` |
| `codeql.yml` | push to `beta`/`production`, PRs into them, weekly | CodeQL security queries |
| `gitleaks.yml` | push to `beta`/`production`, PRs into them | secret scan of the full history |
| `dependency-review.yml` | PRs into `beta`/`production` | new vulnerable or badly licensed dependencies (public repository only) |
| `scorecard.yml` | push to `beta`, weekly, ruleset changes | OpenSSF Scorecard (default branch only) |
| `wiki-sync.yml` | push to `beta` touching `docs/guide`, the button (on `beta` only) | publishes `docs/guide` to the wiki |

The monthly schedule matches the StarlingTek repository's Promote. It is a no-op when `production`
already equals `beta`. Delete the `schedule:` block in `promote.yml` to promote only by hand.

`npm test` includes `test/workflows.test.js`, which fails on an empty `${{ }}` expression anywhere
in a workflow (GitHub rejects the whole file for one, comments included), an action not pinned to
a commit SHA, `pull_request_target`, or a renamed CI job.

## Status check names

The beta ruleset requires these, exactly as GitHub shows them (job names, not file names):

- `Lint, test, audit (Node 22)`
- `Tests against PostgreSQL`
- `No real names in files or commit messages`

The Node job is a matrix, so GitHub also shows `Lint, test, audit (Node 20)` and
`Lint, test, audit (Node 24)`; add them too if you want every leg required. Promote's own CI run
shows the same jobs as `Gate / ...`; those are not the ones to pick. A check only appears in the
ruleset picker after it has run once.

## Running Promote

Actions -> **Promote beta -> production** -> **Run workflow**, with "Use workflow from" set to
`beta`. It:

1. refuses to run from any branch but `beta`;
2. runs the whole of `ci.yml` on the beta commit the run started on;
3. checks that production is an ancestor of that commit, and stops quietly if production already
   has it;
4. checks that the commit has a successful CI run from its push to beta, and that code scanning
   has no open alert of high severity or higher on beta (it fails if it cannot read the alerts);
5. pushes that exact commit to `production` (a plain push, never a force-push), using
   `PROMOTE_TOKEN`.

StarlingTek then deploys it within 5 minutes, or at once with the webhook. Roll back with
`stk rollback <project>` ([DEPLOY-STARLINGTEK.md](./DEPLOY-STARLINGTEK.md)).

## One-time setup

### PROMOTE_TOKEN

The production ruleset only lets its bypass list update the branch, and the bypass list cannot
name the built-in Actions token. So Promote pushes with a token owned by a repository admin.

1. GitHub -> your avatar -> Settings -> Developer settings -> Personal access tokens ->
   **Fine-grained tokens** -> Generate new token.
2. Resource owner: the repository's owner. Repository access: **Only select repositories** ->
   this repository. Permissions -> Repository -> **Contents: Read and write** (Metadata: Read is
   added automatically). Nothing else. Pick an expiry and set a reminder to renew it.
3. The repository -> Settings -> Secrets and variables -> Actions -> **New repository secret**,
   name `PROMOTE_TOKEN`, value the token.

The token can write every branch of this repository, so keep it only in that secret. The workflow
hands it to git through a credential helper, so it never appears in a URL, a command line or the
log.

### Rulesets

Settings -> Rules -> Rulesets -> New branch ruleset, enforcement **Active**.

**Beta** (target: `beta`):

- Restrict deletions.
- Block force pushes.
- Require a pull request before merging.
- Require status checks to pass: the three names [above](#status-check-names).

**Production** (target: `production`):

- Restrict creations, Restrict updates, Restrict deletions.
- Block force pushes.
- Require code scanning results: tool **CodeQL**, security alerts **High or higher**.
- Bypass list: **Repository admin**, mode **Always**. This is what lets `PROMOTE_TOKEN` push.
  Because its owner bypasses the code scanning rule too, Promote checks the alerts itself.

Settings -> General -> Pull Requests: keep **Allow merge commits** on; the fix below needs it.

StarlingTek must track `production`: `stk set cubhouse branch=production` (use your project name).

## "production is not an ancestor of beta"

Something landed on `production` without going through beta, so production cannot be
fast-forwarded. The run's log says whether beta is just behind or has diverged; the fix is the same.
Bring production's commits into beta with a merge commit:

```bash
git fetch origin
git switch -c fix/sync-production origin/beta
git merge origin/production        # resolve any conflicts, then commit
git push origin fix/sync-production
```

Open a pull request into `beta` and merge it with **Create a merge commit**. Squash or rebase would
copy the changes but leave production's own commits out of beta's history, and the check would fail
again. Then run Promote. To stop it recurring, merge pull requests into `beta`, never `production`.

## Common failures

| Symptom | Fix |
| --- | --- |
| "PROMOTE_TOKEN missing" | create the secret ([above](#promote_token)) |
| push rejected with 403 or a ruleset message | the token expired, lacks Contents write, or its owner is not in the production bypass list |
| "Wrong branch" | run it with "Use workflow from: beta" |
| "No passing CI run" | CI on beta has not finished or failed for that commit; fix or re-run it, then Promote |
| "Open code scanning alerts" | fix or dismiss them under Security -> Code scanning |
| "Code scanning unreadable" | CodeQL has not run on beta yet, or code scanning is unavailable; run CodeQL on beta |
| the button is missing | `workflow_dispatch` and `schedule` only work from the default branch (`beta`) |
| a required check never reports | the job was renamed; `test/workflows.test.js` guards this |
