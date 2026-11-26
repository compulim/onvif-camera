#!/usr/bin/env node
import 'dotenv/config';
import { once } from 'node:events';
import { createCameraServer, deviceUrl } from './camera.js';
import { loadConfig, unsetProbedKeys } from './config.js';
import { startDiscovery } from './discovery.js';
import { initFiles } from './init.js';
import { createSnapshot, ffmpegInstalled, probeStream } from './media.js';

let server;
let discovery;
let stopping = false;

// Detects unset stream settings with ffprobe, if installed.
async function probe(config) {
  if (!unsetProbedKeys().length) return {};
  try {
    const probed = await probeStream(config.rtspUrl);
    console.log(`Probed ${config.rtspUrl}: ${Object.entries(probed).map(([key, value]) => `${key}=${value}`).join(' ')}`);
    return probed;
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn('ffprobe not found; advertising configured or default stream settings.');
    } else {
      console.warn(`Could not probe ${config.rtspUrl}; advertising configured or default stream settings.`);
    }
    return {};
  }
}

async function shutdown(error) {
  if (stopping) return;
  stopping = true;
  if (error) console.error(error.message);
  const results = await Promise.allSettled([
    discovery?.close(),
    server?.listening ? new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections();
    }) : undefined
  ]);
  process.exitCode = error || results.some(result => result.status === 'rejected') ? 1 : 0;
}

if (process.argv.includes('--init')) {
  try {
    const { created, skipped } = await initFiles();
    for (const file of created) console.log(`Created ${file}`);
    for (const file of skipped) console.warn(`Skipped ${file}: already exists; not overwriting.`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
} else {
  process.once('SIGINT', () => void shutdown());
  process.once('SIGTERM', () => void shutdown());

  try {
    let config = loadConfig();
    config = loadConfig(process.env, undefined, await probe(config));
    const snapshot = await ffmpegInstalled() ? createSnapshot(config.rtspUrl) : undefined;
    if (!snapshot) console.warn('ffmpeg not found; snapshots are disabled.');
    // Stop if a signal arrived while probing.
    if (!stopping) {
      server = createCameraServer(config, { snapshot }).listen(config.port, config.bind);
      await once(server, 'listening');
      server.on('error', error => void shutdown(error));
    }
    if (!stopping) {
      if (config.discovery) discovery = startDiscovery(config, error => void shutdown(error));
      console.log(`ONVIF camera listening at ${deviceUrl(config)}`);
      console.log(`Advertising RTSP stream at ${config.rtspUrl}`);
      if (!config.username) console.warn('ONVIF authentication is disabled. Use only on a trusted LAN.');
    }
  } catch (error) {
    await shutdown(error);
  }
}
