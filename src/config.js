'use strict';

require('dotenv').config();

/**
 * Environment configuration.
 *
 * Every key here is READ by running code. A setting that nothing reads is a
 * false promise to the parents, so do not add one until its behavior lands
 * (see docs/SECURITY_PRIVACY_PLAN.md, "a control either runs and has a test
 * that proves it, or it is removed").
 *
 * Production defaults are the strict ones. Development relaxes only what is
 * needed to run locally at zero cost (in-memory store, local media, console
 * notifications), and safe boot refuses to start production on any of those.
 */

const env = process.env;
const isProduction = env.NODE_ENV === 'production';
const isTest = env.NODE_ENV === 'test' || Boolean(env.NODE_TEST_CONTEXT);

const num = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && value !== undefined && value !== '' ? n : fallback;
};
const bool = (value, fallback) =>
  value === undefined || value === '' ? fallback : value === 'true';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

const config = {
  port: num(env.PORT, 3000),
  // Bind to loopback by default. In production the app sits behind Caddy (TLS)
  // on the same host and must never be reachable directly.
  host: env.HOST || '127.0.0.1',
  nodeEnv: env.NODE_ENV || 'development',
  app: {
    // Shown in page titles, emails and the authenticator app. Defaults are
    // deliberately generic: never put a child's real name in the repository.
    name: env.APP_NAME || 'Cubhouse',
    // Lower-case id for cookies, file names and logs (letters, digits, dashes).
    slug: /^[a-z0-9-]{1,40}$/.test(env.APP_SLUG || '') ? env.APP_SLUG : 'family-photos',
    // One line shown in every page footer.
    footerText: env.APP_FOOTER_TEXT || 'Our little family den. Please keep access codes and photos between us.',
  },
  isProduction,
  isTest,
  databaseUrl: env.DATABASE_URL || '',
  // Exact number of reverse-proxy hops in front of the app (Caddy = 1). Used
  // for req.ip and secure cookies. 0 means "no proxy": trust nothing.
  trustProxyHops: num(env.TRUST_PROXY_HOPS, isProduction ? 1 : 0),
  // Absolute origin, used for links in notifications.
  publicOrigin: env.PUBLIC_ORIGIN || `http://localhost:${num(env.PORT, 3000)}`,

  // Key-encryption key for envelope encryption (media data key, MFA secrets).
  // 32+ random bytes, base64. Required in production; a fixed dev key is used
  // otherwise so local data survives restarts of a persistent dev setup.
  encryptionKey: env.APP_ENCRYPTION_KEY || '',

  seedAdmin: {
    email: env.SEED_ADMIN_EMAIL || 'parent@example.com',
    password: env.SEED_ADMIN_PASSWORD || 'changeme-dev-only-123',
  },
  // Convenience accounts for exercising each role. Never seeded in production.
  seedDev: {
    email: env.SEED_DEV_EMAIL || 'dev@example.com',
    password: env.SEED_DEV_PASSWORD || 'devpass-dev-only-123',
  },
  seedUser: {
    email: env.SEED_USER_EMAIL || 'user@example.com',
    password: env.SEED_USER_PASSWORD || 'userpass-dev-only-123',
  },
  seed: {
    testAccountsEnabled: !isProduction && env.SEED_TEST_ACCOUNTS === 'true',
  },

  session: {
    secret: env.SESSION_SECRET || (isProduction ? '' : 'dev-only-session-secret-not-for-production'),
    // __Host- requires Secure + Path=/ + no Domain, so only use it over TLS.
    name: env.SESSION_COOKIE_NAME || (isProduction ? '__Host-photos.sid' : 'photos.sid'),
    idleTimeoutMs: num(env.SESSION_IDLE_TIMEOUT_MS, 15 * 60 * 1000),
    absoluteLifetimeMs: num(env.SESSION_ABSOLUTE_LIFETIME_MS, 7 * DAY),
    cookie: {
      httpOnly: true,
      sameSite: 'strict',
      secure: isProduction,
    },
  },

  security: {
    // Outside production safe boot only warns. In production it always runs
    // and cannot be switched off.
    maxLoginFailures: num(env.MAX_LOGIN_FAILURES, 8),
    loginLockoutMs: num(env.LOGIN_LOCKOUT_MS, 15 * 60 * 1000),
    // Global lockout per account (independent of IP) so rotating IPs does not
    // reset the counter.
    maxAccountFailures: num(env.MAX_ACCOUNT_FAILURES, 20),
    passwordMinLength: num(env.PASSWORD_MIN_LENGTH, 12),
    // Breached-password check via the Have I Been Pwned range API. Only the
    // first 5 hex chars of the SHA-1 leave the server (k-anonymity).
    breachedPasswordCheck: bool(env.BREACHED_PASSWORD_CHECK, isProduction),
    accessCodeTtlMs: num(env.ACCESS_CODE_TTL_MS, 72 * HOUR),
    // Guardian-issued sign-in reset codes (forgotten password, lost 2FA phone).
    resetCodeTtlMs: num(env.RESET_CODE_TTL_MS, 24 * HOUR),
    // A guardian's reset code only starts working after this delay, during
    // which they are emailed and can cancel it. Zero outside production.
    guardianResetDelayMs: num(env.GUARDIAN_RESET_DELAY_MS, isProduction ? DAY : 0),
    bodyLimit: env.BODY_LIMIT || '100kb',
  },

  // Uploads are re-encoded server-side; the decoded file never reaches storage.
  uploads: {
    maxBytes: num(env.UPLOAD_MAX_BYTES, 15 * 1024 * 1024),
    maxPixels: num(env.UPLOAD_MAX_PIXELS, 50 * 1000 * 1000),
    // Detected (magic-byte) formats accepted. The declared MIME is ignored.
    allowedFormats: ['jpeg', 'png', 'webp', 'heif', 'avif'],
  },

  // Phone videos (MP4/MOV, H.264/HEVC). Uploaded in fixed-size chunks to a
  // per-upload session, checked with ffprobe, transcoded in the background
  // (one at a time, low priority) to 720p H.264/AAC with every metadata tag
  // dropped, then stored as encrypted segments. See src/media/video.js.
  video: {
    // Upload ceiling for the ORIGINAL file (phone 4K clips are large).
    maxBytes: num(env.VIDEO_MAX_BYTES, 500 * 1024 * 1024),
    // One chunk per request. Must stay under the edge body cap (20 MB).
    chunkBytes: num(env.VIDEO_CHUNK_BYTES, 8 * 1024 * 1024),
    maxSeconds: num(env.VIDEO_MAX_SECONDS, 180),
    // Containers round durations; a 3:00 clip may probe as 180.4 s.
    toleranceSeconds: 1,
    perHour: num(env.VIDEO_UPLOADS_PER_HOUR, 20),
    bytesPerHour: num(env.VIDEO_BYTES_PER_HOUR, 2 * 1024 * 1024 * 1024),
    // An upload session with no chunk for this long is dropped, temp file too.
    sessionIdleMs: num(env.VIDEO_SESSION_IDLE_MS, 30 * 60 * 1000),
    // Upload temp files and transcode scratch. On StarlingTek /data survives
    // a release swap, so a queued job is not lost with the old container.
    workDir:
      env.VIDEO_WORK_DIR || (env.STK_DATA_DIR ? `${env.STK_DATA_DIR}/video-work` : 'data/video-work'),
    ffmpegPath: env.FFMPEG_PATH || 'ffmpeg',
    ffprobePath: env.FFPROBE_PATH || 'ffprobe',
    // CPU share on a small shared droplet: x264 threads and nice level.
    threads: num(env.VIDEO_THREADS, 2),
    nice: num(env.VIDEO_NICE, 15),
    maxAttempts: num(env.VIDEO_MAX_ATTEMPTS, 3),
    // A running job whose lease runs out (crash, restart) is retried.
    leaseMs: num(env.VIDEO_JOB_LEASE_MS, 20 * 60 * 1000),
    // One ffmpeg run is killed after this long.
    ffmpegTimeoutMs: num(env.VIDEO_FFMPEG_TIMEOUT_MS, 15 * 60 * 1000),
    pollMs: num(env.VIDEO_POLL_MS, 5000),
  },

  media: {
    // 'local' (dev, zero cost) or 'spaces' (DigitalOcean Spaces, production).
    backend: env.MEDIA_BACKEND || (isProduction ? 'spaces' : 'local'),
    localDir: env.MEDIA_LOCAL_DIR || 'data/media',
    spaces: {
      endpoint: env.DO_SPACES_ENDPOINT || '',
      region: env.DO_SPACES_REGION || 'us-east-1',
      bucket: env.DO_SPACES_BUCKET || '',
      key: env.DO_SPACES_KEY || '',
      secret: env.DO_SPACES_SECRET || '',
    },
  },

  privacy: {
    // Bump when the privacy notice changes materially; members re-acknowledge.
    noticeVersion: env.PRIVACY_NOTICE_VERSION || '2026-11-09',
    downloadRetentionDays: num(env.DOWNLOAD_RETENTION_DAYS, 90),
    auditDetailRetentionDays: num(env.AUDIT_DETAIL_RETENTION_DAYS, 365),
    // Aggregate daily usage counts (Usage page): about 13 months.
    usageRetentionDays: num(env.USAGE_RETENTION_DAYS, 400),
    ledgerStoresUserAgent: bool(env.LEDGER_STORE_USER_AGENT, false),
  },

  parentAuth: {
    requireMfa: bool(env.PARENT_MFA_REQUIRED, isProduction),
    stepUpTtlMs: num(env.PARENT_STEP_UP_TTL_MS, 5 * 60 * 1000),
  },

  governance: {
    // With a single guardian, exposure-widening and destructive actions wait
    // this long (and notify) before taking effect. Zero outside production so
    // local testing stays usable.
    soloDelayMs: num(env.GOVERNANCE_SOLO_DELAY_MS, isProduction ? DAY : 0),
    requestTtlMs: num(env.GOVERNANCE_REQUEST_TTL_MS, 7 * DAY),
  },

  notifications: {
    // 'console' (dev), 'memory' (tests), or 'smtp' (production).
    transport: env.NOTIFY_TRANSPORT || (isTest ? 'memory' : isProduction ? 'smtp' : 'console'),
    smtpUrl: env.SMTP_URL || '',
    from: env.NOTIFY_FROM || `${env.APP_NAME || 'Cubhouse'} <no-reply@localhost>`,
  },

  logging: {
    level: env.LOG_LEVEL || (isTest ? 'silent' : 'info'),
  },
};

module.exports = config;
