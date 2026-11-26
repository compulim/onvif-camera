#!/usr/bin/env node
import 'dotenv/config';
import { once } from 'node:events';
import { createCameraServer, deviceUrl } from './camera.js';
import { loadConfig } from './config.js';
import { startDiscovery } from './discovery.js';
import { initFiles } from './init.js';

let server;
let discovery;
let stopping = false;

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
    const config = loadConfig();
    server = createCameraServer(config).listen(config.port, config.bind);
    await once(server, 'listening');
    server.on('error', error => void shutdown(error));
    if (!stopping) {
      if (config.discovery) discovery = startDiscovery(config, error => void shutdown(error));
      console.log(`ONVIF camera listening at ${deviceUrl(config)}`);
      console.log(`Advertising MediaMTX stream at ${config.rtspUrl}`);
      if (!config.username) console.warn('ONVIF authentication is disabled. Use only on a trusted LAN.');
    }
  } catch (error) {
    await shutdown(error);
  }
}
