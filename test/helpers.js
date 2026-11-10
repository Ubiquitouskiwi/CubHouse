'use strict';

/**
 * Shared test harness.
 *
 *   startApp()      boots the real app on an ephemeral loopback port with an
 *                   in-memory store, in-memory media, and a memory notifier.
 *   Client          a tiny browser: keeps cookies, follows the CSRF token
 *                   embedded in the last page it loaded, posts forms and
 *                   multipart uploads.
 *   seedUser()      creates an account directly in the store.
 *   addPhoto()      ingests a generated JPEG through the real media pipeline.
 */

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { makeStore } = require('./storeFactory');
const { buildApp } = require('../src/server');
const { hashPassword } = require('../src/auth');
const { createNotifier } = require('../src/notify');
const config = require('../src/config');
const { plainJpeg } = require('./fixtures/makeImages');

const PASSWORD = 'correct horse battery staple';

function memoryMediaStorage() {
  const objects = new Map();
  return {
    kind: 'memory',
    objects,
    async put(key, bytes) {
      objects.set(key, Buffer.from(bytes));
    },
    async get(key) {
      return objects.has(key) ? Buffer.from(objects.get(key)) : null;
    },
    async remove(key) {
      objects.delete(key);
    },
  };
}

async function startApp({ store: givenStore, ...options } = {}) {
  const store = givenStore || (await makeStore());
  const mediaStorage = options.mediaStorage || memoryMediaStorage();
  const notifier = options.notifier || createNotifier({ transport: 'memory' });
  // Video upload/transcode scratch in a private temp dir, never the repo.
  const videoWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cubhouse-video-'));
  const app = await buildApp(store, {
    mediaStorage,
    notifier,
    memoryRateLimits: true,
    ...options,
    video: { workDir: videoWorkDir, ...(options.video || {}) },
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    app,
    store,
    base,
    mediaStorage,
    notifier,
    services: app.locals.services,
    videoWorkDir,
    close: () =>
      new Promise((r) => server.close(r)).then(() => fs.rmSync(videoWorkDir, { recursive: true, force: true })),
    client: () => new Client(base),
  };
}

function rawRequest(base, path, { method = 'GET', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(base + path, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        resolve({
          status: res.statusCode,
          headers: res.headers,
          location: res.headers.location,
          buffer: buf,
          body: buf.toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    if (body) {
      req.write(body);
    }
    req.end();
  });
}

class Client {
  constructor(base) {
    this.base = base;
    this.cookies = new Map();
    this.token = null;
    this.authed = false;
  }

  cookieHeader() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorb(res) {
    for (const c of [].concat(res.headers['set-cookie'] || [])) {
      const [pair] = c.split(';');
      const idx = pair.indexOf('=');
      const name = pair.slice(0, idx);
      const value = pair.slice(idx + 1);
      if (/expires=Thu, 01 Jan 1970/i.test(c) || value === '') {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
    const ct = res.headers['content-type'] || '';
    if (ct.includes('text/html')) {
      const m = /name="_csrf" value="([^"]+)"/.exec(res.body);
      if (m) {
        this.token = m[1];
      }
    }
    return res;
  }

  async get(path, headers = {}) {
    const res = await rawRequest(this.base, path, { headers: { cookie: this.cookieHeader(), ...headers } });
    return this.absorb(res);
  }

  /** Load a page that carries a fresh CSRF token for this session. */
  async refreshToken() {
    this.token = null;
    let res = await this.get(this.authed ? '/settings' : '/login');
    // Follow local redirects like a browser (e.g. the MFA enrollment gate).
    for (let hops = 0; hops < 3 && res.status === 302 && res.location && res.location.startsWith('/'); hops += 1) {
      res = await this.get(res.location);
    }
    return this.token;
  }

  async post(path, fields = {}, { csrf = true, headers = {} } = {}) {
    if (csrf && fields._csrf === undefined) {
      await this.refreshToken();
    }
    const params = new URLSearchParams();
    const all = csrf && fields._csrf === undefined ? { ...fields, _csrf: this.token || '' } : fields;
    for (const [k, v] of Object.entries(all)) {
      if (Array.isArray(v)) {
        v.forEach((item) => params.append(k, item));
      } else if (v !== undefined && v !== null) {
        params.append(k, String(v));
      }
    }
    const body = params.toString();
    const res = await rawRequest(this.base, path, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'content-length': Buffer.byteLength(body),
        cookie: this.cookieHeader(),
        ...headers,
      },
      body,
    });
    return this.absorb(res);
  }

  async postMultipart(path, fields = {}, file = null, { csrf = true, headers = {} } = {}) {
    if (csrf) {
      await this.refreshToken();
    }
    const boundary = `----photos${Math.random().toString(16).slice(2)}`;
    const parts = [];
    const all = csrf ? { _csrf: this.token || '', ...fields } : fields;
    for (const [k, v] of Object.entries(all)) {
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
    }
    if (file) {
      parts.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="${file.filename || 'photo.jpg'}"\r\n` +
            `Content-Type: ${file.type || 'image/jpeg'}\r\n\r\n`
        ),
        file.buffer,
        Buffer.from('\r\n')
      );
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(parts);
    const res = await rawRequest(this.base, path, {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        'content-length': body.length,
        cookie: this.cookieHeader(),
        ...headers,
      },
      body,
    });
    return this.absorb(res);
  }

  async login(email, password = PASSWORD) {
    const res = await this.post('/login', { email, password });
    if (res.status === 302 && res.location === '/home') {
      this.authed = true;
    }
    return res;
  }
}

async function seedUser(store, { email, role = 'user', displayName, password = PASSWORD, groupIds } = {}) {
  return store.createUser({
    email,
    passwordHash: await hashPassword(password),
    displayName: displayName || email.split('@')[0],
    role,
    groupIds,
    privacyNoticeVersion: config.privacy.noticeVersion,
  });
}

/** A family with two guardians and a member, plus logged-in clients. */
async function seedFamily(env, { twoGuardians = false } = {}) {
  const parent = await seedUser(env.store, { email: 'parent@test.com', role: 'parent', displayName: 'Pat' });
  const parent2 = twoGuardians
    ? await seedUser(env.store, { email: 'parent2@test.com', role: 'parent', displayName: 'Sam' })
    : null;
  const member = await seedUser(env.store, { email: 'member@test.com', role: 'user', displayName: 'Grandma' });
  return { parent, parent2, member };
}

/** The manual two-step setup key shown on /settings/security, without spaces. */
function setupKeyFrom(body) {
  return /id="mfa-setup-key">([A-Z2-7 ]+)<\/code>/.exec(body)[1].replace(/ /g, '');
}

async function addPhoto(env, fields = {}, image) {
  const bytes = image || (await plainJpeg());
  const ingested = await env.services.media.ingest(bytes);
  return env.store.createPhoto({ caption: 'A photo', ...ingested, ...fields });
}

module.exports = {
  PASSWORD,
  startApp,
  Client,
  rawRequest,
  seedUser,
  seedFamily,
  addPhoto,
  setupKeyFrom,
  memoryMediaStorage,
};
