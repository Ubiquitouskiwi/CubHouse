'use strict';

const crypto = require('crypto');

const { logger, errorFields } = require('../logger');
const { snapshotUsage } = require('../usage');

/**
 * Daily data-minimization job.
 *
 *   - Download ledger rows older than DOWNLOAD_RETENTION_DAYS (90) are removed.
 *   - Audit event DETAILS older than AUDIT_DETAIL_RETENTION_DAYS are redacted;
 *     the events and their hashes stay so the chain still verifies.
 *   - Governance requests whose delay passed are executed or expired.
 *   - Guardians get a digest of the last day's downloads (counts only),
 *     at most once per UTC day however many instances are running.
 *   - Usage page: snapshot how many family accounts signed in recently, and
 *     delete usage rollups older than USAGE_RETENTION_DAYS (400).
 */

const DAY = 24 * 60 * 60 * 1000;

async function runRetention({ store, config, governance, notifier, now = Date.now() }) {
  const result = { downloadsPurged: 0, auditRedacted: 0, governanceExecuted: 0, digestSent: false, usagePurged: 0 };

  const downloadCutoff = new Date(now - config.privacy.downloadRetentionDays * DAY).toISOString();
  result.downloadsPurged = await store.purgeDownloadsBefore(downloadCutoff);

  const auditCutoff = new Date(now - config.privacy.auditDetailRetentionDays * DAY).toISOString();
  result.auditRedacted = await store.redactAuditDetailsBefore(auditCutoff);

  if (governance) {
    result.governanceExecuted = await governance.runDue(now);
  }

  // Usage metrics are a nice-to-have: a failure here must not stop the
  // privacy work above or the digest below.
  try {
    result.usagePurged = (await snapshotUsage({ store, config, now })).purged;
  } catch (err) {
    logger.warn(errorFields(err), 'usage snapshot failed');
  }

  // Everything above is idempotent, so two instances (a deploy swap) or a
  // restart can run it again safely. The digest email is not: claim the UTC
  // day in the insert-once settings table, and only the claimant sends it.
  // shortcut: one small settings row per day is kept forever (the app role
  // cannot delete settings); fine for decades, prune by hand if ever needed.
  const day = new Date(now).toISOString().slice(0, 10);
  const claim = crypto.randomUUID();
  const claimed = notifier && (await store.setSettingIfAbsent(`jobs.downloadDigest.${day}`, claim)) === claim;

  if (claimed) {
    const since = new Date(now - DAY).toISOString();
    const recent = (await store.listDownloads()).filter((d) => d.downloadedAt >= since);
    if (recent.length > 0) {
      const people = new Set(recent.map((d) => d.userId)).size;
      await notifier.notifyGuardians(store, {
        subject: 'Daily download summary',
        text: `${recent.length} photo download(s) by ${people} member(s) in the last day. Details are in Download history.`,
      });
      result.digestSent = true;
    }
  }
  return result;
}

/** Schedule the job: once shortly after boot, then daily. Timers are unref'd. */
function scheduleRetention(deps) {
  const tick = () =>
    runRetention(deps)
      .then((r) => logger.info({ retention: r }, 'retention run'))
      .catch((err) => logger.error(errorFields(err), 'retention run failed'));
  const first = setTimeout(tick, 60 * 1000);
  first.unref();
  const daily = setInterval(tick, DAY);
  daily.unref();
  // Governance delays need finer granularity than once a day.
  const gov = setInterval(() => {
    if (deps.governance) {
      deps.governance.runDue().catch((err) => logger.error(errorFields(err), 'governance tick failed'));
    }
  }, 5 * 60 * 1000);
  gov.unref();
  return () => {
    clearTimeout(first);
    clearInterval(daily);
    clearInterval(gov);
  };
}

module.exports = { runRetention, scheduleRetention };
