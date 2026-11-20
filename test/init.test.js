import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initFiles } from '../src/init.js';

const template = name => readFile(new URL(`../${name}`, import.meta.url), 'utf8');

test('initFiles copies .env.example and mediamtx.yml without overwriting', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'onvif-camera-'));
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(join(dir, '.env'), 'CAMERA_NAME=custom\n');
  assert.deepEqual(await initFiles(dir), { created: [join(dir, 'mediamtx.yml')], skipped: [join(dir, '.env')] });
  assert.equal(await readFile(join(dir, '.env'), 'utf8'), 'CAMERA_NAME=custom\n');
  assert.equal(await readFile(join(dir, 'mediamtx.yml'), 'utf8'), await template('mediamtx.yml'));

  await rm(join(dir, '.env'));
  assert.deepEqual(await initFiles(dir), { created: [join(dir, '.env')], skipped: [join(dir, 'mediamtx.yml')] });
  assert.equal(await readFile(join(dir, '.env'), 'utf8'), await template('.env.example'));
});
