// A visual frequency bank, not instrument separation or calibrated audio power.
// spectrumFull is Song.Analysis's reused byte/255 spectrum: normalized dB-coded
// analyser levels. sampleRate / fftSize maps each original FFT bin to Hz.
// Usage: const bank = createBandBank(); const off = analysis.use('stars', bank);
// Read features.custom.stars or bank.read(). Copy values when retaining history;
// both paths deliberately return the same reused bands/crossovers objects.
export function createBandBank({ ranges, crossovers, overlapOctaves = .25, attack = .08, release = .4 } = {}) {
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const clamp = value => finite(value) ? Math.max(0, Math.min(1, value)) : 0;
  const validTime = value => finite(value) && value >= 0;
  if (!validTime(attack) || !validTime(release)) throw new RangeError('Attack and release must be finite, nonnegative seconds.');
  if (!finite(overlapOctaves) || overlapOctaves < 0 || overlapOctaves > 2) throw new RangeError('overlapOctaves must be between 0 and 2.');
  const defaults = [
    { name: 'sub', low: 30, high: 60 },
    { name: 'bass', low: 60, high: 250 },
    { name: 'lowMid', low: 250, high: 500 },
    { name: 'mid', low: 500, high: 2000 },
    { name: 'highMid', low: 2000, high: 6000 },
    { name: 'air', low: 6000, high: 16000 },
  ];
  if (ranges === undefined) ranges = defaults;
  if (!Array.isArray(ranges) || !ranges.length) throw new TypeError('Provide at least one named frequency range.');
  const names = new Set();
  const named = name => {
    if (typeof name !== 'string' || !name || names.has(name)) throw new TypeError('Band names must be nonempty and unique.');
    names.add(name); return name;
  };
  ranges = ranges.map(range => {
    if (!range || !finite(range.low) || !finite(range.high) || range.low <= 0 || range.high <= range.low) throw new RangeError('Each range needs 0 < low < high in Hz.');
    return Object.freeze({ name: named(range.name), low: range.low, high: range.high });
  }).sort((a, b) => a.low - b.low);
  // Auto crossover names combine their neighbors: sub + bass -> subBass.
  // widthOctaves is the distance from the center to either zero-weight edge.
  if (crossovers === undefined) crossovers = ranges.slice(1).map((range, index) => ({
    name: ranges[index].name + range.name[0].toUpperCase() + range.name.slice(1),
    frequency: Math.sqrt(ranges[index].high * range.low), widthOctaves: .5,
  }));
  if (!Array.isArray(crossovers)) throw new TypeError('crossovers must be an array; use [] to disable them.');
  names.clear();
  crossovers = crossovers.map(crossover => {
    const widthOctaves = crossover?.widthOctaves ?? .5;
    if (!crossover || !finite(crossover.frequency) || crossover.frequency <= 0 || !finite(widthOctaves) || widthOctaves <= 0 || widthOctaves > 4) throw new RangeError('Crossovers need positive Hz and a widthOctaves between 0 and 4.');
    return Object.freeze({ name: named(crossover.name), frequency: crossover.frequency, widthOctaves });
  });
  Object.freeze(ranges); Object.freeze(crossovers);
  const result = Object.freeze({
    bands: Object.seal(Object.fromEntries(ranges.map(range => [range.name, 0]))),
    crossovers: Object.seal(Object.fromEntries(crossovers.map(crossover => [crossover.name, 0]))),
  });
  const taper = distance => distance >= 1 ? 0 : .5 + .5 * Math.cos(Math.PI * Math.max(0, distance));
  const coreWeight = (hz, range) => {
    if (hz >= range.low && hz <= range.high) return 1;
    if (!overlapOctaves || hz <= 0) return 0;
    return taper(Math.abs(Math.log2(hz < range.low ? hz / range.low : hz / range.high)) / overlapOctaves);
  };
  const definitions = [
    ...ranges.map(range => ({ name: range.name, output: result.bands, weight: hz => coreWeight(hz, range) })),
    ...crossovers.map(crossover => ({ name: crossover.name, output: result.crossovers, weight: hz => hz > 0 ? taper(Math.abs(Math.log2(hz / crossover.frequency)) / crossover.widthOctaves) : 0 })),
  ];
  let cachedRate = 0, cachedSize = 0, cachedLength = -1, masks = [];
  const prepare = (sampleRate, fftSize, length) => {
    cachedRate = sampleRate; cachedSize = fftSize; cachedLength = length;
    const hzPerBin = sampleRate / fftSize;
    masks = definitions.map(definition => {
      const indices = [], weights = []; let total = 0;
      // DC is intentionally excluded. Do not invent sub-bin detail; a short FFT
      // may have no bin in a very narrow range, in which case its level is zero.
      for (let index = 1; index < length; index++) {
        const weight = definition.weight(index * hzPerBin);
        if (weight > 0) { indices.push(index); weights.push(weight); total += weight; }
      }
      return { indices: Uint32Array.from(indices), weights: Float32Array.from(weights), total };
    });
  };
  const process = (features, dtSeconds) => {
    const spectrum = features?.spectrumFull, sampleRate = features?.sampleRate, fftSize = features?.fftSize;
    const valid = spectrum && Number.isInteger(spectrum.length) && finite(sampleRate) && sampleRate > 0 && Number.isInteger(fftSize) && fftSize >= 2;
    const length = valid ? Math.min(spectrum.length, Math.floor(fftSize / 2)) : 0;
    if (valid && (cachedRate !== sampleRate || cachedSize !== fftSize || cachedLength !== length)) prepare(sampleRate, fftSize, length);
    const dt = validTime(dtSeconds) ? dtSeconds : 0;
    for (let index = 0; index < definitions.length; index++) {
      const definition = definitions[index], mask = masks[index]; let target = 0;
      if (valid && mask?.total) {
        for (let bin = 0; bin < mask.indices.length; bin++) target += clamp(spectrum[mask.indices[bin]]) * mask.weights[bin];
        target = clamp(target / mask.total);
      }
      const previous = definition.output[definition.name], time = target > previous ? attack : release;
      const amount = dt > 0 ? (time === 0 ? 1 : -Math.expm1(-dt / time)) : 0;
      definition.output[definition.name] = amount === 1 ? target : clamp(previous + (target - previous) * amount);
    }
    return result;
  };
  process.read = () => result;
  process.reset = () => { for (const definition of definitions) definition.output[definition.name] = 0; return result; };
  process.ranges = ranges; process.crossovers = crossovers;
  return process;
}
