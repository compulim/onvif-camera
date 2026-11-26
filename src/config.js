import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import * as v from 'valibot';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const defaults = {
  CAMERA_BIND: '0.0.0.0',
  CAMERA_PORT: '8000',
  CAMERA_NAME: 'onvif-camera',
  CAMERA_MANUFACTURER: 'Raspberry Pi',
  CAMERA_MODEL: 'Camera Module',
  CAMERA_FIRMWARE_VERSION: version,
  CAMERA_HARDWARE_ID: 'onvif-camera',
  CAMERA_RTSP_PORT: '8554',
  CAMERA_RTSP_PATH: 'camera',
  CAMERA_WIDTH: '1920',
  CAMERA_HEIGHT: '1080',
  CAMERA_FPS: '30',
  CAMERA_BITRATE: '20000',
  CAMERA_AUDIO: 'true',
  CAMERA_AUDIO_BITRATE: '128',
  CAMERA_AUDIO_SAMPLE_RATE: '44100',
  CAMERA_AUDIO_CHANNELS: '2',
  CAMERA_DISCOVERY: 'true',
  CAMERA_USERNAME: '',
  CAMERA_PASSWORD: ''
};

// CAMERA_ADDRESS defaults to the first LAN IPv4 address of this host.
function defaultAddress(interfaces) {
  return Object.values(interfaces)
    .flat()
    .find(({ address, family, internal }) => (family === 'IPv4' || family === 4) && !internal && !address.startsWith('169.254.'))
    ?.address;
}

function integer(name, min, max) {
  const message = `${name} must be an integer between ${min} and ${max}`;
  return v.pipe(
    v.string(message),
    v.transform(Number),
    v.integer(message),
    v.minValue(min, message),
    v.maxValue(max, message)
  );
}

function flag(name) {
  return v.pipe(
    v.string(`${name} must be true or false`),
    v.transform(value => value !== 'false')
  );
}

function text(name) {
  return v.pipe(
    v.string(),
    v.trim(),
    v.maxLength(64, `${name} must be at most 64 characters`)
  );
}

function lanAddress(message) {
  return v.pipe(
    v.string(message),
    v.ipv4(message),
    v.check(address => address !== '0.0.0.0' && !address.startsWith('127.'), message)
  );
}

const pathMessage = 'CAMERA_RTSP_PATH must be a MediaMTX path name such as "camera"';

const EnvSchema = v.pipe(
  v.looseObject({
    CAMERA_ADDRESS: lanAddress('CAMERA_ADDRESS must be the LAN IPv4 address of this host'),
    CAMERA_ID: v.string(),
    CAMERA_BIND: v.pipe(v.string(), v.ip('CAMERA_BIND must be an IP address')),
    CAMERA_PORT: integer('CAMERA_PORT', 1, 65535),
    CAMERA_MEDIAMTX_ADDRESS: lanAddress('CAMERA_MEDIAMTX_ADDRESS must be the LAN IPv4 address of the MediaMTX server'),
    CAMERA_RTSP_PORT: integer('CAMERA_RTSP_PORT', 1, 65535),
    CAMERA_RTSP_PATH: v.pipe(
      v.string(pathMessage),
      v.regex(/^[\w.~-]+(?:\/[\w.~-]+)*$/, pathMessage),
      v.maxLength(255, pathMessage)
    ),
    CAMERA_NAME: v.string(),
    CAMERA_MANUFACTURER: text('CAMERA_MANUFACTURER'),
    CAMERA_MODEL: text('CAMERA_MODEL'),
    CAMERA_FIRMWARE_VERSION: text('CAMERA_FIRMWARE_VERSION'),
    CAMERA_SERIAL_NUMBER: v.optional(text('CAMERA_SERIAL_NUMBER')),
    CAMERA_HARDWARE_ID: text('CAMERA_HARDWARE_ID'),
    CAMERA_WIDTH: integer('CAMERA_WIDTH', 16, 7680),
    CAMERA_HEIGHT: integer('CAMERA_HEIGHT', 16, 4320),
    CAMERA_FPS: integer('CAMERA_FPS', 1, 60),
    CAMERA_BITRATE: integer('CAMERA_BITRATE', 100, 50000),
    CAMERA_AUDIO: flag('CAMERA_AUDIO'),
    CAMERA_AUDIO_BITRATE: integer('CAMERA_AUDIO_BITRATE', 8, 512),
    CAMERA_AUDIO_SAMPLE_RATE: integer('CAMERA_AUDIO_SAMPLE_RATE', 8000, 96000),
    CAMERA_AUDIO_CHANNELS: integer('CAMERA_AUDIO_CHANNELS', 1, 2),
    CAMERA_DISCOVERY: flag('CAMERA_DISCOVERY'),
    CAMERA_USERNAME: v.string(),
    CAMERA_PASSWORD: v.string()
  }),
  v.check(
    env => Boolean(env.CAMERA_USERNAME) === Boolean(env.CAMERA_PASSWORD),
    'Set both CAMERA_USERNAME and CAMERA_PASSWORD, or neither'
  )
);

function loadConfig(env = process.env, interfaces = networkInterfaces()) {
  // Empty values are treated as unset so that defaults apply.
  const set = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined && value !== ''));
  const address = set.CAMERA_ADDRESS ?? defaultAddress(interfaces);
  const result = v.safeParse(EnvSchema, {
    ...defaults,
    CAMERA_ADDRESS: address,
    CAMERA_ID: address,
    CAMERA_MEDIAMTX_ADDRESS: address,
    ...set
  });
  if (!result.success) throw new Error(result.issues[0].message);
  const parsed = result.output;
  const rtspUrl = new URL(`rtsp://${parsed.CAMERA_MEDIAMTX_ADDRESS}:${parsed.CAMERA_RTSP_PORT}/${parsed.CAMERA_RTSP_PATH}`);
  // Keep the endpoint identity stable across service restarts.
  const identity = createHash('sha256').update(parsed.CAMERA_ID).digest('hex');
  const uuid = `${identity.slice(0, 8)}-${identity.slice(8, 12)}-4${identity.slice(13, 16)}-8${identity.slice(17, 20)}-${identity.slice(20, 32)}`;
  return {
    id: parsed.CAMERA_ID,
    address: parsed.CAMERA_ADDRESS,
    bind: parsed.CAMERA_BIND,
    port: parsed.CAMERA_PORT,
    rtspUrl: rtspUrl.href,
    mediaMtxAddress: parsed.CAMERA_MEDIAMTX_ADDRESS,
    rtspPort: parsed.CAMERA_RTSP_PORT,
    name: parsed.CAMERA_NAME,
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
