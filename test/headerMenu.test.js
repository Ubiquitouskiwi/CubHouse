'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { startApp, seedFamily } = require('./helpers');

test('the account menu is a labelled disclosure button that controls its panel', async (t) => {
  const env = await startApp();
  t.after(env.close);
  await seedFamily(env);
  const c = env.client();
  await c.login('member@test.com');
  const { body } = await c.get('/home');

  const button = /<button[^>]*data-profile-trigger[^>]*>/.exec(body);
  assert.ok(button, 'menu button rendered');
  assert.match(button[0], /type="button"/);
  assert.match(button[0], /aria-expanded="false"/);
  assert.match(button[0], /aria-controls="profile-dropdown"/);
  assert.match(button[0], /aria-label="Account menu for Grandma"/);

  const panel = /<div[^>]*id="profile-dropdown"[^>]*>/.exec(body);
  assert.ok(panel, 'the panel the button controls exists');
  assert.match(panel[0], /\shidden(\s|>)/);
  // Plain links and a form, not an ARIA menu that would promise arrow keys.
  assert.doesNotMatch(body, /role="menu(item)?"/);
  for (const href of ['/settings', '/settings/security']) {
    assert.ok(body.includes(`class="profile-dropdown-item" href="${href}"`), href);
  }
  assert.match(body, /<button type="submit" class="profile-dropdown-item profile-dropdown-signout">Sign out<\/button>/);
});
