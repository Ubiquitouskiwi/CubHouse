'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const { ROLES, canUseDevPrivileges } = require('./permissions');

const SALT_ROUNDS = 12;

async function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

async function verifyPassword(plain, hash) {
  return bcrypt.compare(String(plain || ''), hash);
}

// A real bcrypt hash of a random value, computed once. Comparing against it
// when an email is unknown makes a failed sign-in take the same time whether
// or not the account exists, so timing does not reveal who is a member.
let dummyHashPromise = null;
function dummyHash() {
  if (!dummyHashPromise) {
    dummyHashPromise = bcrypt.hash(crypto.randomBytes(16).toString('hex'), SALT_ROUNDS);
  }
  return dummyHashPromise;
}

/** Verify credentials in constant-ish time. Returns the user or null. */
async function checkCredentials(store, email, password) {
  const user = email ? await store.findUserByEmail(email) : null;
  const hash = user ? user.passwordHash : await dummyHash();
  const ok = await verifyPassword(password, hash);
  return user && ok ? user : null;
}

/**
 * Human-friendly access code, e.g. "INVITE-7KQ2-9FMX-3HWR": 12 characters from
 * a 32-symbol unambiguous alphabet (60 bits) from a CSPRNG.
 */
function generateAccessCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const group = () =>
    Array.from({ length: 4 }, () => alphabet[crypto.randomInt(0, alphabet.length)]).join('');
  return `INVITE-${group()}-${group()}-${group()}`;
}

function requireAuth(req, res, next) {
  if (req.session && req.session.userId && req.user) {
    return next();
  }
  req.flash('error', 'Please sign in to continue.');
  return res.redirect('/login');
}

// Parent (guardian): full control. The role is reloaded from the store on
// every request by the session guard, so a demoted parent loses this at once.
function requireParent(req, res, next) {
  if (req.user && req.user.role === ROLES.PARENT) {
    return next();
  }
  req.flash('error', 'That page is for parents only.');
  return res.redirect(req.user ? '/home' : '/login');
}

// Elevated portal access (parent, or dev outside production only).
function requireDevOrParent(req, res, next) {
  if (req.user && canUseDevPrivileges(req.user)) {
    return next();
  }
  req.flash('error', 'You do not have access to that page.');
  return res.redirect(req.user ? '/home' : '/login');
}

// Support operator, with two-step verification on. Anyone else signed in
// gets a 403 (not a redirect), so a guardian cannot mistake the page for theirs.
function requireOperator(req, res, next) {
  if (!req.user) {
    req.flash('error', 'Please sign in to continue.');
    return res.redirect('/login');
  }
  if (req.user.role === ROLES.OPERATOR && req.user.mfaEnabled) {
    return next();
  }
  return res.status(403).render('error', { title: 'Not allowed', message: 'You do not have access to that page.' });
}

function redirectIfAuthed(req, res, next) {
  if (req.session && req.session.userId) {
    return res.redirect('/home');
  }
  return next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  checkCredentials,
  generateAccessCode,
  requireAuth,
  requireParent,
  requireDevOrParent,
  requireOperator,
  redirectIfAuthed,
};
