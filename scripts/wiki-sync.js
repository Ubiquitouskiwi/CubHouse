#!/usr/bin/env node
'use strict';

/**
 * Build the GitHub Wiki from docs/guide (run by .github/workflows/wiki-sync.yml).
 *
 *   node scripts/wiki-sync.js --out <wiki clone dir> --repo owner/name --sha <commit> [--guide docs/guide]
 *
 * - Pages get fixed wiki names (index.md is Home.md, faq.md is FAQ.md, ...).
 * - Links between guide pages become wiki page links; links that leave
 *   docs/guide become https://github.com/<repo>/blob/beta/... URLs (beta is the default branch).
 * - docs/guide/img/** is copied to img/** in the wiki. Wiki pages do not
 *   resolve relative image paths in Markdown reliably, so images point at the
 *   wiki's raw URL instead.
 * - _Sidebar.md (index.md's order) and _Footer.md ("edit docs/guide") are added.
 * - The output directory is MIRRORED: files that are not in the generated
 *   tree are deleted. Only the top-level .git is left alone.
 * - Every generated internal link must resolve, or the script fails.
 *
 * No dependencies. Exit codes: 0 ok, 1 a broken link or bad input, 2 usage.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.join(__dirname, '..');

// Fixed, deterministic page names. A new guide page needs a line here.
const PAGE_NAMES = Object.freeze({
  'index.md': 'Home',
  'getting-started.md': 'Getting-Started',
  'family-members.md': 'Family-Members',
  'guardians.md': 'Guardians',
  'two-guardian-governance.md': 'Two-Guardian-Governance',
  'security-and-privacy.md': 'Security-And-Privacy',
  'account-recovery.md': 'Account-Recovery',
  'data-export-and-erasure.md': 'Data-Export-And-Erasure',
  'faq.md': 'FAQ',
  'troubleshooting.md': 'Troubleshooting',
});

const SPECIAL_PAGES = ['_Sidebar.md', '_Footer.md'];

function pageName(file) {
  const name = PAGE_NAMES[file];
  if (!name) {
    throw new Error(`docs/guide/${file} has no wiki page name: add it to PAGE_NAMES in scripts/wiki-sync.js`);
  }
  return name;
}

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to dashes. */
function slug(heading) {
  return heading.trim().toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s/g, '-');
}

/** Lines outside ``` fences, with their index, so code is never rewritten. */
function proseLines(text) {
  let inFence = false;
  return text.split('\n').map((line) => {
    const fence = /^\s*```/.test(line);
    const prose = !inFence && !fence;
    if (fence) {
      inFence = !inFence;
    }
    return { line, prose };
  });
}

function headings(text) {
  const set = new Set();
  for (const { line, prose } of proseLines(text)) {
    const m = prose && /^#{1,6}\s+(.*)$/.exec(line);
    if (m) {
      set.add(slug(m[1]));
    }
  }
  return set;
}

function title(text, fallback) {
  const m = /^# (.+)$/m.exec(text);
  return m ? m[1].trim() : fallback;
}

// [text](target) and ![alt](target); targets in this guide never hold spaces or parentheses.
const LINK_RE = /(!?)\[([^\]]*)\]\(([^)\s]+)\)/g;

/**
 * Replace link targets outside code (``` fences and `inline code`). Works on
 * the whole text, because a link's label may wrap onto the next line.
 */
function mapLinks(text, fn) {
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/)
    .map((part, i) =>
      i % 2 === 1
        ? part
        : part.replace(LINK_RE, (all, bang, label, target) => `${bang}[${label}](${fn(target, { image: bang === '!' })})`)
    )
    .join('');
}

/**
 * Rewrite one link target found in docs/guide/<file>.
 *   repo  owner/name     guideRel  'docs/guide' (repo-relative, forward slashes)
 */
function rewriteTarget(target, { file, repo, guideRel }) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#')) {
    return target;
  }
  const hashAt = target.indexOf('#');
  const p = hashAt === -1 ? target : target.slice(0, hashAt);
  const frag = hashAt === -1 ? '' : target.slice(hashAt);
  const repoPath = path.posix.normalize(path.posix.join(guideRel, path.posix.dirname(file), p));
  if (repoPath === '..' || repoPath.startsWith('../')) {
    throw new Error(`docs/guide/${file}: link ${target} points outside the repository`);
  }
  const inGuide = repoPath.startsWith(`${guideRel}/`);
  const guidePath = inGuide ? repoPath.slice(guideRel.length + 1) : null;
  if (inGuide && guidePath.endsWith('.md') && !guidePath.includes('/')) {
    return `${pageName(guidePath)}${frag}`;
  }
  if (inGuide && guidePath.startsWith('img/')) {
    // shortcut: raw wiki URLs only render for a public repository; a private
    // one would need the images hosted another way.
    return `https://raw.githubusercontent.com/wiki/${repo}/${guidePath}${frag}`;
  }
  return `https://github.com/${repo}/blob/beta/${repoPath}${frag}`;
}

function listFiles(dir, base = dir) {
  const out = [];
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, base));
    } else if (entry.isFile()) {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out.sort();
}

/**
 * The wiki as a Map of relative path to contents (string or Buffer).
 * `guideDir` is an absolute path inside `repoRoot`.
 */
function buildWikiTree({ guideDir, repoRoot = REPO_ROOT, repo, sha }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) {
    throw new Error('--repo must look like owner/name');
  }
  if (!/^[0-9a-f]{7,40}$/.test(sha || '')) {
    throw new Error('--sha must be a commit hash');
  }
  const guideRel = path.relative(repoRoot, guideDir).split(path.sep).join('/');
  const tree = new Map();
  const titles = new Map();
  const files = listFiles(guideDir);

  for (const file of files.filter((f) => f.endsWith('.md') && !f.includes('/'))) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    const text = fs.readFileSync(path.join(guideDir, file), 'utf8');
    const name = pageName(file);
    titles.set(name, title(text, name));
    tree.set(`${name}.md`, mapLinks(text, (t) => rewriteTarget(t, { file, repo, guideRel })));
  }
  if (!tree.has('Home.md')) {
    throw new Error('docs/guide/index.md is required (it becomes Home)');
  }
  for (const file of files.filter((f) => f.startsWith('img/'))) {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    tree.set(file, fs.readFileSync(path.join(guideDir, file)));
  }

  // Sidebar: Home, then pages in the order index.md first links to them, then any others.
  const order = ['Home'];
  mapLinks(tree.get('Home.md'), (t) => {
    const page = t.split('#')[0];
    if (tree.has(`${page}.md`) && !order.includes(page)) {
      order.push(page);
    }
    return t;
  });
  for (const name of [...titles.keys()].sort()) {
    if (!order.includes(name)) {
      order.push(name);
    }
  }
  tree.set('_Sidebar.md', `**User guide**\n\n${order.map((n) => `- [${titles.get(n)}](${n})`).join('\n')}\n`);

  const short = sha.slice(0, 7);
  tree.set(
    '_Footer.md',
    `This wiki is generated from [${guideRel}](https://github.com/${repo}/tree/main/${guideRel}) on \`main\` ` +
      `(commit [${short}](https://github.com/${repo}/commit/${sha})). ` +
      `Edit the files there: changes made here are overwritten on the next sync.\n`
  );
  return tree;
}

/** Every internal link in generated pages must reach a generated page, heading or image. */
function checkLinks(tree, repo) {
  const problems = [];
  const rawPrefix = `https://raw.githubusercontent.com/wiki/${repo}/`;
  const anchorCache = new Map();
  const anchorsOf = (page) => {
    if (!anchorCache.has(page)) {
      anchorCache.set(page, headings(String(tree.get(`${page}.md`))));
    }
    return anchorCache.get(page);
  };
  for (const [file, body] of tree) {
    if (!file.endsWith('.md')) {
      continue;
    }
    const self = file.slice(0, -3);
    mapLinks(String(body), (target) => {
      if (target.startsWith(rawPrefix)) {
        if (!tree.has(target.slice(rawPrefix.length))) {
          problems.push(`${file}: missing image ${target}`);
        }
      } else if (!/^[a-z][a-z0-9+.-]*:/i.test(target)) {
        const [page, frag] = target.split('#');
        const dest = page || self;
        if (!tree.has(`${dest}.md`) || SPECIAL_PAGES.includes(`${dest}.md`)) {
          problems.push(`${file}: missing page ${target}`);
        } else if (frag && !anchorsOf(dest).has(frag)) {
          problems.push(`${file}: missing heading ${target}`);
        }
      }
      return target;
    });
  }
  return problems;
}

/** Make `outDir` hold exactly `tree`, leaving the top-level .git alone. */
function mirror(tree, outDir) {
  // eslint-disable-next-line security/detect-non-literal-fs-filename
  fs.mkdirSync(outDir, { recursive: true });
  const removed = [];
  const walk = (dir) => {
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(outDir, full).split(path.sep).join('/');
      if (rel === '.git') {
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
        // eslint-disable-next-line security/detect-non-literal-fs-filename
        if (fs.readdirSync(full).length === 0) {
          // eslint-disable-next-line security/detect-non-literal-fs-filename
          fs.rmdirSync(full);
        }
      } else if (!tree.has(rel)) {
        fs.rmSync(full);
        removed.push(rel);
      }
    }
  };
  walk(outDir);
  for (const [rel, body] of tree) {
    const full = path.join(outDir, ...rel.split('/'));
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    fs.mkdirSync(path.dirname(full), { recursive: true });
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    fs.writeFileSync(full, body);
  }
  return removed.sort();
}

function parseArgs(argv) {
  const args = { guide: path.join(REPO_ROOT, 'docs', 'guide') };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i].replace(/^--/, '');
    if (!['out', 'repo', 'sha', 'guide'].includes(key) || argv[i + 1] === undefined) {
      return null;
    }
    args[key] = argv[i + 1];
  }
  return args.out && args.repo && args.sha ? args : null;
}

function main(argv) {
  const args = parseArgs(argv);
  if (!args) {
    process.stderr.write('usage: node scripts/wiki-sync.js --out <dir> --repo owner/name --sha <commit> [--guide docs/guide]\n');
    return 2;
  }
  const tree = buildWikiTree({ guideDir: path.resolve(args.guide), repo: args.repo, sha: args.sha });
  const problems = checkLinks(tree, args.repo);
  if (problems.length > 0) {
    problems.forEach((p) => process.stderr.write(`broken link: ${p}\n`));
    return 1;
  }
  const removed = mirror(tree, path.resolve(args.out));
  removed.forEach((r) => process.stdout.write(`removed ${r}\n`));
  process.stdout.write(`Wiki tree built: ${tree.size} files, ${removed.length} stale file(s) removed.\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { PAGE_NAMES, pageName, slug, rewriteTarget, mapLinks, buildWikiTree, checkLinks, mirror };
