import { constants } from 'node:fs';
import { copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const templates = [
  ['.env.example', '.env'],
  ['mediamtx.yml', 'mediamtx.yml']
];

async function initFiles(cwd = process.cwd()) {
  const created = [];
  const skipped = [];
  for (const [source, name] of templates) {
    const target = resolve(cwd, name);
    try {
      await copyFile(new URL(`../${source}`, import.meta.url), target, constants.COPYFILE_EXCL);
      created.push(target);
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      skipped.push(target);
    }
  }
  return { created, skipped };
}

export { initFiles };
