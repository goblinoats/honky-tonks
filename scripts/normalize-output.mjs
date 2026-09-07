import { cp, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { root } from './catalog.mjs';
const { basePath } = JSON.parse(await readFile(path.join(root, 'generated/catalog.json'), 'utf8'));
if (basePath) {
  // Vinext exports a base-path directory. GitHub Pages already mounts the
  // artifact at that path, so publish its contents rather than nesting it twice.
  const output = path.join(root, 'dist/client');
  const nested = path.join(output, basePath.slice(1));
  const stage = await mkdtemp(path.join(root, 'dist/.static-'));
  await cp(nested, stage, { recursive: true });
  await cp(path.join(output, '404.html'), path.join(stage, '404.html'));
  await mkdir(path.join(stage, '404'), { recursive: true });
  await cp(path.join(output, '404.html'), path.join(stage, '404/index.html'));
  await rm(output, { recursive: true, force: true });
  await rename(stage, output);
  console.log('Normalized static artifact for ' + basePath);
}

