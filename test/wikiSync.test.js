'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  PAGE_NAMES,
  pageName,
  rewriteTarget,
  mapLinks,
  buildWikiTree,
  checkLinks,
  mirror,
} = require('../scripts/wiki-sync');

const REPO = 'example-owner/example-repo';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const RAW = `https://raw.githubusercontent.com/wiki/${REPO}`;
const BLOB = `https://github.com/${REPO}/blob/beta`;

function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A tiny repo with docs/guide, to build from. */
function fixtureRepo(t, pages) {
  const root = tempDir(t, 'wiki-src-');
  const guide = path.join(root, 'docs', 'guide');
  fs.mkdirSync(path.join(guide, 'img', 'sub'), { recursive: true });
  for (const [name, body] of Object.entries(pages)) {
    fs.writeFileSync(path.join(guide, name), body);
  }
  fs.writeFileSync(path.join(guide, 'img', 'a.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0]));
  fs.writeFileSync(path.join(guide, 'img', 'sub', 'b.png'), Buffer.from([1, 2, 0]));
  return { root, guide };
}

const opts = { file: 'guardians.md', repo: REPO, guideRel: 'docs/guide' };

test('pages get fixed wiki names, and an unmapped page fails loudly', () => {
  assert.equal(pageName('index.md'), 'Home');
  assert.equal(pageName('getting-started.md'), 'Getting-Started');
  assert.equal(pageName('two-guardian-governance.md'), 'Two-Guardian-Governance');
  assert.equal(pageName('faq.md'), 'FAQ');
  assert.throws(() => pageName('new-page.md'), /PAGE_NAMES/);
  assert.equal(new Set(Object.values(PAGE_NAMES)).size, Object.keys(PAGE_NAMES).length, 'names are unique');
});

test('links between guide pages become wiki page links, keeping anchors', () => {
  assert.equal(rewriteTarget('faq.md', opts), 'FAQ');
  assert.equal(rewriteTarget('faq.md#for-guardians', opts), 'FAQ#for-guardians');
  assert.equal(rewriteTarget('./account-recovery.md#i-lost-my-phone', opts), 'Account-Recovery#i-lost-my-phone');
  assert.equal(rewriteTarget('#same-page', opts), '#same-page');
});

test('links outside docs/guide become absolute blob URLs on main', () => {
  assert.equal(rewriteTarget('../RUNBOOK.md#1b-x', opts), `${BLOB}/docs/RUNBOOK.md#1b-x`);
  assert.equal(rewriteTarget('../../README.md', opts), `${BLOB}/README.md`);
  assert.equal(rewriteTarget('https://example.com/a.md', opts), 'https://example.com/a.md');
  assert.throws(() => rewriteTarget('../../../etc/passwd', opts), /outside the repository/);
});

test('images point at the raw wiki copy under img/', () => {
  assert.equal(rewriteTarget('img/admin-top.png', opts), `${RAW}/img/admin-top.png`);
  assert.equal(rewriteTarget('./img/sub/b.png', opts), `${RAW}/img/sub/b.png`);
});

test('code is never rewritten, and a label may wrap onto the next line', () => {
  const src = 'See [the\nFAQ](faq.md), `[x](faq.md)` and\n```\n[y](faq.md)\n```\n![pic](img/a.png)';
  const out = mapLinks(src, (t) => rewriteTarget(t, opts));
  assert.equal(out, `See [the\nFAQ](FAQ), \`[x](faq.md)\` and\n\`\`\`\n[y](faq.md)\n\`\`\`\n![pic](${RAW}/img/a.png)`);
});

test('the tree has renamed pages, images, a sidebar in index order and a footer', (t) => {
  const { root, guide } = fixtureRepo(t, {
    'index.md': '# Guide\n\nStart: [FAQ](faq.md), then [Recovery](account-recovery.md#top), [FAQ again](faq.md).\n![pic](img/a.png)\n',
    'faq.md': '# Questions\n\nBack [home](index.md). Runbook: [r](../RUNBOOK.md).\n',
    'account-recovery.md': '# Recovery\n\n## Top\n\n![b](img/sub/b.png)\n',
    'troubleshooting.md': '# Fixes\n\nNot linked from the index.\n',
  });
  const tree = buildWikiTree({ guideDir: guide, repoRoot: root, repo: REPO, sha: SHA });
  assert.deepEqual(
    [...tree.keys()].sort(),
    ['Account-Recovery.md', 'FAQ.md', 'Home.md', 'Troubleshooting.md', '_Footer.md', '_Sidebar.md', 'img/a.png', 'img/sub/b.png']
  );
  assert.match(tree.get('Home.md'), /\[FAQ\]\(FAQ\), then \[Recovery\]\(Account-Recovery#top\)/);
  assert.match(tree.get('FAQ.md'), new RegExp(`\\[r\\]\\(${BLOB.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/docs/RUNBOOK\\.md\\)`));
  assert.ok(Buffer.isBuffer(tree.get('img/a.png')));
  assert.equal(
    tree.get('_Sidebar.md'),
    '**User guide**\n\n- [Guide](Home)\n- [Questions](FAQ)\n- [Recovery](Account-Recovery)\n- [Fixes](Troubleshooting)\n'
  );
  assert.match(tree.get('_Footer.md'), /generated from \[docs\/guide\]/);
  assert.match(tree.get('_Footer.md'), new RegExp(`\\[0123456\\]\\(https://github\\.com/${REPO}/commit/${SHA}\\)`));
  assert.deepEqual(checkLinks(tree, REPO), []);
});

test('broken pages, headings and images are reported', () => {
  const tree = new Map([
    ['Home.md', `# Home\n\n## Here\n\n[a](FAQ) [b](#nowhere) [c](#here) ![d](${RAW}/img/gone.png) [e](_Sidebar)`],
    ['_Sidebar.md', '- [Home](Home)'],
  ]);
  assert.deepEqual(checkLinks(tree, REPO), [
    'Home.md: missing page FAQ',
    'Home.md: missing heading #nowhere',
    `Home.md: missing image ${RAW}/img/gone.png`,
    'Home.md: missing page _Sidebar',
  ]);
});

test('mirror deletes stale pages and images, keeps .git, and writes the tree', (t) => {
  const out = tempDir(t, 'wiki-out-');
  fs.mkdirSync(path.join(out, '.git'));
  fs.writeFileSync(path.join(out, '.git', 'HEAD'), 'ref: refs/heads/master\n');
  fs.writeFileSync(path.join(out, 'Old-Page.md'), 'renamed away');
  fs.mkdirSync(path.join(out, 'img', 'old'), { recursive: true });
  fs.writeFileSync(path.join(out, 'img', 'old', 'x.png'), 'x');
  fs.writeFileSync(path.join(out, 'Home.md'), 'stale copy');
  const tree = new Map([
    ['Home.md', '# Home\n'],
    ['img/a.png', Buffer.from([1])],
  ]);
  assert.deepEqual(mirror(tree, out), ['Old-Page.md', 'img/old/x.png']);
  assert.equal(fs.readFileSync(path.join(out, 'Home.md'), 'utf8'), '# Home\n');
  assert.equal(fs.existsSync(path.join(out, 'img', 'old')), false, 'empty folders go too');
  assert.equal(fs.readFileSync(path.join(out, '.git', 'HEAD'), 'utf8'), 'ref: refs/heads/master\n');
  assert.deepEqual(mirror(tree, out), [], 'a second run changes nothing');
});

test('the real docs/guide converts with every internal link resolving', () => {
  const guideDir = path.join(__dirname, '..', 'docs', 'guide');
  const tree = buildWikiTree({ guideDir, repo: REPO, sha: SHA });
  const sources = fs.readdirSync(guideDir).filter((f) => f.endsWith('.md'));
  for (const f of sources) {
    assert.ok(tree.has(`${pageName(f)}.md`), f);
  }
  for (const img of fs.readdirSync(path.join(guideDir, 'img'))) {
    assert.ok(tree.has(`img/${img}`), img);
  }
  assert.deepEqual(checkLinks(tree, REPO), []);
  for (const [file, body] of tree) {
    if (file.endsWith('.md')) {
      // No relative .md or img/ link survives the conversion.
      mapLinks(String(body), (target) => {
        assert.doesNotMatch(target, /^(?![a-z]+:).*\.md(#|$)/i, `${file}: ${target}`);
        assert.doesNotMatch(target, /^\.?\/?img\//, `${file}: ${target}`);
        return target;
      });
    }
  }
  assert.match(tree.get('_Sidebar.md'), /^\*\*User guide\*\*\n\n- \[Cubhouse user guide\]\(Home\)\n- \[Getting started\]\(Getting-Started\)/);
});
