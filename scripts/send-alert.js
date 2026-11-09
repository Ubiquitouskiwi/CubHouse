'use strict';

/**
 * Operator alert email, used by systemd OnFailure= units
 * (deploy/systemd/family-photos-alert@.service) when a backup or backup check fails.
 *
 *   node scripts/send-alert.js <unit-name>
 *
 * Reads SMTP_URL, NOTIFY_FROM and ALERT_EMAIL (comma-separated) from the
 * environment (the env file). The message names the failed unit and tells
 * the reader where to look; it contains no family data and no log lines.
 */

function buildAlert(unit, hostname, appName = process.env.APP_NAME || 'Cubhouse') {
  const safeUnit = String(unit || 'unknown unit').replace(/[^\w@.-]/g, '').slice(0, 100);
  // APP_NAME comes from the operator's env file; strip header-breaking characters anyway.
  const safeName = String(appName).replace(/[\r\n<>]/g, '').slice(0, 60);
  return {
    subject: `[${safeName}] ${safeUnit} failed on ${hostname}`,
    text:
      `The systemd unit ${safeUnit} failed on ${hostname}.\n\n` +
      `Check it with:  journalctl -u ${safeUnit} --since -2d\n` +
      'Backups and their checks are described in docs/RUNBOOK.md ("Routine checks" and "Restore").\n',
  };
}

async function sendAlert({ unit, env = process.env, hostname, createTransport }) {
  const to = String(env.ALERT_EMAIL || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!env.SMTP_URL || to.length === 0) {
    throw new Error('SMTP_URL and ALERT_EMAIL must be set to send operator alerts');
  }
  const make = createTransport || require('nodemailer').createTransport;
  const { subject, text } = buildAlert(unit, hostname || require('os').hostname(), env.APP_NAME || 'Cubhouse');
  await make(env.SMTP_URL).sendMail({ from: env.NOTIFY_FROM || 'no-reply@localhost', to, subject, text });
  return { to: to.length, subject };
}

if (require.main === module) {
  sendAlert({ unit: process.argv[2] }).then(
    (r) => {
      process.stdout.write(`alert sent to ${r.to} recipient(s)\n`);
    },
    (err) => {
      process.stderr.write(`alert NOT sent: ${err.message}\n`);
      process.exit(1);
    }
  );
}

module.exports = { sendAlert, buildAlert };
