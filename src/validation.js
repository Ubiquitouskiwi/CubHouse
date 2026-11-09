'use strict';

const config = require('./config');

/**
 * Field validation shared across routes.
 *
 * `str()` coerces any body value to a single trimmed string. The urlencoded
 * parser turns a repeated field (name=a&name=b) into an array, and calling
 * .trim() on an array throws; every route reads fields through `str()`.
 */

const THEMES = Object.freeze(['light', 'dark', 'system']);
const DEFAULT_THEME = 'system';

const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Display names that would let a member impersonate a guardian in comments.
// The site's own name (APP_NAME) is reserved too.
const RESERVED_NAMES = new Set([
  config.app.name.toLowerCase(),
  'parent',
  'parents',
  'guardian',
  'guardians',
  'admin',
  'administrator',
  'mom',
  'dad',
  'mum',
  'moderator',
  'system',
]);

class BadInput extends Error {
  constructor(field) {
    super(`field "${field}" must be a single value`);
    this.name = 'BadInput';
    this.status = 400;
  }
}

/** Read one body/query field as a trimmed string. Arrays are rejected. */
function str(value, { field = 'field', max = 10000, trim = true } = {}) {
  if (value === undefined || value === null) {
    return '';
  }
  if (typeof value !== 'string') {
    throw new BadInput(field);
  }
  const v = trim ? value.trim() : value;
  return v.length > max ? v.slice(0, max) : v;
}

/** Read a field that may legitimately repeat (checkbox lists) as string[]. */
function strList(value) {
  if (value === undefined || value === null || value === '') {
    return [];
  }
  const list = Array.isArray(value) ? value : [value];
  return list.filter((v) => typeof v === 'string' && v.length <= 100).map((v) => v.trim()).filter(Boolean);
}

function isValidTheme(theme) {
  return THEMES.includes(theme);
}

function normalizeTheme(theme) {
  return isValidTheme(theme) ? theme : DEFAULT_THEME;
}

function validateUsername(username) {
  const value = str(username, { field: 'username' });
  if (!value) {
    return { ok: false, error: 'Username cannot be empty.' };
  }
  if (!USERNAME_RE.test(value)) {
    return {
      ok: false,
      error: 'Username must be 3 to 32 characters using letters, numbers, dot, underscore, or hyphen.',
    };
  }
  return { ok: true, value };
}

function validateEmail(email) {
  const value = str(email, { field: 'email', max: 254 });
  if (!value) {
    return { ok: false, error: 'Email cannot be empty.' };
  }
  if (!EMAIL_RE.test(value)) {
    return { ok: false, error: 'Enter a valid email address.' };
  }
  return { ok: true, value };
}

/**
 * Display names: 1 to 80 characters, and not a reserved guardian-sounding
 * name unless the account is actually a parent.
 */
function validateDisplayName(displayName, { role } = {}) {
  const value = str(displayName, { field: 'displayName' }).replace(/\s+/g, ' ');
  if (!value) {
    return { ok: false, error: 'Display name cannot be empty.' };
  }
  if (value.length > 80) {
    return { ok: false, error: 'Display name must be 80 characters or fewer.' };
  }
  if (role !== 'parent' && RESERVED_NAMES.has(value.toLowerCase())) {
    return { ok: false, error: 'Please choose a display name that is your own name.' };
  }
  return { ok: true, value };
}

function validateCaption(caption) {
  const value = str(caption, { field: 'caption' });
  if (value.length > 200) {
    return { ok: false, error: 'Caption must be 200 characters or fewer.' };
  }
  return { ok: true, value };
}

module.exports = {
  THEMES,
  DEFAULT_THEME,
  RESERVED_NAMES,
  BadInput,
  str,
  strList,
  isValidTheme,
  normalizeTheme,
  validateUsername,
  validateEmail,
  validateDisplayName,
  validateCaption,
};
