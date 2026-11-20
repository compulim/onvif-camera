#!/usr/bin/env node
import 'dotenv/config';
import { once } from 'node:events';
import { createCameraServer, deviceUrl } from './camera.js';
import { loadConfig } from './config.js';
import { startDiscovery } from './discovery.js';

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
    if (!config.username) console.warn('ONVIF authentication is disabled. Use only on a trusted LAN.');
  }
} catch (error) {
  await shutdown(error);
}
