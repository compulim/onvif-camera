import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initEnv } from '../src/init.js';

test('initEnv copies .env.example to .env without overwriting', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'onvif-camera-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  assert.equal(await initEnv(dir), join(dir, '.env'));
  assert.equal(
    await readFile(join(dir, '.env'), 'utf8'),
    await readFile(new URL('../.env.example', import.meta.url), 'utf8')
  );

  await writeFile(join(dir, '.env'), 'CAMERA_NAME=custom\n');
  await assert.rejects(initEnv(dir), /already exists/);
  assert.equal(await readFile(join(dir, '.env'), 'utf8'), 'CAMERA_NAME=custom\n');
});
