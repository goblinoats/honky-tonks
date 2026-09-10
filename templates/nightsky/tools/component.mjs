#!/usr/bin/env node
// Read-only Tonk access. Export source or prepare an exact guarded transaction.
// This tool never commits, pushes, retracts, or changes the selected space.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const [operation, ...args] = process.argv.slice(2);
const usage = 'node tools/component.mjs export --space SPACE --name nightsky-sky --out sky\nnode tools/component.mjs plan --space SPACE --snapshot sky.snapshot.json --source sky.js --out change.notation';
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--space', '--name', '--out', '--snapshot', '--source'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error(usage);
  options[args[i]] = args[i + 1];
}
const allowed = operation === 'export' ? ['--space', '--name', '--out'] : operation === 'plan' ? ['--space', '--snapshot', '--source', '--out'] : [];
if (!allowed.length || Object.keys(options).length !== allowed.length || allowed.some(key => !options[key])) throw new Error(usage);
const cli = process.env.TONK_BIN ? [process.env.TONK_BIN] : ['npx', '--yes', '@tonk/cli@0.6.14'];
const hash = source => createHash('sha256').update(source).digest('hex');
const query = (concept, name) => {
  // `name` is built into notation, but CLI 0.6.14 does not expose it through
  // `query name` in every space. This exact-name query is always a dry run.
  const read = concept === 'name' ? ['eval', '-', '--dry-run', '--json'] : ['query', concept, '--json'];
  const input = concept === 'name' ? `name:\n  this: id:${name}\n  entity: ?entity\n` : undefined;
  const result = spawnSync(cli[0], [...cli.slice(1), '--space', options['--space'], ...read], { input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 120000 });
  if (result.error || result.status !== 0) throw new Error(`Cannot read ${concept}; check the selected space and CLI. No changes made.`);
  const data = JSON.parse(result.stdout);
  const rows = concept === 'name' ? data.matches_before?.filter(match => match.label === 'name').flatMap(match => match.results.map(row => ({ this: row.this, ...row.fields }))) : data;
  if (!Array.isArray(rows)) throw new Error('Unexpected Tonk query format. Use CLI 0.6.14.');
  return rows;
};
function current(name) {
  if (!/^nightsky-[a-z0-9-]+$/.test(name)) throw new Error('Choose an exact namespaced Nightsky component name.');
  const names = query('name', name).filter(row => !row.this || row.this === 'id:' + name);
  if (names.length !== 1 || typeof names[0].entity !== 'string') throw new Error('Component name must resolve exactly once.');
  const rows = query('component');
  const matches = rows.filter(row => row.this === names[0].entity);
  if (matches.length !== 1 || typeof matches[0].module !== 'string') throw new Error('Named entity must contain exactly one component module.');
  const module = matches[0].module;
  const tag = new RegExp(`customElements\\.define\\(['"]${name}['"]`);
  if (!tag.test(module) || rows.filter(row => tag.test(row.module || '')).length !== 1) throw new Error('Duplicate or mismatched component registration. Resolve owned definitions before editing.');
  return { name, entity: matches[0].this, module };
}
function writeFresh(file, content) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(file, content, { flag: 'wx', mode: 0o600 });
}
if (operation === 'export') {
  const data = current(options['--name']);
  const sourceFile = options['--out'] + '.js', snapshotFile = options['--out'] + '.snapshot.json';
  if (fs.existsSync(sourceFile) || fs.existsSync(snapshotFile)) throw new Error('Choose a new output prefix; exports never overwrite files.');
  writeFresh(sourceFile, data.module);
  writeFresh(snapshotFile, JSON.stringify({ format: 1, space: options['--space'], ...data, sha256: hash(data.module) }, null, 2) + '\n');
  console.log(`Exported ${data.name}. Edit ${sourceFile}; keep ${snapshotFile} unchanged.`);
} else {
  const snapshot = JSON.parse(fs.readFileSync(options['--snapshot'], 'utf8'));
  if (snapshot.format !== 1 || snapshot.space !== options['--space'] || typeof snapshot.module !== 'string' || snapshot.sha256 !== hash(snapshot.module)) throw new Error('Snapshot identity or bytes do not match. Re-export from the intended space.');
  const live = current(snapshot.name);
  if (live.entity !== snapshot.entity || live.module !== snapshot.module) throw new Error('Component changed since export. Re-export and merge your edit; no transaction written.');
  const module = fs.readFileSync(options['--source'], 'utf8');
  if (module === live.module) throw new Error('Source is unchanged.');
  if (!new RegExp(`customElements\\.define\\(['"]${snapshot.name}['"]`).test(module)) throw new Error('Keep the same custom element name.');
  if (/(?:globalThis|window|view)\.Song\b/.test(module)) throw new Error('Use the public Nightsky namespace.');
  if (Buffer.byteLength(module) > 2 * 1024 * 1024) throw new Error('Component source exceeds the 2 MiB helper limit; keep media in blobs.');
  // The alias, original entity and exact module form one guard. A concurrent
  // edit after planning causes zero matches at evaluation, not a broad cleanup.
  const transaction = `# Review and dry-run before evaluation. A stale guard must match zero rows.\nname:\n  this: id:${snapshot.name}\n  entity: ${snapshot.entity}\nname:\n  this: id:${snapshot.name}\n  entity: ?previous\ncomponent:\n  this: ?previous\n  module: ${JSON.stringify(snapshot.module)}\ncomponent!: &${snapshot.name}\n  module: ${JSON.stringify(module)}\ncomponent!:\n  this: ?previous\n  module: _\n`;
  writeFresh(options['--out'], transaction);
  console.log(`Wrote ${options['--out']}. Only ${snapshot.name} is targeted. Dry-run, inspect the matched row, then evaluate explicitly.`);
}
