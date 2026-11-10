'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { plainPng } = require('./makeImages');
const { rawRequest } = require('../helpers');

/**
 * Video test helpers. Every clip is SYNTHETIC (ffmpeg's testsrc pattern and a
 * sine tone), generated in a temp dir during the test; the repo holds none.
 *
 * Tests that need real ffmpeg/ffprobe skip with a clear message when they are
 * not installed. CI installs them (.github/workflows/ci.yml).
 */

const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const FFPROBE = process.env.FFPROBE_PATH || 'ffprobe';

function works(bin) {
  try {
    return spawnSync(bin, ['-hide_banner', '-version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
}

const HAVE_FFMPEG = works(FFMPEG) && works(FFPROBE);
const SKIP_FFMPEG = HAVE_FFMPEG
  ? false
  : 'SKIPPED: ffmpeg/ffprobe are not installed here (CI installs them; locally: apt install ffmpeg or brew install ffmpeg)';

// A fake phone location and device, which must NOT survive processing.
const FAKE_GPS = '+40.6892-074.0445+010.000/';
const FAKE_MAKE = 'PhoneCoTestMake';
const FAKE_MODEL = 'PocketTestModel15';

function ffmpeg(args) {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`ffmpeg failed: ${r.stderr}`);
  }
}

function ffprobeJson(file) {
  const r = spawnSync(FFPROBE, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', file], {
    encoding: 'utf8',
  });
  if (r.status !== 0) {
    throw new Error(`ffprobe failed: ${r.stderr}`);
  }
  return JSON.parse(r.stdout);
}

/**
 * A short H.264/AAC clip tagged like a phone video: GPS (both the MP4 ©xyz
 * "location" tag and the QuickTime ISO6709 key), make and model, a creation
 * time, and optionally a 90-degree display rotation.
 */
function makeClip(dir, { name = 'clip.mov', seconds = 1, width = 320, height = 240, rotate = 0, tagged = true } = {}) {
  const base = path.join(dir, `base-${name}`);
  const out = path.join(dir, name);
  const tags = tagged
    ? [
        '-metadata', `location=${FAKE_GPS}`,
        '-metadata', `com.apple.quicktime.location.ISO6709=${FAKE_GPS}`,
        '-metadata', `com.apple.quicktime.make=${FAKE_MAKE}`,
        '-metadata', `com.apple.quicktime.model=${FAKE_MODEL}`,
        '-metadata', `make=${FAKE_MAKE}`,
        '-metadata', `model=${FAKE_MODEL}`,
        '-metadata', 'creation_time=2024-05-01T10:00:00Z',
        '-metadata:s:v:0', `location=${FAKE_GPS}`,
        '-movflags', 'use_metadata_tags',
      ]
    : [];
  ffmpeg([
    '-f', 'lavfi', '-i', `testsrc=size=${width}x${height}:rate=15:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-shortest',
    ...tags,
    base,
  ]);
  if (!rotate) {
    fs.renameSync(base, out);
    return out;
  }
  // Display rotation the way phones store it (a matrix, not rotated pixels).
  try {
    ffmpeg(['-display_rotation', String(rotate), '-i', base, '-c', 'copy', ...tags, out]);
  } catch {
    // Older ffmpeg (Debian 12 ships 5.1): the rotate tag writes the matrix.
    ffmpeg(['-i', base, '-c', 'copy', '-metadata:s:v:0', `rotate=${rotate}`, ...tags, out]);
  }
  fs.rmSync(base, { force: true });
  return out;
}

/** The first bytes of an MP4 / MOV / HEIC file, for magic-byte checks. */
function ftypHead(major, compatible = []) {
  const brands = [major, ...compatible];
  const size = 16 + 4 * compatible.length;
  const buf = Buffer.alloc(Math.max(size, 64));
  buf.writeUInt32BE(size, 0);
  buf.write('ftyp', 4, 'latin1');
  buf.write(major, 8, 'latin1');
  buf.writeUInt32BE(0x200, 12);
  brands.slice(1).forEach((b, i) => buf.write(b, 16 + 4 * i, 'latin1'));
  return buf;
}

/** A fake MP4 of `size` bytes: real ftyp head, then filler. */
function fakeMp4(size) {
  const buf = Buffer.alloc(size, 7);
  ftypHead('isom', ['iso2', 'mp41']).copy(buf, 0, 0, Math.min(64, size));
  return buf;
}

/** An ffmpeg stand-in for route tests that do not need real video. */
async function fakeFfmpeg(overrides = {}) {
  const poster = await plainPng({ width: 64, height: 48 });
  return {
    calls: [],
    probeResult: {
      formatName: 'mov,mp4,m4a,3gp,3g2,mj2',
      durationSec: 2,
      video: { codec: 'h264', width: 320, height: 240, rotation: 0 },
      hasAudio: true,
    },
    async isAvailable() {
      return true;
    },
    async probe() {
      return this.probeResult;
    },
    async transcode(input, output) {
      this.calls.push('transcode');
      fs.copyFileSync(input, output);
    },
    async extractFrame() {
      return poster;
    },
    ...overrides,
  };
}

/** JSON helpers for the video routes, as a signed-in browser would call them. */
async function api(client, method, urlPath, { fields, body, headers = {} } = {}) {
  if (method !== 'GET' && headers['x-csrf-token'] === undefined) {
    // The token belongs to the signed-in session (login rotates it).
    await client.refreshToken();
  }
  let payload = body || null;
  const h = { cookie: client.cookieHeader(), accept: 'application/json', ...headers };
  if (fields) {
    payload = Buffer.from(new URLSearchParams(fields).toString());
    h['content-type'] = 'application/x-www-form-urlencoded';
  }
  if (method !== 'GET' && h['x-csrf-token'] === undefined) {
    h['x-csrf-token'] = client.token || '';
  }
  if (payload) {
    h['content-length'] = payload.length;
  }
  const res = await rawRequest(client.base, urlPath, { method, headers: h, body: payload });
  client.absorb(res);
  let json;
  try {
    json = JSON.parse(res.body);
  } catch {
    json = null;
  }
  return { ...res, json };
}

function startUpload(client, size, extra = {}) {
  return api(client, 'POST', '/videos/uploads', { fields: { size: String(size), ...extra } });
}

function putChunk(client, id, index, bytes, headers = {}) {
  return api(client, 'PUT', `/videos/uploads/${id}/chunks/${index}`, {
    body: bytes,
    headers: { 'content-type': 'application/octet-stream', ...headers },
  });
}

/** Upload a whole buffer in chunks (in order) and finish; returns the finish response. */
async function uploadVideo(client, bytes, extra = {}) {
  const started = await startUpload(client, bytes.length, extra);
  if (!started.json || !started.json.ok) {
    return started;
  }
  const { id, chunkBytes, chunkCount } = started.json.upload;
  for (let i = 0; i < chunkCount; i += 1) {
    const r = await putChunk(client, id, i, bytes.subarray(i * chunkBytes, (i + 1) * chunkBytes));
    if (!r.json || !r.json.ok) {
      return r;
    }
  }
  return api(client, 'POST', `/videos/uploads/${id}/complete`, { fields: {} });
}

module.exports = {
  HAVE_FFMPEG,
  SKIP_FFMPEG,
  FFMPEG,
  FFPROBE,
  FAKE_GPS,
  FAKE_MAKE,
  FAKE_MODEL,
  makeClip,
  ffprobeJson,
  ftypHead,
  fakeMp4,
  fakeFfmpeg,
  api,
  startUpload,
  putChunk,
  uploadVideo,
};
