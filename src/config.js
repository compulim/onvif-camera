import { createHash } from 'node:crypto';
import { isIPv4 } from 'node:net';

function integer(env, name, fallback, min, max) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function loadConfig(env = process.env) {
  const address = env.CAMERA_ADDRESS;
  if (!isIPv4(address ?? '') || address === '0.0.0.0' || address.startsWith('127.')) {
    throw new Error('CAMERA_ADDRESS must be the Raspberry Pi LAN IPv4 address');
  }
  const username = env.CAMERA_USERNAME || '';
  const password = env.CAMERA_PASSWORD || '';
  if (Boolean(username) !== Boolean(password)) {
    throw new Error('Set both CAMERA_USERNAME and CAMERA_PASSWORD, or neither');
  }
  // Keep the endpoint identity stable across service restarts.
  const identity = createHash('sha256').update(env.CAMERA_ID || address).digest('hex');
  return {
    address,
    bind: env.CAMERA_BIND || '0.0.0.0',
    port: integer(env, 'CAMERA_PORT', 8000, 1, 65535),
    rtspPort: integer(env, 'CAMERA_RTSP_PORT', 8554, 1, 65535),
    name: env.CAMERA_NAME || 'Raspberry Pi Camera',
    width: integer(env, 'CAMERA_WIDTH', 1280, 16, 7680),
    height: integer(env, 'CAMERA_HEIGHT', 720, 16, 4320),
    fps: integer(env, 'CAMERA_FPS', 15, 1, 60),
    bitrate: integer(env, 'CAMERA_BITRATE', 2000, 100, 50000),
    audio: env.CAMERA_AUDIO !== 'false',
    audioBitrate: integer(env, 'CAMERA_AUDIO_BITRATE', 128, 8, 512),
    audioSampleRate: integer(env, 'CAMERA_AUDIO_SAMPLE_RATE', 48, 8, 96),
    audioChannels: integer(env, 'CAMERA_AUDIO_CHANNELS', 2, 1, 2),
    discovery: env.CAMERA_DISCOVERY !== 'false',
    username,
    password,
    uuid: `${identity.slice(0, 8)}-${identity.slice(8, 12)}-4${identity.slice(13, 16)}-8${identity.slice(17, 20)}-${identity.slice(20, 32)}`
  };
}

export { loadConfig };
