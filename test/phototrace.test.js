'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const sharp = require('sharp');
const { newTraceToken, shortRef, renderDownload, readTraceToken, watermarkSvg } = require('../src/phototrace');
const { plainJpeg } = require('./fixtures/makeImages');

test('trace tokens are random, URL-safe, 16 characters', () => {
  const a = newTraceToken();
  const b = newTraceToken();
  assert.match(a, /^[A-Za-z0-9_-]{16}$/);
  assert.notEqual(a, b);
  assert.equal(shortRef(a), a.slice(0, 8).toUpperCase());
});

test('a rendered download carries the opaque token and nothing identifying', async () => {
  const token = newTraceToken();
  const out = await renderDownload(await plainJpeg(), { token, watermark: false });
  assert.equal(out.metadataEmbedded, true);
  assert.equal(out.watermarkApplied, false);
  assert.equal(await readTraceToken(out.buffer), token);
  const text = out.buffer.toString('latin1');
  for (const pii of ['Grandma', '@', 'account', 'Shared with']) {
    assert.ok(!text.includes(pii), `download contains "${pii}"`);
  }
});

test('the visible watermark actually changes the pixels', async () => {
  const src = await plainJpeg({ color: '#ffffff' });
  const token = newTraceToken();
  const plain = await renderDownload(src, { token, watermark: false });
  const marked = await renderDownload(src, { token, watermark: true });
  assert.equal(marked.watermarkApplied, true);
  const statsPlain = await sharp(plain.buffer).stats();
  const statsMarked = await sharp(marked.buffer).stats();
  // The dark band lowers the minimum and mean brightness.
  assert.ok(statsMarked.channels[0].mean < statsPlain.channels[0].mean - 5);
});

test('the watermark label shows a reference, never a name, and escapes markup', () => {
  const svg = watermarkSvg(800, 600, 'abc<def>ghijklmn').toString();
  assert.match(svg, /Ref ABC&lt;DEF&gt;/);
  assert.doesNotMatch(svg, /<def>/);
  assert.doesNotMatch(svg, /Shared with/);
});

test('readTraceToken returns null for a file with no reference', async () => {
  assert.equal(await readTraceToken(await plainJpeg()), null);
  assert.equal(await readTraceToken(Buffer.from('not an image')), null);
});
