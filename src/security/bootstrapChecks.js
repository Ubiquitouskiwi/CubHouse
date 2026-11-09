'use strict';

/**
 * Safe boot. Production refuses to start on any configuration that would put
 * a child's photos at risk; development logs the same findings as warnings.
 * There is no switch to disable this in production.
 */

const WEAK_VALUES = new Set([
  'changeme',
  'changeme123',
  'devpass123',
  'userpass123',
  'secret',
  'default',
  'password',
  'password123',
  'change-me-to-a-long-random-string',
]);

function isWeakSecret(value = '') {
  const v = String(value).trim();
  return !v || v.length < 32 || WEAK_VALUES.has(v.toLowerCase()) || /dev-only/i.test(v);
}

function isStrongKey(value) {
  if (!value) {
    return false;
  }
  try {
    return Buffer.from(value, 'base64').length === 32;
  } catch {
    return false;
  }
}

/**
 * Does this non-production process look like it is serving real people?
 * Development mode turns off MFA, governance delays and Secure cookies, and
 * runs on the in-memory store, so running it behind a proxy or on a public
 * https origin is refused outright instead of quietly "working".
 */
function deployedSignals(config, env = process.env) {
  const signals = [];
  if (config.trustProxyHops > 0) {
    signals.push('TRUST_PROXY_HOPS is set (a reverse proxy is in front)');
  }
  if (/^https:\/\//i.test(config.publicOrigin || '') && !/^https:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/i.test(config.publicOrigin)) {
    signals.push('PUBLIC_ORIGIN is a public https address');
  }
  // Inside a container (the Dockerfile sets APP_IN_CONTAINER=true) the app must
  // bind a wildcard address or the host cannot reach it; there the port
  // publish (127.0.0.1 only) is the boundary, not the in-container bind.
  const containerWildcard = env.APP_IN_CONTAINER === 'true' && ['0.0.0.0', '::'].includes(config.host);
  if (config.host && !['127.0.0.1', 'localhost', '::1'].includes(config.host) && !containerWildcard) {
    signals.push('HOST is not loopback');
  }
  if (env.STK_PROJECT) {
    signals.push('running under StarlingTek (STK_PROJECT is set)');
  }
  if (env.INVOCATION_ID && env.JOURNAL_STREAM) {
    signals.push('running under systemd');
  }
  return signals;
}

/** Refuse development mode in a deployed-looking environment. Throws. */
function assertNotDeployedDev(config, env = process.env) {
  if (config.isProduction || config.isTest) {
    return;
  }
  const signals = deployedSignals(config, env);
  if (signals.length > 0) {
    throw new Error(
      `Refusing to start in development mode because this looks like a deployment (${signals.join('; ')}). ` +
        'Set NODE_ENV=production and complete the production settings in .env.example.'
    );
  }
}

/**
 * Static checks on configuration and the chosen backends.
 * `runtime` = { storeKind, sessionStoreKind, rateLimitShared, mediaKind }.
 */
function configFindings(config, runtime = {}, env = process.env) {
  const findings = [];
  const add = (msg) => findings.push(msg);

  if (isWeakSecret(config.session.secret)) {
    add('SESSION_SECRET is weak or unset (use `openssl rand -base64 48`).');
  }
  if (!isStrongKey(config.encryptionKey)) {
    add('APP_ENCRYPTION_KEY must be 32 random bytes, base64 (`openssl rand -base64 32`).');
  }
  if (env.SEED_TEST_ACCOUNTS === 'true') {
    add('SEED_TEST_ACCOUNTS must not be enabled in production.');
  }
  if (isWeakSecret(env.SEED_ADMIN_PASSWORD) && runtime.storeEmpty !== false) {
    add('SEED_ADMIN_PASSWORD is weak or default; set a strong one for the first guardian.');
  }
  if (!config.databaseUrl || runtime.storeKind === 'memory') {
    add('DATABASE_URL is required (the in-memory store loses everything on restart).');
  }
  if (runtime.sessionStoreKind === 'memory') {
    add('Sessions are in process memory; set DATABASE_URL so sessions persist and can be revoked.');
  }
  if (runtime.rateLimitShared === false) {
    add('Rate limits are in process memory; set DATABASE_URL for a shared limiter store.');
  }
  if (runtime.mediaKind && runtime.mediaKind !== 'spaces') {
    add('MEDIA_BACKEND must be "spaces" (a private bucket) in production.');
  }
  if (!config.trustProxyHops || config.trustProxyHops < 1) {
    add('TRUST_PROXY_HOPS must be set to the number of proxies in front of the app (Caddy = 1).');
  }
  if (!config.session.cookie.secure) {
    add('Session cookies must be Secure in production.');
  }
  if (!config.parentAuth.requireMfa) {
    add('PARENT_MFA_REQUIRED must be true in production.');
  }
  if (config.notifications.transport === 'smtp' && !config.notifications.smtpUrl) {
    add('SMTP_URL is required for guardian notifications.');
  }
  if (env.FORCE_SAFE_BOOT === 'false') {
    add('FORCE_SAFE_BOOT=false is not honored; remove it.');
  }
  return findings;
}

/** Checks that need the data store (run after init, before listening). */
async function storeFindings(store) {
  const findings = [];
  const users = await store.listUsers();
  if (users.some((u) => u.role === 'dev')) {
    findings.push('A dev account exists. The production family instance must not have a dev role.');
  }
  return findings;
}

function enforce(findings, { isProduction, logger }) {
  if (findings.length === 0) {
    return;
  }
  if (isProduction) {
    throw new Error(`Safe boot check failed:\n- ${findings.join('\n- ')}`);
  }
  if (logger) {
    for (const f of findings) {
      logger.warn({ safeBoot: f }, 'safe boot (would refuse in production)');
    }
  }
}

module.exports = {
  configFindings,
  storeFindings,
  enforce,
  isWeakSecret,
  isStrongKey,
  deployedSignals,
  assertNotDeployedDev,
};
