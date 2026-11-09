'use strict';

const { logger, errorFields } = require('./logger');
const { ROLES } = require('./permissions');

/**
 * First-party usage metrics for the guardian-only Usage page.
 *
 * What is stored (table app_usage_daily, see deploy/sql/003_usage_metrics.sql)
 * is one number per UTC day per metric name. Nothing else:
 *   - no account ids (not even hashed), IP addresses, user agents, URLs or
 *     query strings, and nothing about any one person;
 *   - requests are mapped to a handful of named SECTIONS below and only the
 *     section's counter goes up;
 *   - "how many accounts signed in" is counted from the lastLoginAt the
 *     account already carries (added for the Support page), once a day, so
 *     no new per-person record is created to count active accounts.
 *
 * Recording never touches the request path: counts go into a small in-memory
 * buffer (bounded: a fixed set of metric names per day) and a timer writes
 * them in one statement a minute. A failed write is logged and dropped.
 * shortcut: counts buffered in the last minute before a crash are lost; fine
 * for trends, use a write-through counter if exact numbers ever matter.
 *
 * Only signed-in family accounts count. The support operator, anonymous
 * visitors (which includes bots and uptime checks; /healthz is mounted before
 * sessions anyway), prefetches and crawler user agents are ignored.
 */

const DAY = 24 * 60 * 60 * 1000;

const under = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);
const ONE_PHOTO = /^\/photos\/[^/]+$/;
const PHOTO_DOWNLOAD = /^\/photos\/[^/]+\/download$/;
const PHOTO_SOCIAL = /^\/photos\/[^/]+\/(comments|react)$/;

// Named site sections. The order matters: the first match wins.
const SECTIONS = Object.freeze([
  { name: 'home', label: 'Home page', method: 'GET', match: (p) => p === '/' || p === '/home' },
  {
    name: 'guardian',
    label: 'Guardian tools (admin, download history)',
    method: 'GET',
    match: (p) => under(p, '/admin') || p === '/photos/downloads',
  },
  { name: 'downloads', label: 'Photo downloads', method: 'GET', match: (p) => PHOTO_DOWNLOAD.test(p) },
  { name: 'photos', label: 'Browsing photos', method: 'GET', match: (p) => p === '/photos' || ONE_PHOTO.test(p) },
  { name: 'uploads', label: 'Uploading photos', method: 'POST', match: (p) => p === '/photos/upload' },
  { name: 'comments', label: 'Comments and reactions', method: 'POST', match: (p) => PHOTO_SOCIAL.test(p) },
  { name: 'albums', label: 'Albums', method: 'ANY', match: (p) => under(p, '/albums') },
  { name: 'settings', label: 'Settings', method: 'GET', match: (p) => under(p, '/settings') },
]);

const SECTION_LABELS = Object.freeze(Object.fromEntries(SECTIONS.map((s) => [s.name, s.label])));

// Every metric name the app may write. The table has a CHECK on the shape too.
const METRICS = Object.freeze(
  new Set([
    'logins',
    'accounts.all',
    'active1.all',
    'active7.all',
    'active30.all',
    ...SECTIONS.map((s) => `section.${s.name}`),
  ])
);

const BOT_UA = /bot|crawl|spider|slurp|headless/i;

function utcDay(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

/** Which named section a request belongs to, or null (not counted). */
function sectionFor(method, path) {
  for (const s of SECTIONS) {
    if ((s.method === 'ANY' || s.method === method) && s.match(path)) {
      return s.name;
    }
  }
  return null;
}

/** Accounts that count as family accounts: active, never the operator. */
function familyAccounts(users) {
  return users.filter((u) => !u.disabled && u.role !== ROLES.OPERATOR);
}

/**
 * The in-memory counter buffer and its flush timer. `count()` is synchronous
 * and cannot throw; `flush()` never rejects.
 */
function createUsageRecorder({ store, flushMs = 60 * 1000, now = () => Date.now() } = {}) {
  let pending = new Map();

  function count(metric, n = 1) {
    try {
      if (!METRICS.has(metric)) {
        return;
      }
      const day = utcDay(now());
      const counts = pending.get(day) || {};
      counts[metric] = (counts[metric] || 0) + n;
      pending.set(day, counts);
    } catch (err) {
      logger.warn(errorFields(err), 'usage count failed');
    }
  }

  async function flush() {
    const batch = pending;
    pending = new Map();
    for (const [day, counts] of batch) {
      try {
        await store.addUsageCounts(day, counts);
      } catch (err) {
        logger.warn({ ...errorFields(err), day }, 'usage flush failed; counts dropped');
      }
    }
  }

  const timer = setInterval(() => {
    flush();
  }, flushMs);
  timer.unref();

  return { count, flush, stop: () => clearInterval(timer) };
}

/** Count a request into its section once the response finished successfully. */
function createUsageMiddleware(recorder) {
  return function usageMiddleware(req, res, next) {
    try {
      const user = req.user;
      const purpose = req.get('sec-purpose') || req.get('purpose') || '';
      if (!user || user.role === ROLES.OPERATOR || /prefetch|prerender/i.test(purpose) || BOT_UA.test(req.get('user-agent') || '')) {
        return next();
      }
      const section = sectionFor(req.method, req.path);
      if (section) {
        res.once('finish', () => {
          if (res.statusCode < 400) {
            recorder.count(`section.${section}`);
          }
        });
      }
    } catch (err) {
      logger.warn(errorFields(err), 'usage middleware failed');
    }
    return next();
  };
}

/**
 * Daily snapshot of how many family accounts signed in during the last 1, 7
 * and 30 days, and how many exist, then delete rollups past retention.
 * Idempotent: a second run the same day overwrites that day's snapshot.
 */
async function snapshotUsage({ store, config, now = Date.now() }) {
  const accounts = familyAccounts(await store.listUsers());
  const within = (days) => accounts.filter((u) => u.lastLoginAt && Date.parse(u.lastLoginAt) > now - days * DAY).length;
  const day = utcDay(now);
  await store.setUsageValues(day, {
    'accounts.all': accounts.length,
    'active1.all': within(1),
    'active7.all': within(7),
    'active30.all': within(30),
  });
  const purged = await store.purgeUsageBefore(utcDay(now - config.privacy.usageRetentionDays * DAY));
  return { day, purged };
}

// --- Reporting -------------------------------------------------------------

const MIN_SHOWN = 3;

/**
 * A count as shown on the page. 1 or 2 is replaced by "fewer than 3": with a
 * handful of families, a count that small can point at one household.
 */
function shown(n) {
  const value = Number(n) || 0;
  if (value > 0 && value < MIN_SHOWN) {
    return { value: null, text: 'fewer than 3', suppressed: true };
  }
  return { value, text: String(value), suppressed: false };
}

/**
 * A part and the rest of a total everyone on the page can see. If either is
 * 1 or 2, BOTH are hidden; otherwise the visible one would give the other
 * away by subtraction.
 */
function shownPair(part, total) {
  const rest = total - part;
  const small = (v) => v > 0 && v < MIN_SHOWN;
  if (small(part) || small(rest)) {
    const hidden = { value: null, text: 'hidden (under 3)', suppressed: true };
    return [hidden, hidden];
  }
  return [shown(part), shown(rest)];
}

function summaryLine(active, total, windowText) {
  if (total === 0) {
    return 'There are no family accounts yet.';
  }
  const rest = total - active;
  const noun = total === 1 ? 'family account' : 'family accounts';
  if (active === 0) {
    return `None of the ${total} ${noun} signed in ${windowText}.`;
  }
  if (active < MIN_SHOWN) {
    return `Fewer than 3 of the ${total} ${noun} signed in ${windowText}.`;
  }
  if (rest === 0) {
    return `All ${total} ${noun} signed in ${windowText}.`;
  }
  if (rest < MIN_SHOWN) {
    return `All but fewer than 3 of the ${total} ${noun} signed in ${windowText}.`;
  }
  return `${active} of ${total} ${noun} signed in ${windowText}.`;
}

const RANGES = Object.freeze([30, 90, 365]);

function parseRange(raw) {
  const n = Number.parseInt(String(raw || ''), 10);
  return RANGES.includes(n) ? n : 30;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayLabel(day) {
  const [y, m, d] = day.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

/**
 * Buckets for the trend table: daily for 30 days, weekly (7-day blocks
 * ending today) for 90, calendar months for 365. Each bucket lists its days.
 */
function trendBuckets(range, now) {
  const days = [];
  for (let i = range - 1; i >= 0; i -= 1) {
    days.push(utcDay(now - i * DAY));
  }
  if (range === 30) {
    return days.map((d) => ({ label: dayLabel(d), days: [d], activeMetric: 'active1.all' }));
  }
  if (range === 90) {
    const buckets = [];
    for (let end = days.length; end > 0; end -= 7) {
      const slice = days.slice(Math.max(0, end - 7), end);
      buckets.unshift({
        label: `${dayLabel(slice[0])} to ${dayLabel(slice[slice.length - 1])}`,
        days: slice,
        activeMetric: 'active7.all',
      });
    }
    return buckets;
  }
  const byMonth = new Map();
  for (const d of days) {
    const key = d.slice(0, 7);
    if (!byMonth.has(key)) {
      const [y, m] = key.split('-').map(Number);
      byMonth.set(key, { label: `${MONTHS[m - 1]} ${y}`, days: [], activeMetric: 'active30.all' });
    }
    byMonth.get(key).days.push(d);
  }
  return [...byMonth.values()];
}

/**
 * Everything the Usage page shows, already suppressed. Holds no names, ids
 * or per-person rows.
 */
async function buildUsageReport({ store, range = 30, now = Date.now() }) {
  const [users, rows, auditEvents] = await Promise.all([
    store.listUsers(),
    store.listUsageSince(utcDay(now - 364 * DAY)),
    store.listSecurityAuditEvents(),
  ]);
  const accounts = familyAccounts(users);
  const total = accounts.length;

  // Accounts from before lastLoginAt existed still show a sign-in in the
  // audit trail. Only a yes/no per account is derived, and only here.
  const auditSignedIn = new Set(auditEvents.filter((e) => e.type === 'auth.login').map((e) => String(e.targetId)));
  const lastLogin = (u) => (u.lastLoginAt ? Date.parse(u.lastLoginAt) : 0);
  const signedInWithin = (days) => accounts.filter((u) => lastLogin(u) > now - days * DAY).length;
  const everSignedIn = accounts.filter((u) => u.lastLoginAt || auditSignedIn.has(String(u.id))).length;
  const createdWithin = (days) => accounts.filter((u) => u.createdAt && Date.parse(u.createdAt) > now - days * DAY).length;

  const active7 = signedInWithin(7);
  const active30 = signedInWithin(30);

  // Role split: shown only when no cell would be 1 or 2, because the
  // total is on the page and each part gives the other away.
  const guardians = accounts.filter((u) => u.role === ROLES.PARENT);
  const members = accounts.filter((u) => u.role !== ROLES.PARENT);
  const roleRows = [
    { label: 'Guardians', list: guardians },
    { label: 'Family members', list: members },
  ].map((r) => ({
    label: r.label,
    total: r.list.length,
    active7: r.list.filter((u) => lastLogin(u) > now - 7 * DAY).length,
    active30: r.list.filter((u) => lastLogin(u) > now - 30 * DAY).length,
  }));
  const tooSmall = (v) => v > 0 && v < MIN_SHOWN;
  const roleSplitShown = roleRows.every(
    (r) => ![r.total, r.active7, r.active30, r.total - r.active7, r.total - r.active30].some(tooSmall)
  );

  // Daily rows into lookups.
  const byDay = new Map();
  for (const r of rows) {
    if (!byDay.has(r.day)) {
      byDay.set(r.day, {});
    }
    byDay.get(r.day)[r.metric] = r.value;
  }
  const sumOver = (metric, days) => {
    const since = utcDay(now - (days - 1) * DAY);
    let n = 0;
    for (const [day, m] of byDay) {
      if (day >= since) {
        n += m[metric] || 0;
      }
    }
    return n;
  };

  const windows = RANGES.map((days) => ({
    days,
    logins: shown(sumOver('logins', days)),
    created: shown(createdWithin(days)),
  }));

  const sections = SECTIONS.map((s) => ({
    label: s.label,
    counts: RANGES.map((days) => shown(sumOver(`section.${s.name}`, days))),
  }));

  const buckets = trendBuckets(range, now).map((b) => {
    let logins = 0;
    let snapshot = null;
    for (const d of b.days) {
      const m = byDay.get(d);
      if (m) {
        logins += m.logins || 0;
        if (m[b.activeMetric] !== undefined) {
          snapshot = { active: m[b.activeMetric], total: m['accounts.all'] || 0 };
        }
      }
    }
    return {
      label: b.label,
      logins: shown(logins),
      // The latest daily snapshot in the period, paired with that day's
      // account total so "all but one" cannot be read off it either.
      active: snapshot === null ? { value: null, text: 'no data yet', suppressed: true } : shownPair(snapshot.active, snapshot.total)[0],
    };
  });
  const maxLogins = Math.max(1, ...buckets.map((b) => b.logins.value || 0));

  const [everShown, neverShown] = shownPair(everSignedIn, total);
  const firstDay = rows.length ? rows[0].day : null;

  return {
    summary: summaryLine(active30, total, 'during the last 30 days'),
    total,
    active: [
      { label: 'Signed in during the last 7 days', count: shownPair(active7, total)[0] },
      { label: 'Signed in during the last 30 days', count: shownPair(active30, total)[0] },
    ],
    roleSplitShown,
    roleRows: roleSplitShown
      ? roleRows.map((r) => ({ label: r.label, total: shown(r.total), active7: shown(r.active7), active30: shown(r.active30) }))
      : [],
    everSignedIn: everShown,
    neverSignedIn: neverShown,
    windows,
    sections,
    range,
    ranges: RANGES,
    buckets,
    maxLogins,
    granularity: range === 30 ? 'day' : range === 90 ? 'week' : 'month',
    collectingSince: firstDay ? dayLabel(firstDay) : null,
  };
}

module.exports = {
  SECTIONS,
  SECTION_LABELS,
  METRICS,
  RANGES,
  utcDay,
  sectionFor,
  createUsageRecorder,
  createUsageMiddleware,
  snapshotUsage,
  buildUsageReport,
  parseRange,
  shown,
  shownPair,
  summaryLine,
};
