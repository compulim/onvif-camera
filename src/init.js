import { constants } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const exampleUrl = new URL('../.env.example', import.meta.url);

async function initEnv(cwd = process.cwd()) {
  const target = resolve(cwd, '.env');
  try {
    await copyFile(exampleUrl, target, constants.COPYFILE_EXCL);
  } catch (error) {
    if (error.code === 'EEXIST') throw new Error(`${target} already exists; not overwriting.`);
    throw error;
  }
  return target;
}

export { initEnv };
