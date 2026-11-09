'use strict';

/**
 * Sign-in lockout, persisted through the data store.
 *
 * Two counters per attempt:
 *   - `ip:<ip>:<identity>`  locks one network out of one account quickly
 *     (maxLoginFailures, default 8).
 *   - `acct:<identity>`     locks the account against distributed guessing
 *     from many IPs (maxAccountFailures, default 20).
 *
 * The store is passed explicitly. (An earlier version read `req.store`, which
 * was never set, so the first sign-in threw and lockout never worked.)
 */

function normalizeIdentity(identity) {
  return String(identity || '').trim().toLowerCase();
}

function lockoutKeys(ip, identity) {
  const id = normalizeIdentity(identity);
  return { ipKey: `ip:${ip || 'unknown'}:${id}`, accountKey: `acct:${id}` };
}

async function getFailureState(store, key) {
  const state = await store.getAuthFailureState(key);
  return state || { count: 0, lockedUntil: 0 };
}

async function isLocked(store, keys, now = Date.now()) {
  const [a, b] = await Promise.all([
    getFailureState(store, keys.ipKey),
    getFailureState(store, keys.accountKey),
  ]);
  return (a.lockedUntil || 0) > now || (b.lockedUntil || 0) > now;
}

async function bump(store, key, max, lockoutMs, now) {
  const current = await getFailureState(store, key);
  // An expired lock starts a fresh count.
  const base = current.lockedUntil && current.lockedUntil <= now ? 0 : current.count || 0;
  const count = base + 1;
  const lockedUntil = count >= max ? now + lockoutMs : 0;
  await store.setAuthFailureState(key, { count, lockedUntil });
  return lockedUntil > 0;
}

/** Record a failure on both counters. Returns true if either is now locked. */
async function registerFailure(store, keys, security, now = Date.now()) {
  const [a, b] = await Promise.all([
    bump(store, keys.ipKey, security.maxLoginFailures, security.loginLockoutMs, now),
    bump(store, keys.accountKey, security.maxAccountFailures, security.loginLockoutMs, now),
  ]);
  return a || b;
}

async function clearFailures(store, keys) {
  await Promise.all([
    store.clearAuthFailureState(keys.ipKey),
    store.clearAuthFailureState(keys.accountKey),
  ]);
}

module.exports = {
  lockoutKeys,
  getFailureState,
  isLocked,
  registerFailure,
  clearFailures,
};
