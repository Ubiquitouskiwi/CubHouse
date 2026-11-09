'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  photoCapabilities,
  canViewPhoto,
  isInPhotoAudience,
  canComment,
  canReact,
  canUseDevPrivileges,
  normalizePhotoAudience,
  portalCapabilities,
} = require('../src/permissions');

const parent = { role: 'parent', id: 'p' };
const user = { role: 'user', id: 'u', groupIds: ['g1'] };
const other = { role: 'user', id: 'o', groupIds: [] };
const dev = { role: 'dev', id: 'd', groupIds: [] };

test('parents see and control every photo, including private and hidden ones', () => {
  const photo = { audienceType: 'parents', hidden: true };
  assert.equal(canViewPhoto(parent, photo), true);
  const cap = photoCapabilities(parent, photo);
  assert.equal(cap.setPermissions && cap.delete && cap.download, true);
});

test('private (parents) audience is invisible to every non-parent', () => {
  const photo = { audienceType: 'parents' };
  for (const v of [user, other, dev]) {
    assert.equal(canViewPhoto(v, photo), false);
  }
});

test('a missing or unknown audience fails CLOSED (parents only)', () => {
  assert.equal(normalizePhotoAudience(undefined), 'parents');
  assert.equal(normalizePhotoAudience('public'), 'parents');
  assert.equal(isInPhotoAudience(user, {}), false);
  assert.equal(isInPhotoAudience(user, { audienceType: 'bogus' }), false);
});

test('hidden and pending photos are invisible to non-parents', () => {
  assert.equal(canViewPhoto(user, { audienceType: 'everyone', hidden: true }), false);
  assert.equal(canViewPhoto(user, { audienceType: 'everyone', pendingApproval: true }), false);
});

test('users and groups audiences admit only the listed people', () => {
  const byUser = { audienceType: 'users', audienceUserIds: ['u'] };
  const byGroup = { audienceType: 'groups', audienceGroupIds: ['g1'] };
  assert.equal(canViewPhoto(user, byUser), true);
  assert.equal(canViewPhoto(other, byUser), false);
  assert.equal(canViewPhoto(user, byGroup), true);
  assert.equal(canViewPhoto(other, byGroup), false);
});

test('download needs downloadable AND audience membership for non-parents', () => {
  assert.equal(photoCapabilities(user, { audienceType: 'everyone', downloadable: false }).download, false);
  assert.equal(photoCapabilities(user, { audienceType: 'everyone', downloadable: true }).download, true);
  assert.equal(photoCapabilities(other, { audienceType: 'users', audienceUserIds: ['u'], downloadable: true }).download, false);
});

test('dev never gets photo control and never sees contact details or codes', () => {
  const cap = photoCapabilities(dev, { audienceType: 'everyone' });
  assert.equal(cap.setPermissions || cap.delete || cap.hide || cap.upload, false);
  const portal = portalCapabilities('dev');
  assert.equal(portal.viewMemberContact, false);
  assert.equal(portal.viewAccessCodes, false);
  assert.equal(portal.manageMembers, false);
});

test('dev privileges are development-only', () => {
  const config = require('../src/config');
  assert.equal(canUseDevPrivileges(dev), true);
  const saved = config.isProduction;
  config.isProduction = true;
  try {
    assert.equal(canUseDevPrivileges(dev), false);
    assert.equal(canUseDevPrivileges(parent), true);
  } finally {
    config.isProduction = saved;
  }
});

test('a muted member cannot comment or react; parents are never muted', () => {
  const photo = { audienceType: 'everyone' };
  const muted = { ...user, commentsMuted: true };
  assert.equal(canComment(muted, photo), false);
  assert.equal(canReact(muted, photo), false);
  assert.equal(canComment({ ...parent, commentsMuted: true }, photo), true);
});

test('non-parents may contribute but get no photo control', () => {
  const cap = photoCapabilities(user);
  assert.equal(cap.contribute, true);
  assert.equal(cap.upload || cap.setPermissions, false);
});
