import { execFile } from 'node:child_process';
import * as v from 'valibot';

const timeout = 15000;
const snapshotMaxAge = 1000;

const ProbeSchema = v.looseObject({
  streams: v.array(v.looseObject({
    codec_type: v.optional(v.string()),
    width: v.optional(v.number()),
    height: v.optional(v.number()),
    avg_frame_rate: v.optional(v.string()),
    r_frame_rate: v.optional(v.string()),
    bit_rate: v.optional(v.string()),
    sample_rate: v.optional(v.string()),
    channels: v.optional(v.number())
  }))
});

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout, killSignal: 'SIGKILL', windowsHide: true, ...options }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

// RTSP over TCP avoids UDP packet loss on bursty keyframes.
function inputArgs(url) {
  return [...(/^rtsps?:/i.test(url) ? ['-rtsp_transport', 'tcp'] : []), '-i', url];
}

// "30000/1001" -> 30; "0/0" -> undefined.
function frameRate(value = '') {
  const [numerator, denominator = '1'] = value.split('/');
  const rate = Number(numerator) / Number(denominator);
  return Number.isFinite(rate) && rate > 0 ? Math.round(rate) : undefined;
}

function kilobits(value) {
  const bits = Number(value);
  return bits > 0 ? Math.round(bits / 1000) : undefined;
}

// Converts ffprobe JSON output into CAMERA_* settings; values not reported are omitted.
function parseProbe(json) {
  const { streams } = v.parse(ProbeSchema, JSON.parse(json));
  const video = streams.find(stream => stream.codec_type === 'video');
  if (!video) throw new Error('The stream has no video');
  // Streams may have no audio; advertise a video-only profile in that case.
  const audio = streams.find(stream => stream.codec_type === 'audio');
  const values = {
    CAMERA_WIDTH: video.width,
    CAMERA_HEIGHT: video.height,
    CAMERA_FPS: frameRate(video.avg_frame_rate) ?? frameRate(video.r_frame_rate),
    CAMERA_BITRATE: kilobits(video.bit_rate),
    CAMERA_AUDIO: Boolean(audio),
    ...(audio ? {
      CAMERA_AUDIO_BITRATE: kilobits(audio.bit_rate),
      CAMERA_AUDIO_SAMPLE_RATE: audio.sample_rate,
      CAMERA_AUDIO_CHANNELS: audio.channels
    } : {})
  };
  return Object.fromEntries(Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => [key, String(value)]));
}

// Rejects with code ENOENT if ffprobe is not installed.
async function probeStream(url) {
  return parseProbe(await run('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', ...inputArgs(url)]));
}

async function ffmpegInstalled() {
  try {
    await run('ffmpeg', ['-hide_banner', '-version']);
    return true;
  } catch {
    return false;
  }
}

// Returns a function that grabs one JPEG frame from the stream. Concurrent and
// back-to-back requests share a single ffmpeg process to bound resource usage.
function createSnapshot(url) {
  let cached;
  let cachedAt = 0;
  let pending;
  return () => {
    if (cached && Date.now() - cachedAt < snapshotMaxAge) return Promise.resolve(cached);
    pending ??= run('ffmpeg', [
      '-v', 'error',
      // Joining mid-GOP yields gray frames until the next keyframe; decode keyframes only.
      '-skip_frame', 'nokey',
      ...inputArgs(url),
      '-an',
      '-frames:v', '1',
      '-pix_fmt', 'yuvj420p',
      '-q:v', '3',
      '-f', 'mjpeg',
      'pipe:1'
    ], { encoding: 'buffer', maxBuffer: 16 * 1024 * 1024 })
      .then(jpeg => {
        if (!jpeg.length) throw new Error('No frame was captured');
        cached = jpeg;
        cachedAt = Date.now();
        return jpeg;
      })
      .finally(() => {
        pending = undefined;
      });
    return pending;
  };
}

export { createSnapshot, ffmpegInstalled, parseProbe, probeStream };
