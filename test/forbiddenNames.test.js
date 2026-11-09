'use strict';

/**
 * scripts/check-forbidden-names.js, tested with a DUMMY name only. The real
 * names are never in the repository: CI reads the FORBIDDEN_NAMES secret, and
 * the local hooks read ~/.config/family-photos/forbidden-names.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { run, nameToRegex, parseNames } = require('../scripts/check-forbidden-names');

const DUMMY = 'Jane Placeholder';
const SCRIPT = path.join(__dirname, '..', 'scripts', 'check-forbidden-names.js');
const HOOKS = path.join(__dirname, '..', 'scripts', 'hooks');

function tempRepo(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forbidden-names-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = (...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  return { dir, g, write: (f, s) => {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), s);
  } };
}

function check(dir, args, env = {}) {
  const lines = [];
  const code = run(args, { cwd: dir, env, log: (s) => lines.push(s) });
  return { code, out: lines.join('\n') };
}

const ENV = { FORBIDDEN_NAMES: `${DUMMY}\n# a comment\n\n` };
const NO_FILE = ['--names-file', '/nonexistent/forbidden-names'];

test('a name matches in any case and with any separator, but not its parts alone', () => {
  const re = nameToRegex(DUMMY);
  for (const v of ['jane placeholder', 'JANE-PLACEHOLDER', 'jane_placeholder', 'JanePlaceholder', 'jane.placeholder', 'x/janeplaceholderweb']) {
    assert.ok(re.test(v), v);
  }
  assert.equal(re.test('jane'), false);
  assert.equal(re.test('placeholder'), false);
  assert.deepEqual(parseNames(ENV.FORBIDDEN_NAMES), [DUMMY]);
  // Regex characters in a name are literal.
  assert.equal(nameToRegex('a.b').test('axb'), false);
});

test('skips cleanly (exit 0) when no names are configured', (t) => {
  const { dir } = tempRepo(t);
  const r = check(dir, ['--tree', '--messages', ...NO_FILE], {});
  assert.equal(r.code, 0);
  assert.match(r.out, /^SKIPPED/);
});

test('--tree fails on a name in tracked contents or paths, and reports places only', (t) => {
  const repo = tempRepo(t);
  repo.write('ok.txt', 'nothing to see\n');
  repo.write('docs/notes.md', 'line one\nPhotos of jane_placeholder here\n');
  repo.write('JanePlaceholder-site/x.txt', 'clean\n');
  repo.write('untracked.txt', `${DUMMY}\n`);
  repo.g('add', 'ok.txt', 'docs/notes.md', 'JanePlaceholder-site/x.txt');
  repo.g('commit', '-q', '-m', 'init');
  const r = check(repo.dir, ['--tree', ...NO_FILE], ENV);
  assert.equal(r.code, 1);
  assert.match(r.out, /docs\/notes\.md:2/);
  assert.match(r.out, /JanePlaceholder-site\/x\.txt \(file or folder name\)/);
  assert.doesNotMatch(r.out, /untracked\.txt/, 'untracked files are not part of the tree');
  // The matched line itself is never printed.
  assert.doesNotMatch(r.out, /Photos of/);
});

test('--messages fails on a name in a commit message or author, anywhere in history', (t) => {
  const repo = tempRepo(t);
  repo.write('a.txt', 'clean\n');
  repo.g('add', 'a.txt');
  repo.g('commit', '-q', '-m', 'Add site for JANE PLACEHOLDER');
  repo.write('a.txt', 'still clean\n');
  repo.g('commit', '-q', '-am', 'tidy');
  const r = check(repo.dir, ['--messages', ...NO_FILE], ENV);
  assert.equal(r.code, 1);
  assert.match(r.out, /commit [0-9a-f]{12} \(message or author\)/);
  assert.equal((r.out.match(/commit [0-9a-f]{12}/g) || []).length, 1);
  assert.equal(check(repo.dir, ['--tree', ...NO_FILE], ENV).code, 0, 'tree is clean');
});

test('the names file outside the repo is used when FORBIDDEN_NAMES is unset', (t) => {
  const repo = tempRepo(t);
  const namesFile = path.join(repo.dir, '..', `names-${path.basename(repo.dir)}`);
  fs.writeFileSync(namesFile, `# comment\n${DUMMY}\n`);
  t.after(() => fs.rmSync(namesFile, { force: true }));
  repo.write('a.txt', 'jane-placeholder\n');
  repo.g('add', 'a.txt');
  assert.equal(check(repo.dir, ['--staged', '--names-file', namesFile], {}).code, 1);
});

test('installed hooks block a staged file or a commit message with the name', { skip: process.platform === 'win32' }, (t) => {
  const repo = tempRepo(t);
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'forbidden-home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.config', 'family-photos'), { recursive: true });
  fs.writeFileSync(path.join(home, '.config', 'family-photos', 'forbidden-names'), `${DUMMY}\n`);
  // The hooks call scripts/check-forbidden-names.js inside the repo they run in.
  fs.mkdirSync(path.join(repo.dir, 'scripts', 'hooks'), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(repo.dir, 'scripts', 'check-forbidden-names.js'));
  for (const h of ['pre-commit', 'commit-msg']) {
    fs.copyFileSync(path.join(HOOKS, h), path.join(repo.dir, 'scripts', 'hooks', h));
    fs.chmodSync(path.join(repo.dir, 'scripts', 'hooks', h), 0o755);
  }
  const env = { PATH: process.env.PATH, HOME: home, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com' };
  const git = (...args) => spawnSync('git', ['-c', 'core.hooksPath=scripts/hooks', ...args], { cwd: repo.dir, env, encoding: 'utf8' });
  git('add', 'scripts');
  assert.equal(git('commit', '-q', '-m', 'add hooks').status, 0, 'a clean commit is allowed');
  repo.write('page.html', '<h1>Jane-Placeholder</h1>\n');
  git('add', 'page.html');
  const blockedFile = git('commit', '-q', '-m', 'add page');
  assert.notEqual(blockedFile.status, 0, 'pre-commit let a staged name through');
  assert.match(blockedFile.stdout + blockedFile.stderr, /page\.html:1/);
  git('reset', '-q', 'page.html');
  repo.write('clean.txt', 'ok\n');
  git('add', 'clean.txt');
  const blockedMsg = git('commit', '-q', '-m', 'photos for jane placeholder');
  assert.notEqual(blockedMsg.status, 0, 'commit-msg let the name through');
  assert.equal(git('commit', '-q', '-m', 'add clean file').status, 0);
});

test('the shipped guard files contain no configured name (only the dummy, in this test)', () => {
  for (const f of [SCRIPT, path.join(HOOKS, 'pre-commit'), path.join(HOOKS, 'commit-msg')]) {
    assert.doesNotMatch(fs.readFileSync(f, 'utf8'), /placeholder/i);
  }
});
