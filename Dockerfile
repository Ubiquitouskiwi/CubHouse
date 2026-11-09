# Production image. Used as-is by StarlingTek (a repo Dockerfile always wins
# there) and by any other container host. See docs/DEPLOY-STARLINGTEK.md.
#
# Debian slim (glibc) rather than Alpine: sharp ships prebuilt libvips for
# linux-x64 and linux-arm64 glibc, so no system image libraries or compilers
# are needed. Node's bundled CA store covers Spaces and SMTP over TLS; the
# managed Postgres CA is mounted at run time (PGSSLROOTCERT).

ARG NODE_VERSION=22

# --- Stage 1: production dependencies only ---------------------------------
FROM node:${NODE_VERSION}-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# --- Stage 2: runtime ---------------------------------------------------------
FROM node:${NODE_VERSION}-bookworm-slim
# Production by default: safe boot refuses to start on any unsafe setting.
# HOST=0.0.0.0 because the host reaches the app through a published port; the
# publish must be 127.0.0.1 only (StarlingTek always does this). APP_IN_CONTAINER
# tells safe boot that the wildcard bind is the container's, not the host's.
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    APP_IN_CONTAINER=true
WORKDIR /app

# Code is owned by root and read-only to the app user. Only data/ (local media
# in development; unused in production, where media is in a private bucket) is
# writable.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
RUN mkdir -p /app/data && chown node:node /app/data

# The base image's unprivileged "node" user is uid/gid 1000, which is also the
# owner StarlingTek gives the /data mount.
USER node
EXPOSE 3000

# Liveness only (see src/server.js): a restart cannot fix the database or email.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/healthz').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]

# Node handles SIGTERM itself (graceful drain in src/server.js).
CMD ["node", "src/server.js"]
