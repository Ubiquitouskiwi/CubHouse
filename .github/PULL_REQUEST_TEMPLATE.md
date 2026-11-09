## Summary

<!-- What changed and why, in two or three sentences. -->

- Issue: #

## Type of change

- [ ] Bug fix
- [ ] Feature
- [ ] Security or privacy control
- [ ] Docs
- [ ] Tooling, CI, or deployment files

## Verification

<!-- Paste the commands you ran and their results. Say plainly if something could not run. -->

- [ ] `npm run check` passes
- [ ] `npm run test:pg` passes against a throwaway database (or CI's Postgres job is green)
- [ ] Tests added or updated, and they fail without this change

## Safety checklist

- [ ] No real photos, names, emails, or places anywhere in this change (code, tests, docs, screenshots)
- [ ] No new third-party request, analytics, or remote asset
- [ ] Access decisions still go through `src/permissions.js`; widening or destructive actions through governance
- [ ] Photos stay private by default; nothing new exposes media outside the permission check
- [ ] `CHANGELOG.md` updated under `Unreleased` (if user-visible)

## AI assistance

- [ ] This PR was written or substantially drafted by an AI agent: <!-- name the agent/model -->
- [ ] A human has read every line of the diff

## Notes for reviewers

<!-- Assumptions, open questions, risks, follow-ups. -->
