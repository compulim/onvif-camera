import { createHash } from 'node:crypto';
import * as v from 'valibot';

function integer(name, fallback, min, max) {
  const message = `${name} must be an integer between ${min} and ${max}`;
  return v.pipe(
    v.optional(v.string(message), String(fallback)),
    v.transform(Number),
    v.integer(message),
    v.minValue(min, message),
    v.maxValue(max, message)
  );
}

function flag(name) {
  return v.pipe(
    v.optional(v.string(`${name} must be true or false`), 'true'),
    v.transform(value => value !== 'false')
  );
}

function text(name, fallback) {
  return v.pipe(
    v.optional(v.string(), ''),
    v.trim(),
    v.transform(value => value || fallback),
    v.maxLength(64, `${name} must be at most 64 characters`)
  );
}

const rtspUrlMessage = 'CAMERA_RTSP_URL must be an rtsp:// or rtsps:// URL without credentials';

const RtspUrlSchema = v.pipe(
  v.string(rtspUrlMessage),
  v.url(rtspUrlMessage),
  v.transform(value => new URL(value)),
  v.check(url => ['rtsp:', 'rtsps:'].includes(url.protocol) && url.hostname !== '' && !url.username && !url.password, rtspUrlMessage)
);

const addressMessage = 'CAMERA_ADDRESS must be the Raspberry Pi LAN IPv4 address';

const EnvSchema = v.pipe(
  v.looseObject({
    CAMERA_ADDRESS: v.pipe(
      v.string(addressMessage),
      v.ipv4(addressMessage),
      v.check(address => address !== '0.0.0.0' && !address.startsWith('127.'), addressMessage)
    ),
    CAMERA_ID: v.optional(v.string()),
    CAMERA_BIND: v.pipe(
      v.optional(v.string(), ''),
      v.transform(bind => bind || '0.0.0.0'),
      v.ip('CAMERA_BIND must be an IP address')
    ),
    CAMERA_PORT: integer('CAMERA_PORT', 8000, 1, 65535),
    CAMERA_RTSP_URL: v.optional(v.string(rtspUrlMessage)),
    CAMERA_NAME: v.optional(v.string()),
    CAMERA_MANUFACTURER: text('CAMERA_MANUFACTURER', 'rpi-onvif-camera'),
    CAMERA_MODEL: text('CAMERA_MODEL', 'Raspberry Pi'),
    CAMERA_FIRMWARE_VERSION: text('CAMERA_FIRMWARE_VERSION', '1.0.0'),
    CAMERA_SERIAL_NUMBER: text('CAMERA_SERIAL_NUMBER', ''),
    CAMERA_HARDWARE_ID: text('CAMERA_HARDWARE_ID', 'rpi-onvif-camera'),
    CAMERA_WIDTH: integer('CAMERA_WIDTH', 1920, 16, 7680),
    CAMERA_HEIGHT: integer('CAMERA_HEIGHT', 1080, 16, 4320),
    CAMERA_FPS: integer('CAMERA_FPS', 30, 1, 60),
    CAMERA_BITRATE: integer('CAMERA_BITRATE', 20000, 100, 50000),
    CAMERA_AUDIO: flag('CAMERA_AUDIO'),
    CAMERA_AUDIO_BITRATE: integer('CAMERA_AUDIO_BITRATE', 128, 8, 512),
    CAMERA_AUDIO_SAMPLE_RATE: integer('CAMERA_AUDIO_SAMPLE_RATE', 48000, 8000, 96000),
    CAMERA_AUDIO_CHANNELS: integer('CAMERA_AUDIO_CHANNELS', 2, 1, 2),
    CAMERA_DISCOVERY: flag('CAMERA_DISCOVERY'),
    CAMERA_USERNAME: v.optional(v.string(), ''),
    CAMERA_PASSWORD: v.optional(v.string(), '')
  }),
  v.check(
    env => Boolean(env.CAMERA_USERNAME) === Boolean(env.CAMERA_PASSWORD),
    'Set both CAMERA_USERNAME and CAMERA_PASSWORD, or neither'
  )
);

function loadConfig(env = process.env) {
  const result = v.safeParse(EnvSchema, env);
  if (!result.success) throw new Error(result.issues[0].message);
  const parsed = result.output;
  const rtspResult = v.safeParse(RtspUrlSchema, parsed.CAMERA_RTSP_URL || `rtsp://${parsed.CAMERA_ADDRESS}:8554/camera`);
  if (!rtspResult.success) throw new Error(rtspResult.issues[0].message);
  const rtspUrl = rtspResult.output;
  // Keep the endpoint identity stable across service restarts.
  const identity = createHash('sha256').update(parsed.CAMERA_ID || parsed.CAMERA_ADDRESS).digest('hex');
  const uuid = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-4${identity.slice(13, 16)}-8${identity.slice(17, 20)}-${identity.slice(20, 32)}`;
  return {
    address: parsed.CAMERA_ADDRESS,
    bind: parsed.CAMERA_BIND,
    port: parsed.CAMERA_PORT,
    rtspUrl: rtspUrl.href,
    rtspPort: Number(rtspUrl.port) || (rtspUrl.protocol === 'rtsps:' ? 322 : 554),
    name: parsed.CAMERA_NAME || 'Raspberry Pi Camera',
    manufacturer: parsed.CAMERA_MANUFACTURER,
    model: parsed.CAMERA_MODEL,
    firmwareVersion: parsed.CAMERA_FIRMWARE_VERSION,
    hardwareId: parsed.CAMERA_HARDWARE_ID,
    width: parsed.CAMERA_WIDTH,
    height: parsed.CAMERA_HEIGHT,
    fps: parsed.CAMERA_FPS,
    bitrate: parsed.CAMERA_BITRATE,
    audio: parsed.CAMERA_AUDIO,
    audioBitrate: parsed.CAMERA_AUDIO_BITRATE,
    audioSampleRate: parsed.CAMERA_AUDIO_SAMPLE_RATE,
    audioChannels: parsed.CAMERA_AUDIO_CHANNELS,
    discovery: parsed.CAMERA_DISCOVERY,
    username: parsed.CAMERA_USERNAME,
    password: parsed.CAMERA_PASSWORD,
    serialNumber: parsed.CAMERA_SERIAL_NUMBER || uuid,
    uuid
  };
}

export { loadConfig };
