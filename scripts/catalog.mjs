import { readdir, readFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseDocument } from 'yaml';

export const root = path.resolve(import.meta.dirname, '..');

// Detail pages inline required notation only. Optional media can contain megabytes
// of base64: retain its metadata, but keep those bytes in the downloadable files.
export function pageCatalog(templates) {
  return templates.map(t => ({
    ...t,
    files: t.files.map(f => ({ ...f, source: f.optional ? '' : f.source })),
  }));
}

const fail = message => { throw new Error(message); };
const text = (value, label, max = 12000) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) fail(`${label}: expected non-empty text (max ${max})`);
};
const list = (value, label) => {
  if (!Array.isArray(value) || !value.length) fail(`${label}: expected a non-empty list`);
};
const url = (value, label, contact = false) => {
  if (value === null) return;
  text(value, label, 1000);
  let parsed;
  try { parsed = new URL(value); } catch { fail(`${label}: invalid URL`); }
  if (!['https:', ...(contact ? ['mailto:'] : [])].includes(parsed.protocol) || parsed.username || parsed.password) fail(`${label}: use HTTPS${contact ? ' or mailto' : ''}`);
};
export async function localFile(directory, file, extensions) {
  text(file, 'file', 180);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(file) || file.split('/').some(p => p === '.' || p === '..' || !p) || !extensions.includes(path.extname(file).toLowerCase())) fail(`Invalid file path: ${file}`);
  const full = path.resolve(directory, file);
  const real = await realpath(full);
  if (!real.startsWith(await realpath(directory) + path.sep) || (await lstat(full)).isSymbolicLink()) fail(`File escapes its template folder: ${file}`);
  const stat = await lstat(full);
  if (!stat.isFile() || !stat.size || stat.size > 8 * 1024 * 1024) fail(`File must be non-empty and under 8 MB: ${file}`);
  return readFile(full);
}
export async function loadCatalog(templatesDir = path.join(root, 'templates')) {
  const entries = (await readdir(templatesDir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  const templates = [];
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    if (!entry.isDirectory() || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(entry.name)) fail(`Invalid template directory: ${entry.name}`);
    const dir = path.join(templatesDir, entry.name);
    const manifest = await localFile(dir, 'template.yaml', ['.yaml']);
    const doc = parseDocument(manifest.toString(), { uniqueKeys: true, strict: true });
    if (doc.errors.length) fail(`${entry.name}: ${doc.errors.map(e => e.message).join('; ')}`);
    const t = doc.toJS({ maxAliasCount: 0 });
    if (!t || typeof t !== 'object' || Array.isArray(t)) fail(`${entry.name}: expected a manifest object`);
    const allowed = ['schemaVersion','slug','name','summary','description','category','version','license','author','features','images','files','entrypoint','compatibility','notes'];
    for (const key of Object.keys(t)) if (!allowed.includes(key)) fail(`${entry.name}: unknown field ${key}`);
    if (t.schemaVersion !== 1 || t.slug !== entry.name) fail(`${entry.name}: schemaVersion must be 1 and slug must match directory`);
    for (const key of ['name','summary','description','category','version','license','entrypoint','compatibility','notes']) text(t[key], `${entry.name}.${key}`, key === 'summary' ? 240 : 12000);
    if (!/^\d+\.\d+\.\d+$/.test(t.version)) fail(`${entry.name}: version must be x.y.z`);
    if (!/^[a-z][a-z0-9.+-]*(?:\/[a-z][a-z0-9.+-]*)?$/.test(t.entrypoint)) fail(`${entry.name}: invalid entrypoint concept`);
    if (!t.author || typeof t.author !== 'object') fail(`${entry.name}: author required`);
    text(t.author.name, 'author.name', 120);
    url(t.author.url, 'author.url');
    url(t.author.contact, 'author.contact', true);
    list(t.features, 'features'); t.features.forEach(f => text(f, 'feature', 300));
    list(t.images, 'images');
    for (const img of t.images) {
      text(img.alt, 'image.alt', 400); text(img.caption, 'image.caption', 600);
      const bytes = await localFile(dir, img.file, ['.png','.jpg','.jpeg','.webp','.svg']);
      // SVG is a passive image format here, never embedded as live markup.
      if (img.file.toLowerCase().endsWith('.svg')) {
        const svg = bytes.toString();
        const allowedTags = new Set(['svg','g','rect','text','tspan','path','line','polyline','polygon','circle','ellipse','title','desc']);
        const tags = [...svg.matchAll(/<\/?\s*([a-zA-Z][\w:.-]*)/g)];
        if (!tags.length || tags.some(m => !allowedTags.has(m[1])) || /<\s*[!?]|\bon[a-z]+\s*=|\b(?:href|src|style)\s*=|url\s*\(/i.test(svg)) fail(`SVG must be self-contained and passive: ${img.file}`);
      }
    }
    list(t.files, 'files');
    const seen = new Set();
    for (const file of t.files) {
      text(file.description, 'file.description', 400);
      if (file.optional !== undefined && typeof file.optional !== 'boolean') fail('file.optional must be boolean');
      if (seen.has(file.file) || file.file === 'template.yaml') fail(`Duplicate or reserved source: ${file.file}`);
      seen.add(file.file);
      const bytes = await localFile(dir, file.file, ['.yaml','.yml']);
      file.sha256 = createHash('sha256').update(bytes).digest('hex');
      file.bytes = bytes.length;
      file.source = bytes.toString('utf8');
    }
    if (!t.files.some(f => !f.optional)) fail(`${entry.name}: requires at least one non-optional source`);
    templates.push(t);
  }
  if (!templates.length) fail('The collection must have at least one template');
  return templates;
}
