// Offline fixture checks; never connects to a Tonk space or uploads a recording.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { computeSpectralVersion } from './examples/build-audio-modules.mjs';

const tools = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(tools), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nightsky-toolkit-test-'));
const run = (args, { env = {}, fail = false } = {}) => {
  const result = spawnSync(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status === 0, !fail, (result.stderr || result.stdout).slice(0, 1000));
  return result;
};
try {
  const core = fs.readFileSync(path.join(root, 'core.yaml'), 'utf8');
  const block = core.split(/(?=^[a-z][a-z0-9./+!-]*!:\s*)/m).find(text => text.startsWith('component!: &nightsky-kit\n'));
  assert.ok(block);
  const kit = block.split('  module: |\n')[1].split('\n').map(line => line.startsWith('    ') ? line.slice(4) : line).join('\n').trimEnd() + '\n';
  const original = path.join(temp, 'kit.js'), rebuilt = path.join(temp, 'kit-rebuilt.js');
  fs.writeFileSync(original, kit);
  run(['tools/examples/build-audio-modules.mjs', original, rebuilt]);
  assert.equal(fs.readFileSync(rebuilt, 'utf8'), kit, 'Unchanged public build must be byte-identical');
  assert.ok(!/(?:globalThis|window|view)\.Song\b/.test(kit));
  const version = computeSpectralVersion();
  assert.ok(kit.includes(`spectralVersion: '${version}'`));
  run(['--check', rebuilt]);
  console.log('PASS exact public kit rebuild, namespacing and source fingerprint');

  const fake = path.join(temp, 'fake-tonk'), stateFile = path.join(temp, 'state.json');
  fs.writeFileSync(fake, `#!/usr/bin/env node\nconst fs=require('node:fs');const args=process.argv.slice(2);const state=JSON.parse(fs.readFileSync(process.env.NIGHTSKY_TEST_STATE,'utf8'));if(args.includes('query'))process.stdout.write(JSON.stringify(state.components));else if(args.includes('eval')&&args.includes('--dry-run'))process.stdout.write(JSON.stringify({matches_before:[{label:'name',results:state.names.map(row=>({this:row.this,fields:{entity:row.entity}}))}],commits:{claims:0,entities:{}}}));else process.exit(88);\n`, { mode: 0o700 });
  const env = { TONK_BIN: fake, NIGHTSKY_TEST_STATE: stateFile };
  const name = 'nightsky-test-visual', entity = 'did:key:zTestComponent';
  const module = `customElements.define('${name}', class extends HTMLElement {});\n`;
  const state = { names: [{ this: 'id:' + name, entity }], components: [{ this: entity, module }] };
  const writeState = () => fs.writeFileSync(stateFile, JSON.stringify(state));
  writeState();
  const prefix = path.join(temp, 'visual'), snapshot = prefix + '.snapshot.json';
  const exportArgs = ['tools/component.mjs', 'export', '--space', 'test-space', '--name', name, '--out', prefix];
  run(exportArgs, { env });
  assert.equal(fs.readFileSync(prefix + '.js', 'utf8'), module);
  run(exportArgs, { env, fail: true });
  const plan = path.join(temp, 'change.notation');
  const planArgs = ['tools/component.mjs', 'plan', '--space', 'test-space', '--snapshot', snapshot, '--source', prefix + '.js', '--out', plan];
  run(planArgs, { env, fail: true }); // unchanged
  fs.writeFileSync(prefix + '.js', module + '// Changed visual.\n');
  state.names[0].entity = 'did:key:zOther'; writeState();
  run(planArgs, { env, fail: true });
  state.names[0].entity = entity; state.components[0].module = module + '// Other editor.\n'; writeState();
  run(planArgs, { env, fail: true });
  state.components[0].module = module; writeState();
  run(planArgs, { env });
  const text = fs.readFileSync(plan, 'utf8');
  assert.ok(text.includes(`this: id:${name}\n  entity: ${entity}`));
  assert.ok(text.includes('module: ' + JSON.stringify(module)));
  assert.ok(text.includes(`component!: &${name}`));
  assert.ok(text.endsWith('component!:\n  this: ?previous\n  module: _\n'));
  assert.ok(!text.includes('space:home'));
  console.log('PASS export preservation and unchanged/stale-alias/stale-source plan rejection');

  const wav = Buffer.alloc(44 + 16000 * 2);
  wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22); wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
  for (let index = 0; index < 16000; index++) wav.writeInt16LE(Math.round(6000 * Math.sin(2 * Math.PI * 220 * index / 8000) * (index % 4000 < 400 ? 1 : .15)), 44 + index * 2);
  const audio = path.join(temp, 'synthetic.wav'), output = path.join(temp, 'synthetic-analysis');
  fs.writeFileSync(audio, wav);
  run(['tools/scripts/prepare-analysis.mjs', '--input', audio, '--output', output, '--audio-blob', 'blob:TestToneFixture']);
  const manifest = JSON.parse(fs.readFileSync(output + '.manifest.json', 'utf8'));
  assert.equal(manifest.identity.algorithmVersion, version);
  assert.equal(manifest.identity.timestampConvention, 'pcm-seconds-v1');
  assert.equal(manifest.verification.exactSampleParity, true);
  assert.ok(manifest.verification.samples > 2048);
  assert.equal(manifest.identity.sourceFrames, 16000);
  console.log('PASS synthetic-audio decoding, lossless sidecar and matching runtime identity (no upload)');
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
