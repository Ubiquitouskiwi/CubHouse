'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const flash = require('connect-flash');

const config = require('./config');
const { logger, errorFields } = require('./logger');
const { createStore } = require('./store');
const { hashPassword } = require('./auth');
const { portalCapabilities, ROLE_LABELS } = require('./permissions');
const { createSecurityHeaders, noStore } = require('./security/headers');
const { createCsrf } = require('./security/csrf');
const { createRateLimiters } = require('./security/rateLimiters');
const { createSessionGuard, createRequireStepUp } = require('./security/sessionGuard');
const { configFindings, storeFindings, enforce, assertNotDeployedDev } = require('./security/bootstrapChecks');
const { createMediaService } = require('./media');
const { createNotifier } = require('./notify');
const { createGovernance } = require('./governance');
const { createActions } = require('./services/actions');
const { scheduleRetention } = require('./jobs/retention');
const { BadInput } = require('./validation');

const authRoutes = require('./routes/auth');
const pageRoutes = require('./routes/pages');
const accountRoutes = require('./routes/account');
const adminRoutes = require('./routes/admin');
const photoRoutes = require('./routes/photos');
const albumRoutes = require('./routes/albums');

// Stylesheet cache-busting token, computed once at boot (not per request).
const ASSET_VERSION = (() => {
  try {
    return String(Math.floor(fs.statSync(path.join(__dirname, '..', 'public', 'styles.css')).mtimeMs));
  } catch {
    return String(Date.now());
  }
})();

/**
 * Build the Express app around a data store.
 *
 * options:
 *   sessionStore  express-session store (default: Postgres when DATABASE_URL
 *                 is set, otherwise the in-process memory store)
 *   mediaStorage  media storage backend (default: from config.media)
 *   notifier      notification sender (default: from config.notifications)
 */
async function buildApp(store, options = {}) {
  const app = express();
  const runtime = { storeKind: store.kind || 'unknown' };

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, 'views'));
  app.disable('x-powered-by');
  // Must be set BEFORE the session middleware: secure cookies and req.ip both
  // depend on it. The exact hop count means a client cannot forge req.ip.
  app.set('trust proxy', config.trustProxyHops > 0 ? config.trustProxyHops : false);

  // --- Services ---
  const notifier = options.notifier || createNotifier();
  const media = createMediaService({ store, config, storage: options.mediaStorage });
  runtime.mediaKind = media.backendKind;
  const actions = createActions({ store, media, config, notifier });
  const governance = createGovernance({ store, config, notifier, executors: actions.executors });

  let rateLimitStoreFactory;
  if (config.databaseUrl && !options.memoryRateLimits) {
    const { PgRateLimitStore } = require('./store/pgSupport');
    rateLimitStoreFactory = (name) => new PgRateLimitStore(config.databaseUrl, name);
    runtime.rateLimitShared = true;
  } else {
    runtime.rateLimitShared = false;
  }
  const limiters = createRateLimiters({ storeFactory: rateLimitStoreFactory });

  let sessionStore = options.sessionStore;
  if (!sessionStore && config.databaseUrl) {
    const { createPgSessionStore } = require('./store/pgSupport');
    sessionStore = createPgSessionStore(session, config.databaseUrl);
  }
  runtime.sessionStoreKind = sessionStore ? 'shared' : 'memory';

  if (!options.skipSafeBoot) {
    enforce(configFindings(config, runtime), { isProduction: config.isProduction, logger });
  }

  const csrf = createCsrf();
  const requireStepUp = createRequireStepUp({ config });
  const ctx = { store, config, media, notifier, governance, actions, limiters, requireStepUp };
  app.locals.services = ctx;

  // --- Middleware, in order ---
  app.use(createSecurityHeaders({ isProduction: config.isProduction }));
  // Liveness: the process is up and serving. Mounted before sessions, so a
  // probe never touches the database or the session store. Deliberately does
  // NOT check the database or email: a platform that restarts or rolls back
  // on a failed probe (StarlingTek, Docker HEALTHCHECK) cannot fix either, and
  // boot already refuses to listen without a working database (store.init).
  // Dependency health is /readyz.
  app.get('/healthz', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({ status: 'ok' });
  });
  app.use(
    express.static(path.join(__dirname, '..', 'public'), {
      index: false,
      dotfiles: 'deny',
      maxAge: config.isProduction ? '1h' : 0,
    })
  );
  app.use(express.urlencoded({ extended: false, limit: config.security.bodyLimit, parameterLimit: 200 }));

  app.use(
    session({
      name: config.session.name,
      secret: config.session.secret,
      store: sessionStore,
      cookie: {
        httpOnly: config.session.cookie.httpOnly,
        secure: config.session.cookie.secure,
        sameSite: config.session.cookie.sameSite,
        path: '/',
        maxAge: config.session.idleTimeoutMs,
      },
      rolling: true,
      resave: false,
      saveUninitialized: false,
      proxy: config.trustProxyHops > 0,
    })
  );
  app.use(flash());
  app.use(createSessionGuard({ store, config }));
  // Multipart bodies (photo upload, trace lookup) are parsed before CSRF so
  // their _csrf field is checked like any other form.
  app.use(photoRoutes.createUploadParser({ config }));
  app.use(csrf.protect);

  app.use((req, res, next) => {
    const user = req.user || null;
    res.locals.currentUser = user ? { id: user.id, role: user.role, displayName: user.displayName } : null;
    res.locals.can = portalCapabilities(user ? user.role : null);
    res.locals.roleLabel = user ? ROLE_LABELS[user.role] || user.role : null;
    res.locals.theme = (user && user.theme) || 'system';
    res.locals.flash = { error: req.flash('error'), success: req.flash('success') };
    res.locals.assetVersion = ASSET_VERSION;
    res.locals.siteName = config.app.name;
    res.locals.footerText = config.app.footerText;
    res.locals.csrfToken = csrf.generateToken(req);
    res.locals.privacyNoticeOutdated = Boolean(user && user.privacyNoticeVersion !== config.privacy.noticeVersion);
    next();
  });
  // Nothing rendered by the app may be cached: it is all family content.
  app.use(noStore);

  app.use('/', authRoutes(ctx));
  app.use('/', pageRoutes(ctx));
  app.use('/', accountRoutes(ctx));
  app.use('/', adminRoutes(ctx));
  app.use('/', photoRoutes(ctx));
  app.use('/', albumRoutes(ctx));

  app.use((req, res) => {
    res.status(404).render('error', { title: 'Not Found', message: 'That page could not be found.' });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    let status = err.status || err.statusCode || 500;
    let message = 'Something went wrong on our end.';
    if (err.code === 'EBADCSRFTOKEN') {
      status = 403;
      message = 'This form expired. Please go back, refresh the page, and try again.';
    } else if (err instanceof BadInput) {
      status = 400;
      message = 'That request was not understood.';
    } else if (err.type === 'entity.too.large') {
      status = 413;
      message = 'That request was too large.';
    } else if (status >= 500) {
      logger.error({ ...errorFields(err), path: req.path, method: req.method }, 'request failed');
    }
    if (res.headersSent) {
      return res.end();
    }
    res.locals.flash = res.locals.flash || { error: [], success: [] };
    res.locals.currentUser = res.locals.currentUser || null;
    res.locals.can = res.locals.can || portalCapabilities(null);
    res.locals.theme = res.locals.theme || 'system';
    res.locals.assetVersion = ASSET_VERSION;
    res.locals.siteName = config.app.name;
    res.locals.footerText = config.app.footerText;
    res.locals.csrfToken = res.locals.csrfToken || '';
    return res.status(status).render('error', { title: status === 403 ? 'Not allowed' : 'Error', message });
  });

  return app;
}

// --- Seeding (development convenience, and the first guardian) ---

async function seedAccountIfMissing(store, { email, password, displayName, role, mustChangePassword }) {
  if (await store.findUserByEmail(email)) {
    return false;
  }
  const user = await store.createUser({
    email,
    passwordHash: await hashPassword(password),
    displayName,
    role,
    privacyNoticeVersion: config.privacy.noticeVersion,
  });
  if (mustChangePassword) {
    await store.updateUser(user.id, { mustChangePassword: true });
  }
  return true;
}

/**
 * The first guardian is seeded into an empty store. In production that
 * account must change its password at first sign-in. Dev and user test
 * accounts are seeded only with SEED_TEST_ACCOUNTS=true outside production.
 * Passwords are never logged.
 */
async function seedAccounts(store) {
  const users = await store.listUsers();
  if (users.length === 0) {
    const created = await seedAccountIfMissing(store, {
      email: config.seedAdmin.email,
      password: config.seedAdmin.password,
      displayName: 'Parents',
      role: 'parent',
      mustChangePassword: config.isProduction,
    });
    if (created) {
      logger.info('Seeded the first guardian account from SEED_ADMIN_EMAIL.');
    }
  }
  if (!config.seed.testAccountsEnabled) {
    return;
  }
  await seedAccountIfMissing(store, {
    email: config.seedDev.email,
    password: config.seedDev.password,
    displayName: 'Developer',
    role: 'dev',
  });
  await seedAccountIfMissing(store, {
    email: config.seedUser.email,
    password: config.seedUser.password,
    displayName: 'Family Member',
    role: 'user',
  });
  logger.info('Seeded dev and user test accounts (development only).');
}

/** Sample photos (generated, not real) for local development only. */
async function seedSampleContent(store, media) {
  if (!config.seed.testAccountsEnabled || (await store.listPhotos()).length > 0) {
    return;
  }
  const sharp = require('sharp');
  const parent = await store.findUserByEmail(config.seedAdmin.email);
  const user = await store.findUserByEmail(config.seedUser.email);
  const family = await store.createGroup({ name: 'Grandparents', note: 'Sample group for group-scoped sharing.' });
  if (user) {
    await store.addUserToGroup(user.id, family.id);
  }
  const samples = [
    { caption: 'First steps', color: '#3a6b5f', downloadable: true, audienceType: 'everyone' },
    { caption: 'Birthday morning', color: '#8a5a44', audienceType: 'everyone' },
    { caption: 'Grandparents only', color: '#4a5a8a', downloadable: true, audienceType: 'groups', audienceGroupIds: [family.id] },
    { caption: 'Private draft', color: '#6b6b6b', audienceType: 'parents' },
  ];
  for (const s of samples) {
    const png = await sharp({ create: { width: 800, height: 600, channels: 3, background: s.color } })
      .composite([
        {
          input: Buffer.from(
            `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600"><text x="400" y="310" font-size="56" fill="#fff" font-family="sans-serif" text-anchor="middle">${s.caption}</text></svg>`
          ),
        },
      ])
      .png()
      .toBuffer();
    const ingested = await media.ingest(png);
    await store.createPhoto({
      caption: s.caption,
      ...ingested,
      uploadedBy: parent ? parent.id : null,
      publishedBy: parent ? parent.id : null,
      downloadable: s.downloadable === true,
      watermark: true,
      audienceType: s.audienceType,
      audienceGroupIds: s.audienceGroupIds || [],
    });
  }
  logger.info('Seeded sample photos (development only).');
}

const seedAdmin = seedAccounts;

async function main() {
  assertNotDeployedDev(config);
  // Production on the memory store is refused by safe boot (DATABASE_URL).
  const store = createStore();
  if (typeof store.init === 'function') {
    await store.init();
  }
  enforce(await storeFindings(store), { isProduction: config.isProduction, logger });
  await seedAccounts(store);

  const app = await buildApp(store);
  const { media, governance, notifier } = app.locals.services;
  await seedSampleContent(store, media);
  scheduleRetention({ store, config, governance, notifier });

  // Email carries security alerts and governance requests, so check it at
  // boot and every 6 hours. A failure is logged and shown by /readyz (503),
  // which an external uptime check turns into an alert. It does not stop the
  // site: family members can still view photos while it is fixed.
  if ((await notifier.verify()) === 'failing') {
    logger.error('Startup email check FAILED: guardian alerts and approvals will not be delivered. See /readyz.');
  }
  setInterval(() => notifier.verify(), 6 * 60 * 60 * 1000).unref();

  process.on('unhandledRejection', (reason) => {
    logger.error(errorFields(reason instanceof Error ? reason : new Error(String(reason))), 'unhandled rejection');
  });

  const server = app.listen(config.port, config.host, () => {
    logger.info(
      { host: config.host, port: config.port, store: store.kind || 'pg', media: media.backendKind },
      'photo site listening'
    );
  });

  // Let in-flight requests finish when a deploy swap or systemd stops us. In a
  // container Node is PID 1, which ignores SIGTERM unless it is handled.
  const shutdown = (signal) => {
    logger.info({ signal }, 'shutting down');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 10 * 1000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    logger.fatal(errorFields(err), 'fatal startup error');
    // Make safe-boot failures readable on the console too.
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  });
}

module.exports = { buildApp, seedAccounts, seedAdmin, seedSampleContent, main };
