'use strict';

// No top-level require of ./logger: config.js loads this file, and the
// logger loads config.js.

/**
 * The family's time zone: the zone every time written into an email or
 * notification is shown in (an email cannot know the reader's own zone).
 *
 * Effective zone, first match wins:
 *   1. the guardian setting (Admin, Family settings; site setting "timeZone")
 *   2. APP_TIME_ZONE on the server (config.app.timeZone)
 *   3. UTC
 */

const SETTING_KEY = 'timeZone';
const ZONE_MAX = 64;

/** The canonical IANA name Intl uses for `value` (e.g. America/New_York), or null. */
function validTimeZone(value) {
  if (!value || typeof value !== 'string' || value.length > ZONE_MAX) {
    return null;
  }
  try {
    // "America/New York" is accepted as America/New_York.
    const name = value.trim().replace(/ /g, '_');
    return new Intl.DateTimeFormat('en-US', { timeZone: name }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/** Every zone this server's Intl knows, for the picker. */
function supportedTimeZones() {
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return zones.includes('UTC') ? zones : ['UTC', ...zones];
}

/** "Fri, Nov 13, 2026, 4:46 PM EST": a moment in `timeZone`, the zone always named. Bad input -> null. */
function formatInZone(moment, timeZone = 'UTC') {
  const at = typeof moment === 'number' ? moment : Date.parse(moment || '');
  if (!Number.isFinite(at)) {
    return null;
  }
  const format = (zone) =>
    new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date(at));
  try {
    return format(timeZone || 'UTC');
  } catch {
    return format('UTC');
  }
}

/** The guardian setting alone ({ zone, updatedBy, updatedAt }), or null. */
async function savedTimeZone(store) {
  const saved = await store.getSiteSetting(SETTING_KEY);
  return saved && validTimeZone(saved.zone) ? { ...saved, zone: validTimeZone(saved.zone) } : null;
}

/**
 * { zone, source } where source is 'family', 'server' (APP_TIME_ZONE) or
 * 'utc'. Never throws: an email is still sent (in the server default) if the
 * settings table is missing or the database hiccups.
 */
async function effectiveTimeZone(store, config) {
  try {
    const saved = await savedTimeZone(store);
    if (saved) {
      return { zone: saved.zone, source: 'family' };
    }
  } catch (err) {
    const { logger, errorFields } = require('./logger');
    logger.warn(errorFields(err), 'family time zone could not be read; using the server default');
  }
  return serverDefaultTimeZone(config);
}

/** APP_TIME_ZONE, else UTC: what applies when no guardian has chosen a zone. */
function serverDefaultTimeZone(config) {
  const fromEnv = validTimeZone(config.app.timeZone);
  return fromEnv ? { zone: fromEnv, source: 'server' } : { zone: 'UTC', source: 'utc' };
}

async function saveTimeZone(store, zone, { updatedBy } = {}) {
  return store.putSiteSetting(SETTING_KEY, { zone, updatedBy: updatedBy || null, updatedAt: new Date().toISOString() });
}

async function clearTimeZone(store) {
  return store.deleteSiteSetting(SETTING_KEY);
}

module.exports = {
  SETTING_KEY,
  ZONE_MAX,
  validTimeZone,
  supportedTimeZones,
  formatInZone,
  savedTimeZone,
  effectiveTimeZone,
  serverDefaultTimeZone,
  saveTimeZone,
  clearTimeZone,
};
