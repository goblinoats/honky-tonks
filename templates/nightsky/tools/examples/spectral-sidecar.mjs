// Lossless prepared visual analysis. Never contains audio PCM or credentials.
import { getSpectralTimelineState, restoreSpectralTimeline } from './spectral-timeline.mjs';
import { getSpectralMotifState, restoreSpectralMotifs } from './spectral-motifs.mjs';

const spectralSidecarLimit = 32 * 1024 * 1024;
const spectralSidecarHeaderLimit = 256 * 1024;
const spectralSidecarLittleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
const spectralSidecarMagic = [78, 83, 83, 75, 89, 48, 48, 49]; // NSSKY001
const spectralSidecarChannels = ['sub', 'bass', 'lowMid', 'mid', 'highMid', 'air', 'subBass', 'bassLowMid', 'lowMidMid', 'midHighMid', 'highMidAir'];
const spectralSidecarGridFields = { levels: ['f32', 11], integrals: ['f64', 11], motion: ['f32', 11], motionIntegrals: ['f64', 11], surges: ['f32', 3], textures: ['f32', 3], textureIntegrals: ['f64', 3], harmonics: ['f32', 3], percussives: ['f32', 3], afterglows: ['f32', 3] };

function spectralSidecarAbort(signal) {
  if (signal?.aborted) { const error = new Error('Prepared spectral analysis aborted.'); error.name = 'AbortError'; throw error; }
}
function spectralSidecarAlign(value) { return Math.ceil(value / 8) * 8; }
function spectralSidecarFail(message) { throw new TypeError(`Invalid prepared spectral analysis: ${message}.`); }
function spectralSidecarFinite(value, min = 0, max = Infinity) { return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max; }
function spectralSidecarInteger(value, min, max) { return Number.isInteger(value) && value >= min && value <= max; }
function spectralSidecarJSON(value, depth = 0) {
  if (depth > 20) spectralSidecarFail('metadata nesting');
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) spectralSidecarFail('nonfinite metadata'); return; }
  if (!value || typeof value !== 'object' || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype)) spectralSidecarFail('metadata type');
  for (const [key, child] of Object.entries(value)) { if (key === '__proto__' || key === 'constructor' || key === 'prototype') spectralSidecarFail('metadata key'); spectralSidecarJSON(child, depth + 1); }
}
function spectralSidecarIdentity(identity, expected) {
  if (!identity || typeof identity !== 'object' || typeof identity.audioBlob !== 'string' || !identity.audioBlob.length || identity.audioBlob.length > 2048 || !/^[a-f0-9]{64}$/.test(identity.audioSha256) || !/^[a-f0-9]{64}$/.test(identity.algorithmVersion) || !spectralSidecarInteger(identity.sourceSampleRate, 8000, 384000) || !spectralSidecarInteger(identity.sourceFrames, 0, 2764800000) || !spectralSidecarInteger(identity.sourceChannels, 1, 16) || identity.timestampConvention !== 'pcm-seconds-v1') spectralSidecarFail('audio identity');
  if (expected !== undefined) {
    if (!expected || typeof expected !== 'object' || !['audioBlob', 'audioSha256', 'algorithmVersion'].every(key => typeof expected[key] === 'string' && expected[key])) spectralSidecarFail('expected audio identity is required');
    for (const key of ['audioBlob', 'audioSha256', 'algorithmVersion', 'sourceSampleRate', 'sourceFrames', 'sourceChannels', 'timestampConvention']) if (expected[key] !== undefined && expected[key] !== identity[key]) spectralSidecarFail(`identity mismatch (${key})`);
  }
}
async function spectralSidecarDigest(bytes) {
  if (!globalThis.crypto?.subtle) throw new Error('Prepared analysis requires SHA-256 support in a secure context.');
  return new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', bytes));
}
function spectralSidecarBytes(input) {
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input) && !(input instanceof DataView)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  spectralSidecarFail('binary input');
}
function spectralSidecarWriteArray(target, offset, array, type) {
  const size = type === 'f32' ? 4 : 8;
  const raw = spectralSidecarLittleEndian ? new Uint8Array(array.buffer, array.byteOffset, array.byteLength) : new Uint8Array(array.byteLength);
  if (!spectralSidecarLittleEndian) {
    const view = new DataView(raw.buffer);
    for (let index = 0; index < array.length; index++) view[type === 'f32' ? 'setFloat32' : 'setFloat64'](index * size, array[index], true);
  }
  // Byte-plane transposition is reversible bit for bit. Grouping similar
  // exponent/high-order bytes improves gzip without quantizing any feature.
  for (let byte = 0; byte < size; byte++) for (let index = 0; index < array.length; index++) target[offset + byte * array.length + index] = raw[index * size + byte];
}
function spectralSidecarReadArray(bytes, offset, length, type, encoding) {
  const Type = type === 'f32' ? Float32Array : Float64Array;
  if (encoding === 'byte-plane-le-v1') {
    const array = new Type(length), raw = new Uint8Array(array.buffer), size = Type.BYTES_PER_ELEMENT;
    for (let byte = 0; byte < size; byte++) for (let index = 0; index < length; index++) raw[index * size + byte] = bytes[offset + byte * length + index];
    if (!spectralSidecarLittleEndian) { const view = new DataView(raw.buffer); for (let index = 0; index < length; index++) array[index] = view[type === 'f32' ? 'getFloat32' : 'getFloat64'](index * size, true); }
    return array;
  }
  if (spectralSidecarLittleEndian) return new Type(bytes.buffer, bytes.byteOffset + offset, length).slice();
  const result = new Type(length), view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), size = Type.BYTES_PER_ELEMENT;
  for (let index = 0; index < length; index++) result[index] = view[type === 'f32' ? 'getFloat32' : 'getFloat64'](offset + index * size, true);
  return result;
}

// identity binds the original encoded audio rendition, its canonical decoded
// PCM rate/length, and the source-derived algorithm fingerprint. It does not bind
// the browser's AudioContext rate: resampling still uses canonical track seconds.
export async function serializeSpectralTimeline(timeline, identity, { signal } = {}) {
  spectralSidecarAbort(signal); spectralSidecarIdentity(identity); spectralSidecarJSON(identity);
  const state = getSpectralTimelineState(timeline);
  if (!state) throw new TypeError('Serialize a timeline created or hydrated by these spectral modules.');
  const motif = state.motifs ? getSpectralMotifState(state.motifs) : null;
  if (state.motifs && !motif) throw new TypeError('Prepared timelines require serializable spectral motifs.');
  const sections = [], arrays = {}, add = (name, array, type) => {
    const offset = sections.length ? spectralSidecarAlign(sections.at(-1).offset + sections.at(-1).array.byteLength) : 0;
    arrays[name] = { type, length: array.length, offset }; sections.push({ name, array, type, offset }); return name;
  };
  const saved = { duration: state.duration, step: state.step, frames: state.frames, count: state.count, channels: state.channels, metadata: state.metadata, bassFrames: state.bassFrames, bassStep: state.bassStep, bassBands: state.bassBands };
  for (const [key, [type]] of Object.entries(spectralSidecarGridFields)) saved[key] = add(key, state[key], type);
  saved.bassValues = add('bassValues', state.bassValues, 'f32');
  saved.eventTables = state.eventTables.map((table, family) => {
    const record = { release: table.release };
    for (const key of ['times', 'amplitudes', 'values', 'integrals']) record[key] = add(`event.${family}.${key}`, table[key], key === 'amplitudes' ? 'f32' : 'f64');
    return record;
  });
  let savedMotif = null;
  if (motif) {
    savedMotif = { duration: motif.duration, step: motif.step, frames: motif.frames, components: motif.components, channels: motif.channels, centers: [...motif.centers], bases: motif.bases.map(row => [...row]), metadata: motif.metadata, values: add('motif.values', motif.values, 'f32'), integrals: add('motif.integrals', motif.integrals, 'f64') };
  }
  const manifest = { format: 'nightsky-spectral', version: 1, arrayEncoding: 'byte-plane-le-v1', identity: { ...identity }, timeline: saved, motif: savedMotif, arrays };
  spectralSidecarJSON(manifest);
  const header = new TextEncoder().encode(JSON.stringify(manifest));
  if (header.length > spectralSidecarHeaderLimit) spectralSidecarFail('oversized metadata');
  const dataOffset = 64 + spectralSidecarAlign(header.length), last = sections.at(-1), total = dataOffset + last.offset + last.array.byteLength;
  if (total > spectralSidecarLimit) spectralSidecarFail('sidecar exceeds 32 MiB');
  const bytes = new Uint8Array(total), view = new DataView(bytes.buffer);
  bytes.set(spectralSidecarMagic); view.setUint32(8, 1, true); view.setUint32(12, header.length, true); view.setUint32(16, total, true); bytes.set(header, 64);
  for (const section of sections) { spectralSidecarAbort(signal); spectralSidecarWriteArray(bytes, dataOffset + section.offset, section.array, section.type); }
  bytes.set(await spectralSidecarDigest(bytes.subarray(64)), 24); spectralSidecarAbort(signal);
  // The same validator guards exports, so unsupported custom state cannot create
  // a sidecar that the browser later accepts differently.
  await spectralSidecarParse(bytes, identity, signal, false);
  return bytes;
}

export async function hydrateSpectralTimeline(input, expected, { signal } = {}) {
  spectralSidecarAbort(signal);
  if (!expected) spectralSidecarFail('expected audio identity is required');
  const bytes = spectralSidecarBytes(input);
  if (bytes.byteLength > spectralSidecarLimit) spectralSidecarFail('sidecar exceeds 32 MiB');
  // Detach from mutable network/cache buffers before the asynchronous hash check.
  const parsed = await spectralSidecarParse(bytes.slice(), expected, signal, true);
  const motifs = parsed.motif ? restoreSpectralMotifs(parsed.motif) : null;
  spectralSidecarAbort(signal);
  return restoreSpectralTimeline(parsed.timeline, { motifs, prepared: parsed.identity });
}

async function spectralSidecarParse(bytes, expected, signal, verifyDigest) {
  if (bytes.length < 64 || bytes.length > spectralSidecarLimit || spectralSidecarMagic.some((value, index) => bytes[index] !== value)) spectralSidecarFail('magic or size');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), headerLength = view.getUint32(12, true);
  if (view.getUint32(8, true) !== 1 || view.getUint32(16, true) !== bytes.length || view.getUint32(20, true) !== 0 || bytes.subarray(56, 64).some(value => value !== 0)) spectralSidecarFail('version or envelope');
  const dataOffset = 64 + spectralSidecarAlign(headerLength);
  if (!headerLength || headerLength > spectralSidecarHeaderLimit || dataOffset > bytes.length) spectralSidecarFail('header bounds');
  if (verifyDigest) { const digest = await spectralSidecarDigest(bytes.subarray(64)); spectralSidecarAbort(signal); if (digest.some((value, index) => value !== bytes[index + 24])) spectralSidecarFail('checksum'); }
  let manifest;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(64, 64 + headerLength))); } catch { spectralSidecarFail('JSON header'); }
  spectralSidecarJSON(manifest);
  if (manifest.format !== 'nightsky-spectral' || manifest.version !== 1) spectralSidecarFail('manifest version');
  const encoding = manifest.arrayEncoding ?? 'little-endian';
  if (!['little-endian', 'byte-plane-le-v1'].includes(encoding)) spectralSidecarFail('array encoding');
  spectralSidecarIdentity(manifest.identity, expected);
  const state = manifest.timeline, motif = manifest.motif, arrays = manifest.arrays;
  if (!state || !arrays || typeof arrays !== 'object' || Array.isArray(arrays) || !spectralSidecarInteger(state.frames, 1, 144001) || state.count !== 11 || JSON.stringify(state.channels) !== JSON.stringify(spectralSidecarChannels) || !spectralSidecarFinite(state.duration, 0, 7200) || !spectralSidecarFinite(state.step, Number.MIN_VALUE, 1) || !spectralSidecarInteger(state.bassFrames, 1, 108001) || !spectralSidecarFinite(state.bassStep, Number.MIN_VALUE, 1) || JSON.stringify(state.bassBands) !== '[0,1,6,7]') spectralSidecarFail('timeline dimensions');
  const duration = manifest.identity.sourceFrames / manifest.identity.sourceSampleRate;
  if (Math.abs(state.duration - duration) > 1e-9 || (state.frames === 1 && duration !== 0) || (state.bassFrames === 1 && duration !== 0) || (state.frames > 1 && Math.abs(state.step * (state.frames - 1) - duration) > 1e-8) || (state.bassFrames > 1 && Math.abs(state.bassStep * (state.bassFrames - 1) - duration) > 1e-8)) spectralSidecarFail('PCM time grid');
  if (state.metadata?.version !== 2 || state.metadata?.algorithm !== 'stable-family-onsets-hpss-bass-v1' || state.metadata.sampleRate !== manifest.identity.sourceSampleRate) spectralSidecarFail('analysis metadata');
  if (state.metadata.framesPerSecond !== 1 / state.step || state.metadata.bass?.frames !== state.bassFrames || state.metadata.bass?.step !== state.bassStep || JSON.stringify(state.metadata.bass?.families) !== '[0,1,6,7]') spectralSidecarFail('analysis grid metadata');
  if (!Array.isArray(state.eventTables) || state.eventTables.length !== 11 || !Array.isArray(state.metadata.onsets?.counts) || state.metadata.onsets.counts.length !== 11) spectralSidecarFail('event families');
  const used = new Set(), entries = Object.entries(arrays);
  if (entries.length > 64) spectralSidecarFail('array count');
  let end = 0;
  for (const [name, spec] of entries) {
    if (!spec || !['f32', 'f64'].includes(spec.type) || !spectralSidecarInteger(spec.length, 0, spectralSidecarLimit / 4) || spec.offset !== spectralSidecarAlign(end)) spectralSidecarFail('array layout');
    const size = spec.type === 'f32' ? 4 : 8; end = spec.offset + spec.length * size;
    if (!Number.isSafeInteger(end) || dataOffset + end > bytes.length) spectralSidecarFail('array bounds');
  }
  if (dataOffset + end !== bytes.length) spectralSidecarFail('trailing data');
  const take = (reference, type, length, max = 1) => {
    const spec = arrays[reference];
    if (typeof reference !== 'string' || used.has(reference) || !Object.hasOwn(arrays, reference) || !spec || spec.type !== type || spec.length !== length) spectralSidecarFail('array reference');
    used.add(reference); spectralSidecarAbort(signal);
    const array = spectralSidecarReadArray(bytes, dataOffset + spec.offset, length, type, encoding);
    for (const value of array) if (!spectralSidecarFinite(value, 0, max)) spectralSidecarFail(`nonfinite or out-of-range ${reference}`);
    return array;
  };
  for (const [key, [type, width]] of Object.entries(spectralSidecarGridFields)) state[key] = take(state[key], type, state.frames * width, type === 'f64' ? state.duration + 1 : 1);
  state.bassValues = take(state.bassValues, 'f32', state.bassFrames * 4);
  for (const [values, integrals, width] of [[state.levels, state.integrals, 11], [state.motion, state.motionIntegrals, 11], [state.textures, state.textureIntegrals, 3]]) spectralSidecarPrefixes(values, integrals, state.frames, width, state.step);
  for (let family = 0; family < 11; family++) {
    const table = state.eventTables[family], count = state.metadata.onsets.counts[family];
    if (!table || !spectralSidecarInteger(count, 0, Math.ceil(state.duration / .039) + 2) || !spectralSidecarFinite(table.release, .01, 10)) spectralSidecarFail('onset dimensions');
    table.times = take(table.times, 'f64', count, state.duration); table.amplitudes = take(table.amplitudes, 'f32', count); table.values = take(table.values, 'f64', count); table.integrals = take(table.integrals, 'f64', count, state.duration + 1);
    for (let index = 0; index < count; index++) {
      if (index && table.times[index] <= table.times[index - 1]) spectralSidecarFail('onset order');
      const elapsed = index ? table.times[index] - table.times[index - 1] : 0, previous = index ? table.values[index - 1] : 0;
      const prefix = index ? table.integrals[index - 1] + previous * table.release * -Math.expm1(-elapsed / table.release) : 0;
      const value = Math.min(1, previous * Math.exp(-elapsed / table.release) + table.amplitudes[index]);
      // Cross-engine transcendentals need a very small validation tolerance;
      // stored values are never recomputed, preserving producer sampler state.
      if (Math.abs(table.integrals[index] - prefix) > 1e-10 || Math.abs(table.values[index] - value) > 1e-12) spectralSidecarFail('onset integral consistency');
    }
  }
  if (motif !== null) {
    if (!motif || !spectralSidecarInteger(motif.frames, 1, 57601) || motif.components !== 4 || motif.channels !== 32 || motif.duration !== state.duration || !spectralSidecarFinite(motif.step, Number.MIN_VALUE, 1) || (motif.frames > 1 && Math.abs(motif.step * (motif.frames - 1) - state.duration) > 1e-8) || !Array.isArray(motif.centers) || motif.centers.length !== 32 || !Array.isArray(motif.bases) || motif.bases.length !== 4 || !motif.metadata) spectralSidecarFail('motif dimensions');
    for (let index = 0; index < 32; index++) if (!spectralSidecarFinite(motif.centers[index], 1, 192000) || (index && motif.centers[index] <= motif.centers[index - 1])) spectralSidecarFail('motif frequency order');
    for (const row of motif.bases) if (!Array.isArray(row) || row.length !== 32 || row.some(value => !spectralSidecarFinite(value, 0, 1 + 1e-7))) spectralSidecarFail('motif basis');
    motif.values = take(motif.values, 'f32', motif.frames * 4); motif.integrals = take(motif.integrals, 'f64', motif.frames * 4, state.duration + 1);
    spectralSidecarPrefixes(motif.values, motif.integrals, motif.frames, 4, motif.step);
    if (JSON.stringify(motif.metadata) !== JSON.stringify(state.metadata.motifs)) spectralSidecarFail('motif metadata mismatch');
  } else if (state.metadata.motifs !== null) spectralSidecarFail('missing motifs');
  if (used.size !== entries.length) spectralSidecarFail('unused arrays');
  spectralSidecarAbort(signal);
  return { timeline: state, motif, identity: manifest.identity };
}

function spectralSidecarPrefixes(values, integrals, frames, width, step) {
  for (let channel = 0; channel < width; channel++) {
    if (integrals[channel] !== 0) spectralSidecarFail('nonzero initial integral');
    for (let frame = 1; frame < frames; frame++) {
      const index = frame * width + channel, previous = index - width;
      const expected = integrals[previous] + (values[previous] + values[index]) * step / 2;
      if (Math.abs(integrals[index] - expected) > 1e-10) spectralSidecarFail('integral consistency');
    }
  }
}
