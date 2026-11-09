#!/usr/bin/env node
'use strict';

/**
 * Fail if a real name (for example a child's name) appears in the repository.
 *
 * The names are NEVER stored in the repository (it is public). They come from:
 *   - FORBIDDEN_NAMES: environment variable, one name per line. In CI this is
 *     a GitHub Actions secret.
 *   - otherwise a file OUTSIDE the repo, one name per line (# = comment):
 *     ~/.config/family-photos/forbidden-names, or --names-file <path>.
 * With no names configured it prints SKIPPED and exits 0.
 *
 * Each name matches case-insensitively with any separator between its parts,
 * so "First Last" also catches first-last, FIRST_LAST, first.last, FirstLast.
 * List a single word (a first name alone) on its own line to catch it too.
 *
 * Modes (combine freely):
 *   --tree              tracked files: contents and file/folder names
 *   --messages[=RANGE]  commit messages and authors (default: all history)
 *   --staged            staged files (the pre-commit hook)
 *   --message-file F    a commit message being written (the commit-msg hook)
 *
 * Output names only the place (file:line, commit hash), never the match.
 * Exit codes: 0 clean or skipped, 1 a name was found, 2 usage error.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const DEFAULT_NAMES_FILE = path.join(os.homedir(), '.config', 'family-photos', 'forbidden-names');
const SEPARATORS = '[\\s._-]*';

function parseNames(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** "First Last" -> /first[\s._-]*last/i */
function nameToRegex(name) {
  const parts = name
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map(escapeRegex);
  // Every part is escaped above, so the pattern is literal words joined by a
  // fixed separator class: no user-controlled regex syntax, no ReDoS.
  // eslint-disable-next-line security/detect-non-literal-regexp
  return new RegExp(parts.join(SEPARATORS), 'i');
}

function loadNames({ env = process.env, namesFile = DEFAULT_NAMES_FILE } = {}) {
  if (env.FORBIDDEN_NAMES && env.FORBIDDEN_NAMES.trim()) {
    return { names: parseNames(env.FORBIDDEN_NAMES), source: 'FORBIDDEN_NAMES' };
  }
  // The file path comes from the operator (flag or the fixed default), never from repo content.
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  if (namesFile && fs.existsSync(namesFile)) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return { names: parseNames(fs.readFileSync(namesFile, 'utf8')), source: namesFile };
  }
  return { names: [], source: null };
}

function isBinary(buf) {
  return buf.subarray(0, 8192).includes(0);
}

/** Labels of lines in `text` that match, e.g. "src/a.js:12". Never the text. */
function scanText(regexes, label, text) {
  const hits = [];
  String(text)
    .split('\n')
    .forEach((line, i) => {
      if (regexes.some((re) => re.test(line))) {
        hits.push(`${label}:${i + 1}`);
      }
    });
  return hits;
}

function git(cwd, args, opts = {}) {
  return execFileSync('git', args, { cwd, maxBuffer: 256 * 1024 * 1024, ...opts });
}

function scanPathsAndContents(regexes, files, readFile) {
  const hits = [];
  for (const file of files) {
    if (regexes.some((re) => re.test(file))) {
      hits.push(`${file} (file or folder name)`);
    }
    const buf = readFile(file);
    if (buf && !isBinary(buf)) {
      hits.push(...scanText(regexes, file, buf.toString('utf8')));
    }
  }
  return hits;
}

function scanTree(regexes, cwd) {
  const files = git(cwd, ['ls-files', '-z']).toString('utf8').split('\0').filter(Boolean);
  return scanPathsAndContents(regexes, files, (f) => {
    try {
      return git(cwd, ['show', `HEAD:${f}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      // Tracked but not yet committed: read the index copy.
      return git(cwd, ['show', `:${f}`], { stdio: ['ignore', 'pipe', 'ignore'] });
    }
  });
}

function scanStaged(regexes, cwd) {
  const files = git(cwd, ['diff', '--cached', '--name-only', '-z', '--diff-filter=ACMR'])
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
  return scanPathsAndContents(regexes, files, (f) => git(cwd, ['show', `:${f}`]));
}

function scanMessages(regexes, cwd, range) {
  let out;
  try {
    out = git(cwd, ['log', '--format=%H%x00%an <%ae>%n%cn <%ce>%n%B%x1e', ...(range ? [range] : ['--all'])], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString('utf8');
  } catch {
    return []; // no commits yet
  }
  const hits = [];
  for (const record of out.split('\x1e')) {
    const [hash, body] = record.replace(/^\n/, '').split('\0');
    if (hash && body !== undefined && regexes.some((re) => re.test(body))) {
      hits.push(`commit ${hash.slice(0, 12)} (message or author)`);
    }
  }
  return hits;
}

function parseArgs(argv) {
  const args = { tree: false, staged: false, messages: false, range: null, messageFile: null, namesFile: DEFAULT_NAMES_FILE };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--tree') {
      args.tree = true;
    } else if (a === '--staged') {
      args.staged = true;
    } else if (a === '--messages') {
      args.messages = true;
    } else if (a.startsWith('--messages=')) {
      args.messages = true;
      args.range = a.slice('--messages='.length);
    } else if (a === '--message-file') {
      args.messageFile = argv[(i += 1)];
    } else if (a === '--names-file') {
      args.namesFile = argv[(i += 1)];
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  if (!args.tree && !args.staged && !args.messages && !args.messageFile) {
    throw new Error('choose at least one of --tree, --staged, --messages, --message-file');
  }
  return args;
}

function run(argv, { env = process.env, cwd = process.cwd(), log = (s) => process.stdout.write(`${s}\n`) } = {}) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    log(`check-forbidden-names: ${err.message}`);
    return 2;
  }
  const { names, source } = loadNames({ env, namesFile: args.namesFile });
  if (names.length === 0) {
    log('SKIPPED: no forbidden names configured (set FORBIDDEN_NAMES, or create ~/.config/family-photos/forbidden-names).');
    return 0;
  }
  const regexes = names.map(nameToRegex);
  const hits = [];
  if (args.tree) {
    hits.push(...scanTree(regexes, cwd));
  }
  if (args.staged) {
    hits.push(...scanStaged(regexes, cwd));
  }
  if (args.messages) {
    hits.push(...scanMessages(regexes, cwd, args.range));
  }
  if (args.messageFile) {
    // The commit-msg hook passes git's own message file.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    hits.push(...scanText(regexes, 'commit message', fs.readFileSync(args.messageFile, 'utf8')));
  }
  if (hits.length > 0) {
    log(`FORBIDDEN NAME FOUND (${names.length} name(s) from ${source === 'FORBIDDEN_NAMES' ? 'FORBIDDEN_NAMES' : 'the names file'}) at:`);
    hits.forEach((h) => log(`  ${h}`));
    return 1;
  }
  log(`ok: no forbidden names (${names.length} checked)`);
  return 0;
}

if (require.main === module) {
  process.exit(run(process.argv.slice(2)));
}

module.exports = { run, nameToRegex, parseNames, loadNames, scanText, DEFAULT_NAMES_FILE };
