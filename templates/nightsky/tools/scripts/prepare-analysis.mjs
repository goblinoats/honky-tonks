#!/usr/bin/env node
// Offline-only: never uploads media, modifies Tonk, or changes playback.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gzipSync, gunzipSync } from 'node:zlib';
import assert from 'node:assert/strict';
import { createSpectralTimeline } from '../examples/spectral-timeline.mjs';
import { createSpectralMotifs } from '../examples/spectral-motifs.mjs';

const execute = promisify(execFile), args = process.argv.slice(2);
const usage = 'node scripts/prepare-analysis.mjs --input media/song.flac --output /tmp/song-analysis --audio-blob blob:ID';
const options = {};
for (let i = 0; i < args.length; i += 2) {
  if (!['--input', '--output', '--audio-blob'].includes(args[i]) || !args[i + 1] || options[args[i]]) throw new Error(usage);
  options[args[i]] = args[i + 1];
}
if (Object.keys(options).length !== 3 || !/^blob:[A-Za-z0-9]+$/.test(options['--audio-blob'])) throw new Error(usage);
const input = path.resolve(options['--input']), output = path.resolve(options['--output']);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fileHash = async file => { const h = createHash('sha256'); for await (const chunk of createReadStream(file)) h.update(chunk); return h.digest('hex'); };
const started = performance.now(), temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'nightsky-precompute-'));
let memoryPeak = process.memoryUsage();
const memory = () => { for (const [key, value] of Object.entries(process.memoryUsage())) memoryPeak[key] = Math.max(memoryPeak[key], value); };
const timer = setInterval(memory, 100);
try {
  for (const filename of [output + '.gz', output + '.manifest.json']) {
    try { await fs.access(filename); throw new Error('Output already exists: ' + filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const { stdout } = await execute('ffprobe', ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,channels,duration', '-of', 'json', input], { timeout: 15000, maxBuffer: 1024 * 1024 });
  const stream = JSON.parse(stdout).streams?.[0], sampleRate = Number(stream?.sample_rate), channels = Number(stream?.channels);
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 384000 || !Number.isInteger(channels) || channels < 1 || channels > 16 || (Number(stream.duration) > 7200)) throw new Error('Unsupported or oversized audio stream');
  const audioSha256 = await fileHash(input), pcmFile = path.join(temporary, 'audio.f32');
  const decodeStart = performance.now();
  await execute('ffmpeg', ['-v', 'error', '-nostdin', '-y', '-i', input, '-map', '0:a:0', '-vn', '-t', '7201', '-fs', '536870916', '-f', 'f32le', '-acodec', 'pcm_f32le', pcmFile], { timeout: 120000, maxBuffer: 1024 * 1024 });
  const pcmBytes = (await fs.stat(pcmFile)).size, stride = channels * 4, frames = pcmBytes / stride;
  if (!Number.isInteger(frames) || frames < 1 || frames / sampleRate > 7200 || pcmBytes > 512 * 1024 * 1024) throw new Error('Decoded PCM exceeds offline budget');
  const pcm = Array.from({ length: channels }, () => new Float32Array(frames));
  const handle = await fs.open(pcmFile, 'r'), chunk = Buffer.alloc(stride * 16384);
  try {
    for (let offset = 0, frame = 0; offset < pcmBytes;) {
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, pcmBytes - offset), offset);
      if (!bytesRead || bytesRead % stride) throw new Error('Truncated PCM');
      for (let byte = 0; byte < bytesRead; byte += stride, frame++) for (let c = 0; c < channels; c++) pcm[c][frame] = chunk.readFloatLE(byte + 4 * c);
      offset += bytesRead;
    }
  } finally { await handle.close(); }
  const decodeMs = performance.now() - decodeStart;
  const source = { sampleRate, length: frames, numberOfChannels: channels, duration: frames / sampleRate, getChannelData: c => pcm[c] };
  const analysisStart = performance.now();
  const timeline = await createSpectralTimeline(source, { motifFactory: createSpectralMotifs, signal: AbortSignal.timeout(300000) });
  const analysisMs = performance.now() - analysisStart;
  // Codec integration below is intentionally lossless: parity must pass before writing artifacts.
  const codec = await import('../examples/spectral-sidecar.mjs');
  const { computeSpectralVersion } = await import('../examples/build-audio-modules.mjs');
  const identity = { audioBlob: options['--audio-blob'], audioSha256, algorithmVersion: await computeSpectralVersion(), sourceSampleRate: sampleRate, sourceFrames: frames, sourceChannels: channels, timestampConvention: 'pcm-seconds-v1' };
  const encoded = await codec.serializeSpectralTimeline(timeline, identity);
  const bytes = typeof encoded === 'string' ? Buffer.from(encoded) : Buffer.from(encoded);
  const compressed = gzipSync(bytes, { level: 9 });
  assert.equal(hash(gunzipSync(compressed)), hash(bytes));
  const restored = await codec.hydrateSpectralTimeline(bytes, identity);
  const times = [0, timeline.duration, -1, Infinity];
  for (const table of timeline.events) for (const t of table.times) times.push(t - 1 / sampleRate, t, t + 1 / sampleRate);
  let seed = 0x51a7;
  for (let i = 0; i < 2048; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; times.push(seed / 2 ** 32 * timeline.duration); }
  let a = {}, b = {}, valuesChecked = 0;
  for (const t of times) {
    a = timeline.sample(t, a); b = restored.sample(t, b);
    assert.deepEqual(Object.keys(b), Object.keys(a));
    for (const key of Object.keys(a)) { assert.deepEqual(b[key], a[key], `Sample mismatch ${key} at ${t}`); valuesChecked += ArrayBuffer.isView(a[key]) ? a[key].length : 1; }
  }
  memory();
  const sourceHashes = {};
  for (const name of ['spectral-timeline.mjs', 'spectral-motifs.mjs', 'spectral-sidecar.mjs']) sourceHashes[name] = await fileHash(new URL('../examples/' + name, import.meta.url));
  const manifest = { sourceHashes, formatVersion: 1, created: new Date().toISOString(), identity, algorithm: timeline.metadata.algorithm, algorithmVersion: identity.algorithmVersion, featureMetadataVersion: timeline.metadata.version, duration: timeline.duration, timestampConvention: 'Seconds from decoded source PCM frame zero; event timestamps use source sample rate. No output-latency correction is baked in.', uncompressed: { sha256: hash(bytes), bytes: bytes.length }, gzip: { sha256: hash(compressed), bytes: compressed.length }, verification: { exactSampleParity: true, samples: times.length, valuesChecked, eventBoundaryOffsets: [-1 / sampleRate, 0, 1 / sampleRate], randomSeekCount: 2048, gzipRoundTrip: true }, timings: { decodeMs, analysisMs, totalMs: performance.now() - started }, analysisTimings: timeline.metadata.timings, processMemoryPeakObserved: memoryPeak, caveats: ['Parity is codec round-trip of the same native-rate PCM analysis, not equivalence between ffmpeg and browser resampling.', 'RSS observations include Node, PCM and validation; these are offline generation costs, not browser startup measurements.'] };
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.writeFile(output + '.gz', compressed, { flag: 'wx' });
  await fs.writeFile(output + '.manifest.json', JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify({ output: output + '.gz', manifest: output + '.manifest.json', bytes: compressed.length, samplesChecked: times.length, analysisMs }));
} finally { clearInterval(timer); await fs.rm(temporary, { recursive: true, force: true }); }
