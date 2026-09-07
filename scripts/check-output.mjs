import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { root } from './catalog.mjs';
const output = path.join(root, 'dist/client');
const generated = JSON.parse(await readFile(path.join(root, 'generated/catalog.json'), 'utf8'));
const base = generated.basePath;
const catalog = JSON.parse(await readFile(path.join(output, 'catalog.json'), 'utf8'));
const exists = async p => { try { return await stat(p); } catch { return null; } };
async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const result = [];
  for (const e of entries) {
    if (e.isDirectory()) result.push(...await walk(path.join(dir, e.name)));
    else if (e.name.endsWith('.html')) result.push(path.join(dir, e.name));
  }
  return result;
}
const htmlFiles = await walk(output);
for (const file of htmlFiles) {
  const html = await readFile(file, 'utf8');
  for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    const href = match[1].replaceAll('&amp;', '&');
    if (/^(?:[a-z]+:|\/\/|#)/i.test(href)) continue;
    const relativePage = path.relative(output, file).split(path.sep).join('/');
    const url = new URL(href, `https://local.test${base}/${relativePage}`);
    if (base && !url.pathname.startsWith(base + '/')) throw new Error(`Link lost base path: ${file} -> ${href}`);
    let target = path.join(output, decodeURIComponent(url.pathname.slice(base.length)));
    const s = await exists(target);
    if (s?.isDirectory()) target = path.join(target, 'index.html');
    if (!await exists(target)) throw new Error(`Broken static link: ${file} -> ${href}`);
  }
}
for (const t of catalog.templates) {
  const html = await readFile(path.join(output, 'templates', t.slug, 'index.html'), 'utf8');
  if (!html.includes(t.name) || !html.includes('Get the YAML')) throw new Error(`Missing prerendered template: ${t.slug}`);
  for (const f of t.files) {
    const bytes = await readFile(path.join(output, 'content', t.slug, f.file));
    if (createHash('sha256').update(bytes).digest('hex') !== f.sha256) throw new Error(`Checksum mismatch: ${t.slug}/${f.file}`);
  }
}
if (!htmlFiles.length) throw new Error('No static HTML exported');
console.log(`Verified ${htmlFiles.length} static HTML files, local links, template content, and source checksums.`);

