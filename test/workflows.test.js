'use strict';

// Static checks over .github/workflows. GitHub validates a workflow only when
// it runs, and one bad expression rejects the whole file, so catch it here.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DIR = path.join(__dirname, '..', '.github', 'workflows');
const files = fs.readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f));

function lines(file) {
  return fs.readFileSync(path.join(DIR, file), 'utf8').split('\n');
}

test('workflows exist', () => {
  assert.ok(files.includes('ci.yml') && files.includes('promote.yml'));
});

test('no empty ${{ }} expression anywhere, comments and run: blocks included', () => {
  for (const file of files) {
    lines(file).forEach((line, i) => {
      assert.doesNotMatch(line, /\$\{\{\s*\}\}/, `${file}:${i + 1} has an empty expression`);
    });
  }
});

test('third-party actions are pinned to a full commit SHA', () => {
  for (const file of files) {
    lines(file).forEach((line, i) => {
      const key = line.trim().replace(/^- /, '');
      if (!key.startsWith('uses:')) return;
      const ref = key.slice('uses:'.length).trim().split(' ')[0];
      if (ref.startsWith('./')) return;
      assert.match(ref, /^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/, `${file}:${i + 1} is not pinned to a SHA`);
    });
  }
});

test('no workflow uses pull_request_target', () => {
  for (const file of files) {
    assert.ok(!lines(file).some((l) => /^\s*pull_request_target\s*:/.test(l)), file);
  }
});

test('ci.yml job names match the beta ruleset (docs/WORKFLOWS.md)', () => {
  const ci = lines('ci.yml').map((l) => l.trim());
  for (const name of [
    'name: Lint, test, audit (Node ${{ matrix.node }})',
    'name: Tests against PostgreSQL',
    'name: No real names in files or commit messages',
  ]) {
    assert.ok(ci.includes(name), `ci.yml lost "${name}"; update the ruleset and docs if renaming`);
  }
  assert.ok(ci.includes('node: [20, 22, 24]'), 'the ruleset requires the Node 22 leg');
});
