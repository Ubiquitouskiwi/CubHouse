'use strict';

/**
 * Backup, backup-check, restore-verify and alert scripts, tested offline.
 * The shell scripts run against stub pg_dump / age / s3cmd binaries that
 * only record their arguments, so nothing touches a real database or bucket.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const config = require('../src/config');
const { makeStore } = require('./storeFactory');
const { createMediaService } = require('../src/media');
const { verifyRestore } = require('../scripts/verify-restore');
const { sendAlert, buildAlert } = require('../scripts/send-alert');
const { memoryMediaStorage } = require('./helpers');
const { plainJpeg } = require('./fixtures/makeImages');

const ROOT = path.join(__dirname, '..');
const BACKUP = path.join(ROOT, 'deploy', 'backup.sh');
const CHECK = path.join(ROOT, 'deploy', 'backup-check.sh');

function sandbox(t, { failPgDump = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'photos-backup-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  const log = path.join(dir, 'calls.log');
  const stub = (name, body) => {
    fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> "${log}"\n${body}\n`, { mode: 0o755 });
  };
  stub('pg_dump', failPgDump ? 'exit 1' : 'echo FAKE-DUMP');
  stub('age', 'cat');
  stub('s3cmd', 'exit 0');
  return { dir, bin, log, state: path.join(dir, 'state') };
}

const BACKUP_ENV = {
  DATABASE_URL: 'postgres://fake',
  BACKUP_BUCKET: 'backup-bucket',
  AGE_RECIPIENTS_FILE: '/dev/null',
  DO_SPACES_BUCKET: 'media-bucket',
  MEDIA_S3CMD_CONFIG: '/dev/null',
  BACKUP_S3CMD_CONFIG: '/dev/null',
};

function run(script, env) {
  return spawnSync('bash', [script], { env, encoding: 'utf8', timeout: 20000 });
}

const skipNoBash = process.platform === 'win32' ? 'bash scripts are not run on Windows' : false;

test('backup.sh dumps the DB, mirrors media (deletions included), and records success', { skip: skipNoBash }, (t) => {
  const sb = sandbox(t);
  const r = run(BACKUP, { PATH: `${sb.bin}:${process.env.PATH}`, BACKUP_STATE_DIR: sb.state, APP_ENV_FILE: '/nonexistent', ...BACKUP_ENV });
  assert.equal(r.status, 0, r.stderr);
  const calls = fs.readFileSync(sb.log, 'utf8');
  assert.match(calls, /pg_dump --format=custom/);
  assert.match(calls, /age --encrypt --recipients-file/);
  assert.match(calls, /s3cmd .*put --acl-private .*s3:\/\/backup-bucket\/db\/family-photos-\d{8}T\d{6}Z\.dump\.age/);
  assert.match(calls, /s3cmd .*sync --delete-removed s3:\/\/media-bucket\/photos\//);
  assert.match(calls, /s3cmd .*sync --delete-removed --acl-private .* s3:\/\/backup-bucket\/media\/photos\//);
  // Deletions reach the backup only as versioned (30-day) deletes; the
  // script itself never removes media objects or versions.
  assert.doesNotMatch(calls, /s3cmd .* del .*media/);
  assert.match(fs.readFileSync(path.join(sb.state, 'last-success'), 'utf8'), /^\d+\s*$/);
});

test('backup.sh loads the env file itself when started without the environment', { skip: skipNoBash }, (t) => {
  const sb = sandbox(t);
  const envFile = path.join(sb.dir, 'app.env');
  fs.writeFileSync(envFile, Object.entries(BACKUP_ENV).map(([k, v]) => `${k}=${v}`).join('\n') + '\n');
  const r = run(BACKUP, { PATH: `${sb.bin}:${process.env.PATH}`, BACKUP_STATE_DIR: sb.state, APP_ENV_FILE: envFile });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(fs.existsSync(path.join(sb.state, 'last-success')));
});

test('backup.sh fails loudly (and records no success) on missing config or a failed dump', { skip: skipNoBash }, (t) => {
  const sb = sandbox(t);
  const { BACKUP_BUCKET, ...noBucket } = BACKUP_ENV;
  void BACKUP_BUCKET;
  const missing = run(BACKUP, { PATH: `${sb.bin}:${process.env.PATH}`, BACKUP_STATE_DIR: sb.state, APP_ENV_FILE: '/nonexistent', ...noBucket });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /BACKUP_BUCKET/);
  assert.equal(fs.existsSync(path.join(sb.state, 'last-success')), false);

  const bad = sandbox(t, { failPgDump: true });
  const failed = run(BACKUP, { PATH: `${bad.bin}:${process.env.PATH}`, BACKUP_STATE_DIR: bad.state, APP_ENV_FILE: '/nonexistent', ...BACKUP_ENV });
  assert.notEqual(failed.status, 0);
  assert.equal(fs.existsSync(path.join(bad.state, 'last-success')), false);
  assert.doesNotMatch(fs.readFileSync(bad.log, 'utf8'), /s3cmd .*put/, 'uploaded a failed dump');
});

test('backup-check.sh passes when fresh, fails when stale or never run', { skip: skipNoBash }, (t) => {
  const sb = sandbox(t);
  fs.mkdirSync(sb.state, { recursive: true });
  const now = 2_000_000_000;
  const env = (extra) => ({ PATH: process.env.PATH, BACKUP_STATE_DIR: sb.state, BACKUP_CHECK_NOW: String(now), ...extra });
  const never = run(CHECK, env());
  assert.notEqual(never.status, 0);
  assert.match(never.stderr, /no successful backup has ever been recorded/);
  fs.writeFileSync(path.join(sb.state, 'last-success'), `${now - 3 * 3600}\n`);
  assert.equal(run(CHECK, env()).status, 0);
  fs.writeFileSync(path.join(sb.state, 'last-success'), `${now - 30 * 3600}\n`);
  const stale = run(CHECK, env());
  assert.notEqual(stale.status, 0);
  assert.match(stale.stderr, /30h ago/);
});

test('verifyRestore decrypts sampled photos with the escrowed key, and fails on the wrong key or a gap', async () => {
  const key = crypto.randomBytes(32).toString('base64');
  const store = await makeStore();
  const storage = memoryMediaStorage();
  const media = createMediaService({ store, storage, config: { ...config, encryptionKey: key } });
  for (let i = 0; i < 4; i += 1) {
    await store.createPhoto({ caption: `p${i}`, ...(await media.ingest(await plainJpeg())) });
  }
  await store.appendSecurityAuditEvent({ type: 'test.event' });

  const ok = await verifyRestore({ store, storage, encryptionKey: key, sampleSize: 3 });
  assert.equal(ok.ok, true, ok.failures.join('; '));
  assert.equal(ok.decrypted, 3);
  assert.equal(ok.auditChainOk, true);

  const wrong = await verifyRestore({ store, storage, encryptionKey: crypto.randomBytes(32).toString('base64') });
  assert.equal(wrong.ok, false);

  const [first] = await store.listPhotos();
  storage.objects.delete(`photos/${first.mediaId}/full`);
  const gap = await verifyRestore({ store, storage, encryptionKey: key, sampleSize: 4 });
  assert.equal(gap.ok, false);
  assert.match(gap.failures.join('\n'), /missing from the backup/);
});

test('verifyRestore never creates a media key when the restored DB lost it', async () => {
  const key = crypto.randomBytes(32).toString('base64');
  const source = await makeStore();
  const storage = memoryMediaStorage();
  const media = createMediaService({ store: source, storage, config: { ...config, encryptionKey: key } });
  const ingested = await media.ingest(await plainJpeg());
  const restored = await makeStore();
  await restored.createPhoto({ caption: 'x', ...ingested });
  const report = await verifyRestore({ store: restored, storage, encryptionKey: key });
  assert.equal(report.ok, false);
  assert.equal(await restored.getSetting('media.dataKey.v1'), null);
});

test('send-alert emails the configured operators and carries no family data', async () => {
  const sent = [];
  const createTransport = () => ({ sendMail: async (m) => sent.push(m) });
  const env = { SMTP_URL: 'smtps://fake', ALERT_EMAIL: 'ops@example.org, second@example.org', NOTIFY_FROM: 'x@example.org' };
  const r = await sendAlert({ unit: 'family-photos-backup.service', env, hostname: 'host1', createTransport });
  assert.equal(r.to, 2);
  assert.match(sent[0].subject, /family-photos-backup\.service failed on host1/);
  await assert.rejects(sendAlert({ unit: 'x', env: {}, createTransport }), /ALERT_EMAIL/);
  // Unit names are sanitized before they reach an email.
  assert.doesNotMatch(buildAlert('evil<script>\nBcc: x', 'h').subject, /[<>\n]/);
});

test('send-alert subject uses APP_NAME, sanitized', async () => {
  assert.match(buildAlert('u.service', 'h', 'Our Photos').subject, /^\[Our Photos\] u\.service failed on h$/);
  assert.doesNotMatch(buildAlert('u', 'h', 'Bad\r\nBcc: <x>').subject, /[<>\r\n]/);
  const sent = [];
  const env = { SMTP_URL: 'smtps://fake', ALERT_EMAIL: 'ops@example.org', APP_NAME: 'Our Photos' };
  await sendAlert({ unit: 'u', env, hostname: 'h', createTransport: () => ({ sendMail: async (m) => sent.push(m) }) });
  assert.match(sent[0].subject, /^\[Our Photos\] /);
});
