'use strict';

const os = require('os');
const { spawn } = require('child_process');

/**
 * The only code that runs ffmpeg/ffprobe (Debian packages in the image).
 *
 * Every call passes an argument ARRAY (never a shell string), reads from and
 * writes to paths the app chose itself, runs at a low CPU priority with a
 * thread cap, and is killed after a timeout, so one clip cannot starve the
 * other sites on the droplet.
 */

const STDERR_KEEP = 8 * 1024;

function run(bin, args, { timeoutMs = 60 * 1000, nice = 0, maxStdout = 16 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    if (nice && child.pid) {
      try {
        os.setPriority(child.pid, nice);
      } catch {
        // Not fatal: the thread cap still limits CPU use.
      }
    }
    const out = [];
    let outBytes = 0;
    let stderr = '';
    let killedFor = null;
    const timer = setTimeout(() => {
      killedFor = 'timeout';
      child.kill('SIGKILL');
    }, timeoutMs);
    timer.unref();
    child.stdout.on('data', (c) => {
      outBytes += c.length;
      if (outBytes > maxStdout) {
        killedFor = 'output too large';
        child.kill('SIGKILL');
        return;
      }
      out.push(c);
    });
    child.stderr.on('data', (c) => {
      if (stderr.length < STDERR_KEEP) {
        stderr += c.toString('utf8').slice(0, STDERR_KEEP - stderr.length);
      }
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(Buffer.concat(out));
        return;
      }
      const err = new Error(`${bin} failed (${killedFor || signal || `exit ${code}`}): ${stderr.trim().slice(0, 500)}`);
      err.killedFor = killedFor;
      reject(err);
    });
  });
}

function createFfmpeg(videoConfig) {
  const { ffmpegPath, ffprobePath, threads, nice, ffmpegTimeoutMs } = videoConfig;
  let availability = null;

  /** True when both binaries run. Cached after the first answer. */
  async function isAvailable() {
    if (availability === null) {
      availability = Promise.all([
        run(ffmpegPath, ['-hide_banner', '-version'], { timeoutMs: 10000 }),
        run(ffprobePath, ['-hide_banner', '-version'], { timeoutMs: 10000 }),
      ]).then(
        () => true,
        () => false
      );
    }
    return availability;
  }

  /**
   * Container, duration, first real video stream, audio presence and every
   * tag (format and stream level). Throws if ffprobe cannot read the file.
   */
  async function probe(file) {
    const raw = await run(
      ffprobePath,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '-i', file],
      { timeoutMs: 30000, nice }
    );
    const info = JSON.parse(raw.toString('utf8'));
    const streams = Array.isArray(info.streams) ? info.streams : [];
    const format = info.format || {};
    const videoStream = streams.find(
      (s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic === 1)
    );
    const rotationOf = (s) => {
      const side = (s.side_data_list || []).find((d) => d.rotation !== undefined);
      if (side) {
        return Number(side.rotation) || 0;
      }
      return Number((s.tags || {}).rotate) || 0;
    };
    const duration = Number(format.duration) || (videoStream ? Number(videoStream.duration) : 0) || 0;
    return {
      formatName: String(format.format_name || ''),
      durationSec: duration,
      video: videoStream
        ? {
            codec: String(videoStream.codec_name || ''),
            width: Number(videoStream.width) || 0,
            height: Number(videoStream.height) || 0,
            rotation: rotationOf(videoStream),
          }
        : null,
      hasAudio: streams.some((s) => s.codec_type === 'audio'),
      streamTypes: streams.map((s) => s.codec_type),
      formatTags: format.tags || {},
      streamTags: streams.map((s) => s.tags || {}),
      sideData: streams.map((s) => s.side_data_list || []),
    };
  }

  /**
   * Transcode to the one playback format: H.264 High + AAC in MP4, at most
   * 1280x720 landscape or 720x1280 portrait (aspect kept, never upscaled),
   * rotation baked into the pixels, moov atom first (+faststart) so playback
   * starts before the whole file arrives.
   *
   * Privacy: -map_metadata -1 (global) plus the per-stream equivalents drop
   * EVERY tag, including GPS/location (QuickTime ISO6709 keys, MP4 ©xyz),
   * make/model/software and capture time; chapters, subtitles, data streams
   * (iPhone timed metadata tracks) and extra video tracks are not mapped.
   */
  async function transcode(input, output) {
    const box =
      "scale=w='if(gte(iw,ih),min(1280,iw),min(720,iw))':h='if(gte(iw,ih),min(720,ih),min(1280,ih))'" +
      ':force_original_aspect_ratio=decrease:force_divisible_by=2,setsar=1,format=yuv420p';
    const args = [
      '-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
      '-threads', String(threads),
      '-i', input,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-map_metadata', '-1', '-map_metadata:s:v', '-1', '-map_metadata:s:a', '-1',
      '-map_chapters', '-1',
      '-sn', '-dn',
      '-vf', box,
      '-c:v', 'libx264', '-profile:v', 'high', '-preset', 'veryfast', '-crf', '23',
      '-threads', String(threads),
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
      '-movflags', '+faststart',
      '-f', 'mp4', output,
    ];
    await run(ffmpegPath, args, { timeoutMs: ffmpegTimeoutMs, nice, maxStdout: 1024 * 1024 });
  }

  /** One PNG frame at `atSec` (for the poster; it then goes through sharp). */
  async function extractFrame(input, atSec) {
    const args = [
      '-nostdin', '-hide_banner', '-loglevel', 'error',
      '-threads', String(threads),
      '-ss', String(Math.max(0, atSec)),
      '-i', input,
      '-frames:v', '1', '-map_metadata', '-1',
      '-f', 'image2pipe', '-c:v', 'png', '-',
    ];
    return run(ffmpegPath, args, { timeoutMs: 60000, nice, maxStdout: 32 * 1024 * 1024 });
  }

  return { isAvailable, probe, transcode, extractFrame };
}

module.exports = { createFfmpeg, run };
