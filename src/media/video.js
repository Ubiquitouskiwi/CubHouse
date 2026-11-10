'use strict';

const { UploadRejected } = require('./pipeline');

/**
 * Video rules shared by the upload routes and the processing job: what an
 * acceptable original looks like (checked with ffprobe, after the magic-byte
 * check in sniff.js), and the plain-language reason for each refusal.
 */

const ACCEPTED_CODECS = new Set(['h264', 'hevc']);
// ffprobe names the ISO/QuickTime demuxer "mov,mp4,m4a,3gp,3g2,mj2".
const ACCEPTED_FORMAT = /(^|,)(mov|mp4)(,|$)/;
// Phone 4K is 3840x2160; anything bigger is refused rather than decoded.
const MAX_SIDE = 4096;

const VIDEO_MESSAGES = Object.freeze({
  too_long: 'This video is longer than 3 minutes. Trim it on your phone, then add it again.',
  video_too_large: 'This video is too big to send. Trim it on your phone, or share a smaller copy.',
  unsupported_video: "Cubhouse can't read this kind of video. Phone videos (MP4 or MOV) work best.",
  processing_failed: "We couldn't process this video. Try adding it again, or try a different copy.",
});

function rejectVideo(code) {
  return new UploadRejected(VIDEO_MESSAGES[code] || VIDEO_MESSAGES.unsupported_video, code);
}

/** Longest accepted duration in seconds (3:00 plus a small rounding tolerance). */
function maxDurationSec(videoConfig) {
  return videoConfig.maxSeconds + videoConfig.toleranceSeconds;
}

/**
 * Throws UploadRejected if an ffprobe result is not a clip we accept:
 * an MP4/MOV container with an H.264 or HEVC video stream, at most 3:00 long
 * (the server's own measurement, whatever the browser said) and at most
 * 4096 px on a side.
 */
function assertAcceptableProbe(probe, videoConfig) {
  if (!probe || !ACCEPTED_FORMAT.test(probe.formatName) || !probe.video) {
    throw rejectVideo('unsupported_video');
  }
  if (!ACCEPTED_CODECS.has(probe.video.codec)) {
    throw rejectVideo('unsupported_video');
  }
  const { width, height } = probe.video;
  if (!width || !height || width > MAX_SIDE || height > MAX_SIDE) {
    throw rejectVideo('unsupported_video');
  }
  if (!(probe.durationSec > 0)) {
    throw rejectVideo('unsupported_video');
  }
  if (probe.durationSec > maxDurationSec(videoConfig)) {
    throw rejectVideo('too_long');
  }
  return { durationMs: Math.round(probe.durationSec * 1000) };
}

/** 0:07, 2:59 (video badges in the gallery and viewer). */
function formatDuration(ms) {
  const total = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

module.exports = { formatDuration, assertAcceptableProbe, rejectVideo, maxDurationSec, VIDEO_MESSAGES };
