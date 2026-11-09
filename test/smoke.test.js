'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, seedFamily, addPhoto } = require('./helpers');

// Every main page renders for each role without a server error.
test('smoke: every main page renders for parent and member', async (t) => {
  const env = await startApp();
  t.after(env.close);
  const { member } = await seedFamily(env);
  const photo = await addPhoto(env, { audienceType: 'everyone', downloadable: true });

  const parent = env.client();
  assert.equal((await parent.login('parent@test.com')).location, '/home');
  for (const path of ['/home', '/photos', `/photos/${photo.id}`, '/albums', '/settings', '/settings/security', '/admin', '/admin/audit', '/photos/downloads', '/privacy']) {
    const res = await parent.get(path);
    assert.equal(res.status, 200, `parent ${path} -> ${res.status} ${res.body.slice(0, 300)}`);
  }

  const fam = env.client();
  assert.equal((await fam.login(member.email)).location, '/home');
  for (const path of ['/home', '/photos', `/photos/${photo.id}`, '/albums', '/settings', '/privacy']) {
    const res = await fam.get(path);
    assert.equal(res.status, 200, `member ${path} -> ${res.status} ${res.body.slice(0, 300)}`);
  }
  const img = await fam.get(`/media/${photo.id}/thumb`);
  assert.equal(img.status, 200);
  assert.equal(img.headers['content-type'], 'image/jpeg');
  const dl = await fam.get(`/photos/${photo.id}/download`);
  assert.equal(dl.status, 200, dl.body.slice(0, 300));
});

test('smoke: the footer shows APP_FOOTER_TEXT, HTML-escaped', async (t) => {
  const config = require('../src/config');
  const previous = config.app.footerText;
  config.app.footerText = 'Our <b>shared</b> album';
  t.after(() => {
    config.app.footerText = previous;
  });
  const env = await startApp();
  t.after(env.close);
  const res = await env.client().get('/login');
  assert.equal(res.status, 200);
  assert.match(res.body, /Our &lt;b&gt;shared&lt;\/b&gt; album/);
});
