// Track-relative visual features, prepared once from decoded PCM. No audio output
// nodes, playback timers, network state, or instrument-separation assumptions.
// `levels` and `surge` provide gentle light; `motion` preserves punchier dynamics.
// `texture` separately reveals quieter sustained low/mid/high detail.
// Their separate integrals let visuals change speed without snapping on a seek.
const spectralTimelineStates = new WeakMap();

export async function createSpectralTimeline(buffer, { signal, framesPerSecond = 60, fftSize = 2048, yieldTask, motifFactory } = {}) {
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const clamp01 = value => Math.max(0, Math.min(1, value));
  const sampleRate = buffer?.sampleRate, length = buffer?.length, channelCount = buffer?.numberOfChannels;
  if (!finite(sampleRate) || sampleRate < 8000 || sampleRate > 384000 || !Number.isInteger(length) || length < 0 || !Number.isInteger(channelCount) || channelCount < 1 || channelCount > 16 || typeof buffer?.getChannelData !== 'function') throw new TypeError('Pass a finite AudioBuffer-like source with 1–16 channels and an 8–384 kHz sample rate.');
  if (!finite(framesPerSecond) || framesPerSecond < 1 || framesPerSecond > 60) throw new RangeError('framesPerSecond must be between 1 and 60.');
  if (!Number.isInteger(fftSize) || fftSize < 256 || fftSize > 8192 || (fftSize & (fftSize - 1))) throw new RangeError('fftSize must be a power of two between 256 and 8192.');
  if (yieldTask !== undefined && typeof yieldTask !== 'function') throw new TypeError('yieldTask must be a function returning a task-boundary promise.');
  if (motifFactory !== undefined && typeof motifFactory !== 'function') throw new TypeError('motifFactory must be a function.');
  const duration = length / sampleRate;
  const frames = duration ? Math.ceil(duration * framesPerSecond) + 1 : 1;
  const fftStages = Math.log2(fftSize);
  const bassFFTSize = Math.max(1024, Math.min(65536, 2 ** Math.round(Math.log2(sampleRate * .186))));
  const bassRate = Math.min(15, framesPerSecond), bassFrames = duration ? Math.ceil(duration * bassRate) + 1 : 1;
  const bassStep = bassFrames > 1 ? duration / (bassFrames - 1) : 1 / bassRate;
  const estimatedButterflies = channelCount * (frames * fftSize / 2 * fftStages + bassFrames * bassFFTSize / 2 * Math.log2(bassFFTSize));
  // Explicit bounds rather than silently changing resolution between devices.
  // 348 bytes/frame plus coarse bass/motifs and sparse events are retained; the
  // work bound covers BOTH FFT paths, not a claim
  // about device speed. A caller can retry a long source at a lower frame rate.
  if (duration > 7200 || frames > 144001 || estimatedButterflies > 1.2e9) throw new RangeError('This analysis exceeds the timeline budget; use a shorter buffer or lower framesPerSecond / fftSize.');
  const step = frames > 1 ? duration / (frames - 1) : 1 / framesPerSecond;
  const channels = Object.freeze(['sub', 'bass', 'lowMid', 'mid', 'highMid', 'air', 'subBass', 'bassLowMid', 'lowMidMid', 'midHighMid', 'highMidAir']);
  const count = channels.length;
  const clock = () => globalThis.performance?.now?.() ?? Date.now();
  const startedAt = clock(), timings = {};
  const yieldBoundary = yieldTask || (() => new Promise(resolve => setTimeout(resolve, 0)));
  const checkAbort = () => {
    if (signal?.aborted) { const error = new Error('Spectral timeline analysis aborted.'); error.name = 'AbortError'; throw error; }
  };
  let lastYield = clock();
  // Check small work units against a 5 ms soft budget. FFT stages and frame
  // preparation are split too, so a long track never runs as one blocking loop.
  const checkpoint = () => {
    checkAbort();
    if (clock() - lastYield < 5) return null;
    return Promise.resolve(yieldBoundary()).then(() => { checkAbort(); lastYield = clock(); });
  };
  checkAbort();
  const pcm = Array.from({ length: channelCount }, (_, index) => {
    const data = buffer.getChannelData(index);
    if (!data || data.length < length) throw new TypeError('Every PCM channel must contain buffer.length samples.');
    return data;
  });
  // Yield before the first transform so decoding can publish ready/playback UI.
  await yieldBoundary(); checkAbort(); lastYield = clock();
  const levels = new Float32Array(frames * count);
  const integrals = new Float64Array(frames * count);
  const motion = new Float32Array(frames * count);
  const motionIntegrals = new Float64Array(frames * count);
  const surges = new Float32Array(frames * 3);
  const textures = new Float32Array(frames * 3);
  const textureIntegrals = new Float64Array(frames * 3);
  // A compact internal spectrum serves onset, HPSS descriptors, and optional
  // motif extraction. Its fixed bins never rename or move the visual families.
  const descriptorCount = 32, descriptors = new Float32Array(frames * descriptorCount);
  const descriptorTop = Math.min(16000, sampleRate * .475);
  const centers = Float32Array.from({ length: descriptorCount }, (_, index) => 30 * (descriptorTop / 30) ** (index / (descriptorCount - 1)));
  const descriptorWidth = Math.log2(descriptorTop / 30) / (descriptorCount - 1);
  const real = new Float64Array(fftSize), imaginary = new Float64Array(fftSize);
  const power = new Float64Array(fftSize / 2);
  const hann = new Float64Array(fftSize), reverse = new Uint16Array(fftSize);
  const cosines = new Float64Array(fftSize / 2), sines = new Float64Array(fftSize / 2);
  let windowPower = 0;
  for (let index = 0; index < fftSize; index++) {
    const value = .5 - .5 * Math.cos(2 * Math.PI * index / (fftSize - 1));
    hann[index] = value; windowPower += value * value;
    let reversed = 0, bits = index;
    for (let bit = 0; bit < fftStages; bit++) { reversed = reversed * 2 + (bits & 1); bits >>>= 1; }
    reverse[index] = reversed;
    if (index < fftSize / 2) { cosines[index] = Math.cos(-2 * Math.PI * index / fftSize); sines[index] = Math.sin(-2 * Math.PI * index / fftSize); }
    if (!(index & 255)) { const pause = checkpoint(); if (pause) await pause; }
  }
  // Identical frequency regions to createBandBank: quarter-octave cosine core
  // shoulders and half-octave cosine crossovers. DC is intentionally excluded.
  const ranges = [[30, 60], [60, 250], [250, 500], [500, 2000], [2000, 6000], [6000, 16000]];
  const boundaries = [60, 250, 500, 2000, 6000];
  const taper = distance => distance >= 1 ? 0 : .5 + .5 * Math.cos(Math.PI * Math.max(0, distance));
  const masks = [];
  for (let band = 0; band < count; band++) {
    const indices = [], weights = [];
    for (let bin = 1; bin < power.length; bin++) {
      const hz = bin * sampleRate / fftSize;
      let weight;
      if (band < 6) {
        const [low, high] = ranges[band];
        weight = hz >= low && hz <= high ? 1 : taper(Math.abs(Math.log2(hz < low ? hz / low : hz / high)) / .25);
      } else weight = taper(Math.abs(Math.log2(hz / boundaries[band - 6])) / .5);
      if (weight > 0) { indices.push(bin); weights.push(weight); }
      if (!(bin & 511)) { const pause = checkpoint(); if (pause) await pause; }
    }
    masks.push({ indices: Uint16Array.from(indices), weights: Float64Array.from(weights) });
  }
  const descriptorMasks = Array.from(centers, center => {
    const indices = [], weights = [];
    for (let bin = 1; bin < power.length; bin++) {
      const weight = Math.max(0, 1 - Math.abs(Math.log2(bin * sampleRate / fftSize / center)) / descriptorWidth);
      if (weight) { indices.push(bin); weights.push(weight); }
    }
    return { indices: Uint16Array.from(indices), weights: Float64Array.from(weights) };
  });
  const histogramBins = 256, histogramLow = -96, histogramHigh = 6;
  const histograms = new Uint32Array(count * histogramBins), activeCounts = new Uint32Array(count);
  const noiseFloorDb = -68, floorPower = 10 ** (noiseFloorDb / 10);
  // One-sided Parseval power, divided by Hann-window power and channel count.
  // Sum channel powers, never PCM amplitudes: anti-phase stereo stays audible.
  const powerScale = 2 / (fftSize * windowPower * channelCount);
  for (let frame = 0; frame < frames; frame++) {
    power.fill(0);
    const center = Math.round(frame * step * sampleRate), first = center - fftSize / 2;
    for (let channel = 0; channel < channelCount; channel++) {
      const data = pcm[channel];
      for (let index = 0; index < fftSize; index++) {
        const sampleIndex = first + index;
        const sample = sampleIndex >= 0 && sampleIndex < length ? data[sampleIndex] : 0;
        // Corrupt/nonfinite samples do not poison the whole track. A generous
        // finite ceiling bounds arithmetic without clipping ordinary PCM peaks.
        real[reverse[index]] = (finite(sample) ? Math.max(-4, Math.min(4, sample)) : 0) * hann[index];
        imaginary[index] = 0;
        if (!(index & 511)) { const pause = checkpoint(); if (pause) await pause; }
      }
      for (let size = 2; size <= fftSize; size *= 2) {
        const half = size / 2, stride = fftSize / size;
        let butterflies = 0;
        for (let base = 0; base < fftSize; base += size) {
          for (let offset = 0; offset < half; offset++) {
            const even = base + offset, odd = even + half, twiddle = offset * stride;
            const re = real[odd] * cosines[twiddle] - imaginary[odd] * sines[twiddle];
            const im = real[odd] * sines[twiddle] + imaginary[odd] * cosines[twiddle];
            real[odd] = real[even] - re; imaginary[odd] = imaginary[even] - im;
            real[even] += re; imaginary[even] += im;
            if (!(++butterflies & 511)) { const pause = checkpoint(); if (pause) await pause; }
          }
        }
        const pause = checkpoint(); if (pause) await pause;
      }
      for (let bin = 1; bin < power.length; bin++) {
        power[bin] += (real[bin] * real[bin] + imaginary[bin] * imaginary[bin]) * powerScale;
        if (!(bin & 511)) { const pause = checkpoint(); if (pause) await pause; }
      }
    }
    for (let band = 0; band < count; band++) {
      const mask = masks[band]; let energy = 0;
      for (let bin = 0; bin < mask.indices.length; bin++) energy += power[mask.indices[bin]] * mask.weights[bin];
      levels[frame * count + band] = energy;
      if (energy > floorPower) {
        const db = 10 * Math.log10(energy);
        const bucket = Math.max(0, Math.min(histogramBins - 1, Math.floor((db - histogramLow) / (histogramHigh - histogramLow) * histogramBins)));
        histograms[band * histogramBins + bucket]++; activeCounts[band]++;
      }
    }
    for (let band = 0; band < descriptorCount; band++) {
      const mask = descriptorMasks[band]; let energy = 0;
      for (let bin = 0; bin < mask.indices.length; bin++) energy += power[mask.indices[bin]] * mask.weights[bin];
      descriptors[frame * descriptorCount + band] = energy > floorPower ? Math.sqrt(energy) : 0;
    }
    const pause = checkpoint(); if (pause) await pause;
  }
  timings.shortFFTMs = clock() - startedAt;
  // A per-band active 90th percentile balances quiet highs against loud bass.
  // Reference gain is capped at 36 dB; absolute -68 dB silence threshold and a
  // -68..-48 dB soft gate stop empty/noise-only bands becoming full-strength.
  // This is artistic normalization, not loudness metering or source separation.
  const references = new Float64Array(count), floorAmplitude = Math.sqrt(floorPower);
  const textureReferences = new Float64Array(count);
  for (let band = 0; band < count; band++) {
    const target = Math.ceil(activeCounts[band] * .9); let seen = 0, bucket = 0;
    if (target) for (; bucket < histogramBins - 1; bucket++) { seen += histograms[band * histogramBins + bucket]; if (seen >= target) break; }
    const db = histogramLow + (bucket + .5) / histogramBins * (histogramHigh - histogramLow);
    references[band] = 10 ** (Math.max(-36, db) / 20);
    // The independent texture path bootstraps from the active median, with at
    // most 4x additional sensitivity and the same absolute 36 dB maximum gain.
    // Do not change references: the existing rhythmic contrast depends on P90.
    const medianTarget = Math.ceil(activeCounts[band] * .5); let medianSeen = 0, medianBucket = 0;
    if (medianTarget) for (; medianBucket < histogramBins - 1; medianBucket++) {
      medianSeen += histograms[band * histogramBins + medianBucket];
      if (medianSeen >= medianTarget) break;
    }
    const medianDb = histogramLow + (medianBucket + .5) / histogramBins * (histogramHigh - histogramLow);
    textureReferences[band] = Math.max(10 ** (Math.max(-36, medianDb) / 20), references[band] / 4);
  }
  const musicalStartedAt = clock();
  const normalizedPower = (value, reference) => {
    if (!(value > floorPower)) return 0;
    const gate = clamp01((10 * Math.log10(value) - noiseFloorDb) / 20);
    return clamp01(Math.log1p(6 * Math.max(0, Math.sqrt(value) - floorAmplitude) / reference) / Math.log(7)) * gate * gate * (3 - 2 * gate);
  };
  const regionWeight = (hz, band) => {
    if (band < 6) {
      const [low, high] = ranges[band];
      return hz >= low && hz <= high ? 1 : taper(Math.abs(Math.log2(hz < low ? hz / low : hz / high)) / .25);
    }
    return taper(Math.abs(Math.log2(hz / boundaries[band - 6])) / .5);
  };
  // First locate attacks from positive spectral novelty. Frequency-local maxima
  // suppress movement of steady partials; the independent energy gate prevents
  // gain-normalised leakage from creating remote-family hits.
  const flux = new Float32Array(frames * count), familyWeights = Array.from({ length: count }, (_, band) => Float64Array.from(centers, hz => regionWeight(hz, band)));
  const novelty = new Float64Array(descriptorCount), lag = Math.max(1, Math.round(.025 / step));
  for (let frame = 0; frame < frames; frame++) {
    const previous = frame - lag;
    let totalPower = 0, previousPower = 0;
    for (let bin = 0; bin < descriptorCount; bin++) {
      let old = 0;
      if (previous >= 0) for (let neighbor = Math.max(0, bin - 1); neighbor <= Math.min(descriptorCount - 1, bin + 1); neighbor++) old = Math.max(old, descriptors[previous * descriptorCount + neighbor]);
      novelty[bin] = Math.max(0, Math.log1p(32 * descriptors[frame * descriptorCount + bin]) - Math.log1p(32 * old));
      totalPower += descriptors[frame * descriptorCount + bin] ** 2;
      if (previous >= 0) previousPower += descriptors[previous * descriptorCount + bin] ** 2;
    }
    for (let band = 0; band < count; band++) {
      let change = 0;
      for (let bin = 0; bin < descriptorCount; bin++) change += novelty[bin] ** 2 * familyWeights[band][bin];
      const rawPower = levels[frame * count + band];
      const gate = rawPower > floorPower ? clamp01((10 * Math.log10(rawPower) - noiseFloorDb) / 20) : 0;
      // Falling sustained tones can broaden their windowed spectrum at note-off.
      // Reject that spectral leakage as a fresh hit, while allowing timbral
      // change at approximately constant energy. This is an onset heuristic.
      const rising = previous < 0 || (rawPower > levels[previous * count + band] * 1.01 && totalPower >= previousPower * .85);
      flux[frame * count + band] = rising ? Math.sqrt(change) * gate * gate * (3 - 2 * gate) : 0;
    }
    if (!(frame & 15)) { const pause = checkpoint(); if (pause) await pause; }
  }
  // A separate 1 ms power envelope refines candidate timestamps against the PCM.
  // It never changes event strengths or audible samples. For attacks out of
  // silence, use the first actual above-floor sample, not a centred FFT peak.
  const envelopeSamples = Math.max(1, Math.round(sampleRate / 1000)), envelopeStep = envelopeSamples / sampleRate;
  const envelopeFrames = Math.ceil(length / envelopeSamples), envelope = new Float64Array(envelopeFrames), envelopePrefix = new Float64Array(envelopeFrames + 1);
  for (let block = 0; block < envelopeFrames; block++) {
    let sum = 0; const first = block * envelopeSamples, end = Math.min(length, first + envelopeSamples);
    for (let i = first; i < end; i++) for (let channel = 0; channel < channelCount; channel++) { const value = pcm[channel][i]; if (finite(value)) sum += Math.max(-4, Math.min(4, value)) ** 2; }
    envelope[block] = sum / ((end - first) * channelCount); envelopePrefix[block + 1] = envelopePrefix[block] + envelope[block];
    if (!(block & 31)) { const pause = checkpoint(); if (pause) await pause; }
  }
  const refinedTimes = new Map(); let refinementScratchMaxBytes = 0;
  const biquad = (type, hz) => {
    const omega = 2 * Math.PI * Math.max(8, Math.min(sampleRate * .475, hz)) / sampleRate, cosine = Math.cos(omega), alpha = Math.sin(omega) / Math.SQRT2, a0 = 1 + alpha;
    const side = type === 'high' ? 1 + cosine : 1 - cosine;
    return [side / 2 / a0, (type === 'high' ? -side : side) / a0, side / 2 / a0, -2 * cosine / a0, (1 - alpha) / a0];
  };
  const refinementFilters = Array.from({ length: count }, (_, band) => {
    const bounds = band < 6 ? ranges[band] : [boundaries[band - 6] / Math.SQRT2, boundaries[band - 6] * Math.SQRT2];
    return { low: bounds[0], high: bounds[1], highpass: biquad('high', bounds[0]), lowpass: biquad('low', bounds[1]) };
  });
  // Refine each FAMILY independently. A broadband rise must never pull a later
  // quiet high note onto an earlier loud bass hit. Warmed causal band-pass power
  // supplies the local rise; no negative-delay/fixed-offset correction is used.
  const refineOnset = async (frame, band) => {
    const key = frame * count + band;
    if (refinedTimes.has(key)) return refinedTimes.get(key);
    const nominal = frame * step, radius = Math.max(fftSize / sampleRate / 2 + step, step * 2), filter = refinementFilters[band];
    const first = Math.max(0, Math.floor((nominal - radius) / envelopeStep)), end = Math.min(envelopeFrames, Math.ceil((nominal + radius) / envelopeStep));
    if (end <= first + 2) return nominal;
    const average = Math.max(1, Math.ceil(1 / Math.sqrt(filter.low * filter.high) / envelopeStep));
    const confirmation = Math.max(2, Math.ceil(Math.max(.024, 1 / filter.low) / envelopeStep));
    const captureFirst = Math.max(0, first - Math.max(average, confirmation)), localPower = new Float64Array(end - captureFirst);
    const warmFirst = Math.max(0, captureFirst * envelopeSamples - Math.ceil(Math.max(.08, 4 / filter.low) * sampleRate));
    const state = new Float64Array(channelCount * 4), hp = filter.highpass, lp = filter.lowpass;
    for (let i = warmFirst; i < Math.min(length, end * envelopeSamples); i++) {
      let power = 0;
      for (let channel = 0; channel < channelCount; channel++) {
        const raw = pcm[channel][i], input = finite(raw) ? Math.max(-4, Math.min(4, raw)) : 0, base = channel * 4;
        const high = hp[0] * input + state[base]; state[base] = hp[1] * input - hp[3] * high + state[base + 1]; state[base + 1] = hp[2] * input - hp[4] * high;
        const output = lp[0] * high + state[base + 2]; state[base + 2] = lp[1] * high - lp[3] * output + state[base + 3]; state[base + 3] = lp[2] * high - lp[4] * output;
        power += output * output;
      }
      const block = Math.floor(i / envelopeSamples) - captureFirst;
      if (block >= 0) localPower[block] += power / (envelopeSamples * channelCount);
      if (!(i & 511)) { const pause = checkpoint(); if (pause) await pause; }
    }
    const smoothed = new Float64Array(end - first); let sum = 0;
    refinementScratchMaxBytes = Math.max(refinementScratchMaxBytes, localPower.byteLength + smoothed.byteLength + state.byteLength);
    for (let block = 0; block < localPower.length; block++) {
      sum += localPower[block]; if (block >= average) sum -= localPower[block - average];
      const target = block + captureFirst - first;
      if (target >= 0) smoothed[target] = Math.max(0, sum / average);
    }
    // Find a fresh local rise, not the earliest threshold crossing in a window
    // that may still contain the previous note's release (close double hits).
    const riseSpan = Math.max(2, Math.ceil(Math.max(.003, .5 / Math.sqrt(filter.low * filter.high)) / envelopeStep));
    let rise = 0, peakBlock = 0;
    for (let i = 0; i < smoothed.length; i++) {
      const change = smoothed[i] - (i >= riseSpan ? smoothed[i - riseSpan] : smoothed[0]);
      if (change > rise) { rise = change; peakBlock = i; }
    }
    let baseline = Infinity;
    const baselineFirst = Math.max(0, peakBlock - riseSpan * 3), baselineEnd = Math.max(baselineFirst + 1, peakBlock - riseSpan);
    for (let i = baselineFirst; i < baselineEnd; i++) baseline = Math.min(baseline, smoothed[i]);
    const peak = smoothed[peakBlock];
    if (first === 0 && nominal < radius) baseline = 0;
    if (peak <= floorPower || peak <= baseline * 1.05 + floorPower) { refinedTimes.set(key, null); return null; }
    const threshold = baseline + Math.max(floorPower, (peak - baseline) * .02);
    let block = peakBlock; while (block > baselineFirst && smoothed[block - 1] > threshold) block--;
    let at = Math.min(duration, (first + block + 1) * envelopeStep);
    // Restore an exact PCM silence boundary only when this same family carries
    // a meaningful share of that attack. A weaker unrelated instrument cannot
    // borrow the timestamp merely because the total waveform started earlier.
    const searchFirst = Math.max(first, Math.floor((at - .02) / envelopeStep));
    let onsetBlock = searchFirst;
    while (onsetBlock < end && envelope[onsetBlock] <= floorPower) onsetBlock++;
    if (onsetBlock > searchFirst || onsetBlock === 0) {
      const stop = Math.min(end, onsetBlock + Math.max(1, Math.ceil(.012 / envelopeStep)));
      let total = 0, selected = 0;
      for (let index = onsetBlock; index < stop; index++) { total += envelope[index]; selected += localPower[index - captureFirst] || 0; }
      const isolatedPulse = onsetBlock > searchFirst && envelope[onsetBlock] > floorPower && (envelope[onsetBlock + 1] || 0) <= floorPower && (envelope[onsetBlock + 2] || 0) <= floorPower;
      if (selected > total * .08 || isolatedPulse) {
        for (let i = onsetBlock * envelopeSamples; i < Math.min(length, stop * envelopeSamples); i++) {
          let power = 0; for (let channel = 0; channel < channelCount; channel++) { const value = pcm[channel][i]; if (finite(value)) power += Math.max(-4, Math.min(4, value)) ** 2; }
          if (power / channelCount > floorPower) { at = i / sampleRate; break; }
        }
      }
    }
    // Confirm a real increase around the REFINED time. A future note-off can
    // broaden the centred spectrum while ordinary carrier oscillation inside
    // its earlier window looks like a local maximum. Cycle-spanning means reject
    // that false event, and reject a release whose total energy is collapsing.
    const atBlock = Math.max(first, Math.min(end - 1, Math.floor(at / envelopeStep)));
    const beforeFirst = Math.max(captureFirst, atBlock - confirmation), afterEnd = Math.min(end, atBlock + confirmation);
    let beforePower = 0, afterPower = 0;
    for (let i = beforeFirst; i < atBlock; i++) beforePower += localPower[i - captureFirst] || 0;
    for (let i = atBlock; i < afterEnd; i++) afterPower += localPower[i - captureFirst] || 0;
    beforePower /= Math.max(1, atBlock - beforeFirst); afterPower /= Math.max(1, afterEnd - atBlock);
    const beforeTotal = (envelopePrefix[atBlock] - envelopePrefix[beforeFirst]) / Math.max(1, atBlock - beforeFirst);
    const afterTotal = (envelopePrefix[afterEnd] - envelopePrefix[atBlock]) / Math.max(1, afterEnd - atBlock);
    if (afterPower <= beforePower * 1.12 + floorPower || afterTotal < beforeTotal * .85) { refinedTimes.set(key, null); return null; }
    refinedTimes.set(key, at); return at;
  };
  const rhythmReleases = [.32, .26, .22, .18, .15, .12, .29, .24, .20, .165, .135];
  const eventTables = [], candidateCounts = new Uint32Array(count), medianScratch = new Float64Array(Math.max(1, Math.round(.5 / step)));
  for (let band = 0; band < count; band++) {
    const candidates = [];
    for (let frame = 0; frame < frames; frame++) {
      if (!(frame & 127)) { const pause = checkpoint(); if (pause) await pause; }
      const value = flux[frame * count + band];
      if (value < .018 || (frame && value < flux[(frame - 1) * count + band]) || (frame + 1 < frames && value <= flux[(frame + 1) * count + band])) continue;
      const history = Math.min(frame, medianScratch.length); medianScratch.fill(0);
      for (let n = 0; n < history; n++) medianScratch[n] = flux[(frame - n - 1) * count + band];
      medianScratch.sort(); const median = medianScratch[Math.floor(medianScratch.length / 2)];
      if (value <= median * 2.5 + .018) continue;
      const time = await refineOnset(frame, band);
      if (time === null) continue;
      candidates.push({ time, strength: value, frame }); candidateCounts[band]++;
      if (!(frame & 31)) { const pause = checkpoint(); if (pause) await pause; }
    }
    candidates.sort((a, b) => a.time - b.time || b.strength - a.strength);
    const merged = [];
    for (const candidate of candidates) {
      const previous = merged[merged.length - 1];
      if (previous && candidate.time - previous.time < .04) { if (candidate.strength > previous.strength) previous.strength = candidate.strength; }
      else merged.push({ ...candidate });
    }
    const strengths = merged.map(event => event.strength).sort((a, b) => a - b);
    const reference = Math.max(.15, strengths[Math.floor((strengths.length - 1) * .9)] || 0);
    const times = new Float64Array(merged.length), amplitudes = new Float32Array(merged.length), values = new Float64Array(merged.length), prefixes = new Float64Array(merged.length), tau = rhythmReleases[band];
    for (let index = 0; index < merged.length; index++) {
      times[index] = merged[index].time; amplitudes[index] = clamp01(Math.sqrt(merged[index].strength / reference));
      const elapsed = index ? times[index] - times[index - 1] : 0;
      const tail = index ? values[index - 1] * Math.exp(-elapsed / tau) : 0;
      prefixes[index] = index ? prefixes[index - 1] + values[index - 1] * tau * -Math.expm1(-elapsed / tau) : 0;
      // Saturating addition happens at the event boundary. Between boundaries
      // the FINAL combined value decays exponentially, with its exact integral.
      values[index] = Math.min(1, tail + amplitudes[index]);
    }
    eventTables.push(Object.freeze({ times, amplitudes, values, integrals: prefixes, release: tau }));
    const pause = checkpoint(); if (pause) await pause;
  }
  timings.onsetsMs = clock() - musicalStartedAt;

  // Approximate HPSS on the compact RMS spectrum: a 250 ms time median versus
  // a five-bin frequency median. These bounded descriptors are NOT audio stems.
  const hpssStartedAt = clock();
  const spectralTextures = await createSpectralTextures({ data: descriptors, frames, channels: descriptorCount, step, centers, duration }, { signal, yieldTask: yieldBoundary });
  const harmonics = spectralTextures.harmonic, percussives = spectralTextures.percussive, afterglows = spectralTextures.afterglow;
  timings.hpssMs = clock() - hpssStartedAt;

  // A longer observation window improves only the low families' sustained
  // energy. Onset timing always comes from the independent short path above.
  const bassStartedAt = clock(), bassBands = [0, 1, 6, 7], bassValues = new Float32Array(bassFrames * bassBands.length);
  const bassReal = new Float64Array(bassFFTSize), bassImaginary = new Float64Array(bassFFTSize), bassWindow = new Float64Array(bassFFTSize), bassReverse = new Uint32Array(bassFFTSize);
  const bassCosines = new Float64Array(bassFFTSize / 2), bassSines = new Float64Array(bassFFTSize / 2), bassPower = new Float64Array(bassFFTSize / 2);
  const bassStages = Math.log2(bassFFTSize); let bassWindowPower = 0;
  for (let index = 0; index < bassFFTSize; index++) {
    const value = .5 - .5 * Math.cos(2 * Math.PI * index / (bassFFTSize - 1)); bassWindow[index] = value; bassWindowPower += value * value;
    let reversed = 0, bits = index;
    for (let bit = 0; bit < bassStages; bit++) { reversed = reversed * 2 + (bits & 1); bits >>>= 1; } bassReverse[index] = reversed;
    if (index < bassFFTSize / 2) { bassCosines[index] = Math.cos(-2 * Math.PI * index / bassFFTSize); bassSines[index] = Math.sin(-2 * Math.PI * index / bassFFTSize); }
    if (!(index & 255)) { const pause = checkpoint(); if (pause) await pause; }
  }
  const bassMasks = bassBands.map(band => { const indices = [], weights = []; for (let bin = 1; bin < bassPower.length; bin++) { const weight = regionWeight(bin * sampleRate / bassFFTSize, band); if (weight) { indices.push(bin); weights.push(weight); } } return { indices: Uint32Array.from(indices), weights: Float64Array.from(weights) }; });
  const bassScale = 2 / (bassFFTSize * bassWindowPower * channelCount);
  for (let frame = 0; frame < bassFrames; frame++) {
    bassPower.fill(0); const first = Math.round(frame * bassStep * sampleRate) - bassFFTSize / 2;
    for (let channel = 0; channel < channelCount; channel++) {
      const data = pcm[channel];
      for (let index = 0; index < bassFFTSize; index++) { const position = first + index, value = position >= 0 && position < length ? data[position] : 0; bassReal[bassReverse[index]] = (finite(value) ? Math.max(-4, Math.min(4, value)) : 0) * bassWindow[index]; bassImaginary[index] = 0; if (!(index & 511)) { const pause = checkpoint(); if (pause) await pause; } }
      for (let size = 2; size <= bassFFTSize; size *= 2) {
        const half = size / 2, stride = bassFFTSize / size; let butterflies = 0;
        for (let base = 0; base < bassFFTSize; base += size) for (let offset = 0; offset < half; offset++) {
          const even = base + offset, odd = even + half, twiddle = offset * stride;
          const re = bassReal[odd] * bassCosines[twiddle] - bassImaginary[odd] * bassSines[twiddle], im = bassReal[odd] * bassSines[twiddle] + bassImaginary[odd] * bassCosines[twiddle];
          bassReal[odd] = bassReal[even] - re; bassImaginary[odd] = bassImaginary[even] - im; bassReal[even] += re; bassImaginary[even] += im;
          if (!(++butterflies & 511)) { const pause = checkpoint(); if (pause) await pause; }
        }
      }
      // Only low-frequency bins needed by these masks are retained/weighted.
      const last = Math.min(bassPower.length - 1, Math.ceil(250 * 2 ** .5 * bassFFTSize / sampleRate));
      for (let bin = 1; bin <= last; bin++) bassPower[bin] += (bassReal[bin] ** 2 + bassImaginary[bin] ** 2) * bassScale;
    }
    for (let index = 0; index < bassBands.length; index++) {
      const mask = bassMasks[index]; let value = 0;
      for (let bin = 0; bin < mask.indices.length; bin++) value += bassPower[mask.indices[bin]] * mask.weights[bin];
      const target = normalizedPower(value, references[bassBands[index]]), previous = frame ? bassValues[(frame - 1) * bassBands.length + index] : 0;
      bassValues[frame * bassBands.length + index] = previous + (target - previous) * -Math.expm1(-bassStep / (target > previous ? .2 : .8));
    }
    const pause = checkpoint(); if (pause) await pause;
  }
  timings.bassMs = clock() - bassStartedAt;
  let motifs = null, motifInputBytes = 0;
  if (motifFactory) {
    const motifStartedAt = clock(), motifFrames = duration ? Math.ceil(duration * 8) + 1 : 1, motifStep = motifFrames > 1 ? duration / (motifFrames - 1) : .125;
    const data = new Float32Array(motifFrames * descriptorCount);
    motifInputBytes = data.byteLength;
    for (let frame = 0; frame < motifFrames; frame++) {
      const time = frame * motifStep, index = Math.min(frames - 1, Math.floor(time / step)), next = Math.min(frames - 1, index + 1), fraction = next === index ? 0 : time / step - index;
      for (let bin = 0; bin < descriptorCount; bin++) data[frame * descriptorCount + bin] = descriptors[index * descriptorCount + bin] + (descriptors[next * descriptorCount + bin] - descriptors[index * descriptorCount + bin]) * fraction;
      if (!(frame & 31)) { const pause = checkpoint(); if (pause) await pause; }
    }
    motifs = await motifFactory({ data, frames: motifFrames, channels: descriptorCount, step: motifStep, centers, duration }, { signal, yieldTask: yieldBoundary, components: 4 });
    checkAbort();
    if (!motifs || typeof motifs.sample !== 'function' || motifs.components !== 4) throw new TypeError('motifFactory must return a four-component timeline with sample(t, out).');
    timings.motifsMs = clock() - motifStartedAt;
  }
  const attacks = [.40, .24, .19, .16, .13, .09, .32, .22, .175, .145, .105];
  const releases = [1.60, 1.15, .95, .80, .65, .45, 1.40, 1.05, .90, .74, .55];
  const attackAmounts = attacks.map(time => -Math.expm1(-step / time));
  const releaseAmounts = releases.map(time => -Math.expm1(-step / time));
  // A separate nonlinear motion path leaves the long light/surge envelopes intact.
  // Derive it from PCM amplitude before logarithmic compression: sustained quiet
  // texture stays slow, while strong family accents drive visibly faster motion.
  // Musical attacks take their target immediately; only falling energy eases out.
  // The 60 Hz feature grid still interpolates between adjacent samples for motion.
  const motionReleases = [.320, .260, .220, .180, .150, .120, .290, .240, .200, .165, .135].map(time => -Math.expm1(-step / time));
  const surgeAttacks = [1, 1.2, 1.4].map(time => -Math.expm1(-step / time));
  const surgeReleases = [3, 3.4, 3.8].map(time => -Math.expm1(-step / time));
  const groups = [[0, 1, 6], [2, 3, 7, 8], [4, 5, 9, 10]];
  const textureAttacks = [.8, 1.1, 1.4].map(time => -Math.expm1(-step / time));
  const textureReleases = [3, 4, 5].map(time => -Math.expm1(-step / time));
  const textureTargets = new Float64Array(count);
  // A bounded trailing-power window adapts only the texture path. Raw powers
  // need their own ring because levels is overwritten by its smoothed output.
  // Pad the initial partial window with the conservative full-track median.
  const textureWindow = Math.min(frames, Math.max(1, Math.round(8 / step)));
  const textureHistory = new Float64Array(textureWindow * count);
  const texturePower = new Float64Array(count), textureReference = textureReferences.slice();
  const textureFloors = references.map(reference => Math.max(10 ** (-36 / 20), reference / 4));
  const textureGainRise = -Math.expm1(-step / 1.5), textureGainFall = -Math.expm1(-step / .3);
  for (let frame = 0; frame < frames; frame++) {
    const base = frame * count, previousBase = base - count;
    for (let band = 0; band < count; band++) {
      const energy = levels[base + band]; let target = 0, motionTarget = 0, textureTarget = 0;
      const slot = frame % textureWindow * count + band;
      texturePower[band] = Math.max(0, texturePower[band] + energy - textureHistory[slot]);
      textureHistory[slot] = energy;
      const missing = Math.max(0, textureWindow - frame - 1);
      const rollingReference = Math.sqrt((texturePower[band] + missing * textureReferences[band] ** 2) / textureWindow);
      const wantedReference = Math.max(textureFloors[band], Math.min(references[band], finite(rollingReference) ? rollingReference : textureReferences[band]));
      const currentReference = textureReference[band];
      textureReference[band] = currentReference + (wantedReference - currentReference) * (wantedReference > currentReference ? textureGainFall : textureGainRise);
      if (energy > floorPower) {
        const db = 10 * Math.log10(energy), gate = clamp01((db - noiseFloorDb) / 20);
        const amplitudeRatio = Math.max(0, Math.sqrt(energy) - floorAmplitude) / references[band];
        const softGate = gate * gate * (3 - 2 * gate);
        target = clamp01(Math.log1p(6 * amplitudeRatio) / Math.log(7)) * softGate;
        motionTarget = clamp01((amplitudeRatio - .18) / .82) ** 3 * softGate;
        const textureRatio = Math.max(0, Math.sqrt(energy) - floorAmplitude) / textureReference[band];
        textureTarget = clamp01(Math.log1p(6 * textureRatio) / Math.log(7)) * softGate;
      }
      textureTargets[band] = textureTarget;
      const previous = frame ? levels[previousBase + band] : 0;
      levels[base + band] = frame ? previous + (target - previous) * (target > previous ? attackAmounts[band] : releaseAmounts[band]) : 0;
      if (frame) integrals[base + band] = integrals[previousBase + band] + (previous + levels[base + band]) * step / 2;
      const previousMotion = frame ? motion[previousBase + band] : 0;
      motion[base + band] = motionTarget >= previousMotion ? motionTarget : previousMotion + (motionTarget - previousMotion) * motionReleases[band];
      if (frame) motionIntegrals[base + band] = motionIntegrals[previousBase + band] + (previousMotion + motion[base + band]) * step / 2;
    }
    for (let group = 0; group < 3; group++) {
      const target = groups[group].reduce((sum, band) => sum + levels[base + band], 0) / groups[group].length;
      const previous = frame ? surges[(frame - 1) * 3 + group] : 0;
      surges[frame * 3 + group] = frame ? previous + (target - previous) * (target > previous ? surgeAttacks[group] : surgeReleases[group]) : 0;
      // RMS keeps a single audible family useful instead of dividing its light
      // away. The absolute gate above still leaves silent/noise-only bands dark.
      const textureTarget = Math.sqrt(groups[group].reduce((sum, band) => sum + textureTargets[band] ** 2, 0) / groups[group].length);
      const index = frame * 3 + group, previousTexture = frame ? textures[index - 3] : 0;
      textures[index] = frame ? previousTexture + (textureTarget - previousTexture) * (textureTarget > previousTexture ? textureAttacks[group] : textureReleases[group]) : 0;
      if (frame) textureIntegrals[index] = textureIntegrals[index - 3] + (previousTexture + textures[index]) * step / 2;
    }
    if (!(frame & 31)) { const pause = checkpoint(); if (pause) await pause; }
  }
  checkAbort();
  timings.totalMs = clock() - startedAt;
  const eventBytes = eventTables.reduce((sum, table) => sum + table.times.byteLength + table.amplitudes.byteLength + table.values.byteLength + table.integrals.byteLength, 0);
  const retainedArrayBytes = frames * 348 + bassValues.byteLength + centers.byteLength + eventBytes + (motifs?.metadata?.retainedArrayBytes || 0);
  const scratchArrays = [real, imaginary, power, hann, reverse, cosines, sines, descriptors, histograms, activeCounts, references, textureReferences, flux, novelty, envelope, envelopePrefix, candidateCounts, medianScratch, bassReal, bassImaginary, bassWindow, bassReverse, bassCosines, bassSines, bassPower, textureTargets, textureHistory, texturePower, textureReference, textureFloors];
  for (const mask of [...masks, ...descriptorMasks, ...bassMasks]) scratchArrays.push(mask.indices, mask.weights);
  scratchArrays.push(...familyWeights);
  const peakArrayBytesEstimate = retainedArrayBytes + scratchArrays.reduce((sum, array) => sum + array.byteLength, 0) + motifInputBytes + spectralTextures.metadata.temporaryArrayBytes + refinementScratchMaxBytes;
  const metadata = Object.freeze({ version: 2, algorithm: 'stable-family-onsets-hpss-bass-v1', fftSize, sampleRate, framesPerSecond: 1 / step, descriptorChannels: descriptorCount,
    bass: Object.freeze({ fftSize: bassFFTSize, step: bassStep, frames: bassFrames, families: Object.freeze([...bassBands]), windowSeconds: bassFFTSize / sampleRate }),
    onsets: Object.freeze({ method: 'positive-log-spectral-flux/local-frequency-max + warmed causal family-band refinement', lagSeconds: lag * step, minimumSpacingSeconds: .04, minimumNovelty: .018, minimumFamilyPowerRatio: 1.01, minimumConfirmedPowerRatio: 1.12, maximumFallingTotalPowerRatio: .85, candidates: Object.freeze([...candidateCounts]), counts: Object.freeze(eventTables.map(table => table.times.length)), envelopeStep, silenceTimestampResolutionSeconds: 1 / sampleRate }),
    hpss: spectralTextures.metadata,
    motifs: motifs?.metadata || null, estimatedButterflies, retainedArrayBytes, peakArrayBytesEstimate, memoryEstimateExcludes: 'input PCM, JS object/engine overhead and motif-factory scratch; array estimate is not measured process memory',
    timings: Object.freeze({ ...timings }) });
  const state = { duration, step, frames, count, channels, metadata, levels, integrals, motion, motionIntegrals, surges, textures, textureIntegrals, eventTables, bassFrames, bassStep, bassBands, bassValues, harmonics, percussives, afterglows, motifs };
  const timeline = Object.freeze({ duration, step, frames, channels, metadata, events: Object.freeze(eventTables), sample: spectralTimelineSampler(state) });
  spectralTimelineStates.set(timeline, state);
  return timeline;
}

// Copies expose only the compact final state. The registry never retains PCM or
// analysis scratch; callers cannot mutate the sampler by changing an export.
export function getSpectralTimelineState(timeline) {
  const state = spectralTimelineStates.get(timeline);
  return state ? spectralTimelineCopyState(state) : null;
}

function spectralTimelineCopyState(state) {
  const result = { ...state, channels: [...state.channels], bassBands: [...state.bassBands], metadata: spectralTimelineFreezeJSON(state.metadata) };
  for (const key of ['levels', 'integrals', 'motion', 'motionIntegrals', 'surges', 'textures', 'textureIntegrals', 'bassValues', 'harmonics', 'percussives', 'afterglows']) result[key] = state[key].slice();
  result.eventTables = state.eventTables.map(table => Object.freeze({ release: table.release, times: table.times.slice(), amplitudes: table.amplitudes.slice(), values: table.values.slice(), integrals: table.integrals.slice() }));
  return result;
}

function spectralTimelineFreezeJSON(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(spectralTimelineFreezeJSON));
  if (value && typeof value === 'object') return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, spectralTimelineFreezeJSON(entry)])));
  return value;
}

// The binary codec validates untrusted manifests/values before this constructor.
// Reuse precisely the same sampler, including Float64 prefixes and event edges.
export function restoreSpectralTimeline(input, { motifs = null, prepared = null } = {}) {
  if (!input || !Number.isInteger(input.frames) || input.frames < 1 || input.frames > 144001 || input.count !== 11 || !Array.isArray(input.channels) || input.channels.length !== 11 || !Array.isArray(input.eventTables) || input.eventTables.length !== 11 || !Number.isFinite(input.duration) || input.duration < 0 || input.duration > 7200 || !Number.isFinite(input.step) || input.step <= 0 || !Number.isInteger(input.bassFrames) || input.bassFrames < 1 || !Number.isFinite(input.bassStep) || input.bassStep <= 0 || !Array.isArray(input.bassBands) || input.bassBands.length !== 4) throw new TypeError('Invalid compact spectral timeline state.');
  for (const [key, Type, length] of [['levels', Float32Array, input.frames * 11], ['integrals', Float64Array, input.frames * 11], ['motion', Float32Array, input.frames * 11], ['motionIntegrals', Float64Array, input.frames * 11], ['surges', Float32Array, input.frames * 3], ['textures', Float32Array, input.frames * 3], ['textureIntegrals', Float64Array, input.frames * 3], ['harmonics', Float32Array, input.frames * 3], ['percussives', Float32Array, input.frames * 3], ['afterglows', Float32Array, input.frames * 3], ['bassValues', Float32Array, input.bassFrames * 4]]) if (!(input[key] instanceof Type) || input[key].length !== length) throw new TypeError(`Invalid compact spectral array: ${key}.`);
  for (const table of input.eventTables) if (!(table.times instanceof Float64Array) || !(table.amplitudes instanceof Float32Array) || !(table.values instanceof Float64Array) || !(table.integrals instanceof Float64Array) || table.amplitudes.length !== table.times.length || table.values.length !== table.times.length || table.integrals.length !== table.times.length || !Number.isFinite(table.release) || table.release <= 0) throw new TypeError('Invalid compact onset table.');
  const state = spectralTimelineCopyState(input);
  state.channels = Object.freeze(state.channels); state.bassBands = Object.freeze(state.bassBands); state.motifs = motifs;
  const timeline = Object.freeze({ duration: state.duration, step: state.step, frames: state.frames, channels: state.channels, metadata: state.metadata, events: Object.freeze(state.eventTables), sample: spectralTimelineSampler(state), ...(prepared ? { prepared: spectralTimelineFreezeJSON(prepared) } : {}) });
  spectralTimelineStates.set(timeline, state);
  return timeline;
}

// A separate lexical scope retains only compact timelines, never input PCM, FFT
// scratch, detection spectra or temporary factory descriptors.
function spectralTimelineSampler({ duration, step, frames, count, levels, integrals, motion, motionIntegrals, surges, textures, textureIntegrals, eventTables, bassFrames, bassStep, bassBands, bassValues, harmonics, percussives, afterglows, motifs }) {
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const motifScratch = { values: new Float32Array(4), integrals: new Float32Array(4) };
  const wideFields = ['rhythm', 'rhythmIntegrals', 'energy'], regionalFields = ['harmonic', 'percussive', 'afterglow'], motifFields = ['motif', 'motifIntegrals'];
  const regionalValues = [harmonics, percussives, afterglows];
  return function sample(t, out = {}) {
      if (!out || typeof out !== 'object') throw new TypeError('sample output must be an object.');
      if (!(out.levels instanceof Float32Array) || out.levels.length < count) out.levels = new Float32Array(count);
      if (!(out.integrals instanceof Float32Array) || out.integrals.length < count) out.integrals = new Float32Array(count);
      if (!(out.motion instanceof Float32Array) || out.motion.length < count) out.motion = new Float32Array(count);
      if (!(out.motionIntegrals instanceof Float32Array) || out.motionIntegrals.length < count) out.motionIntegrals = new Float32Array(count);
      if (!(out.surge instanceof Float32Array) || out.surge.length < 3) out.surge = new Float32Array(3);
      if (!(out.texture instanceof Float32Array) || out.texture.length < 3) out.texture = new Float32Array(3);
      if (!(out.textureIntegrals instanceof Float32Array) || out.textureIntegrals.length < 3) out.textureIntegrals = new Float32Array(3);
      for (const field of wideFields) if (!(out[field] instanceof Float32Array) || out[field].length < count) out[field] = new Float32Array(count);
      for (const field of regionalFields) if (!(out[field] instanceof Float32Array) || out[field].length < 3) out[field] = new Float32Array(3);
      for (const field of motifFields) if (!(out[field] instanceof Float32Array) || out[field].length < 4) out[field] = new Float32Array(4);
      const time = finite(t) ? Math.max(0, Math.min(duration, t)) : t === Infinity ? duration : 0;
      const frame = Math.min(frames - 1, Math.floor(time / step));
      const next = Math.min(frames - 1, frame + 1), elapsed = Math.max(0, time - frame * step);
      const fraction = next === frame ? 0 : Math.min(1, elapsed / step);
      for (let band = 0; band < count; band++) {
        const base = frame * count + band, a = levels[base], b = levels[next * count + band];
        out.levels[band] = a + (b - a) * fraction;
        out.integrals[band] = integrals[base] + (next === frame ? 0 : elapsed * (a + (b - a) * fraction / 2));
        const ma = motion[base], mb = motion[next * count + band];
        out.motion[band] = ma + (mb - ma) * fraction;
        out.motionIntegrals[band] = motionIntegrals[base] + (next === frame ? 0 : elapsed * (ma + (mb - ma) * fraction / 2));
        out.energy[band] = out.levels[band];
        const table = eventTables[band]; let low = 0, high = table.times.length;
        while (low < high) { const mid = (low + high) >>> 1; if (table.times[mid] <= time) low = mid + 1; else high = mid; }
        const event = low - 1;
        if (event < 0) { out.rhythm[band] = 0; out.rhythmIntegrals[band] = 0; }
        else { const age = time - table.times[event], value = table.values[event], tau = table.release; out.rhythm[band] = value * Math.exp(-age / tau); out.rhythmIntegrals[band] = table.integrals[event] + value * tau * -Math.expm1(-age / tau); }
      }
      const bassFrame = Math.min(bassFrames - 1, Math.floor(time / bassStep)), bassNext = Math.min(bassFrames - 1, bassFrame + 1), bassFraction = bassFrame === bassNext ? 0 : Math.min(1, Math.max(0, time / bassStep - bassFrame));
      for (let index = 0; index < bassBands.length; index++) { const a = bassValues[bassFrame * bassBands.length + index], b = bassValues[bassNext * bassBands.length + index]; out.energy[bassBands[index]] = a + (b - a) * bassFraction; }
      for (let group = 0; group < 3; group++) {
        const a = surges[frame * 3 + group], b = surges[next * 3 + group];
        out.surge[group] = a + (b - a) * fraction;
        const base = frame * 3 + group, ta = textures[base], tb = textures[next * 3 + group];
        out.texture[group] = ta + (tb - ta) * fraction;
        out.textureIntegrals[group] = textureIntegrals[base] + (next === frame ? 0 : elapsed * (ta + (tb - ta) * fraction / 2));
        for (let index = 0; index < regionalFields.length; index++) { const values = regionalValues[index], a = values[base], b = values[next * 3 + group]; out[regionalFields[index]][group] = a + (b - a) * fraction; }
      }
      if (motifs) { motifs.sample(time, motifScratch); out.motif.set(motifScratch.values); out.motifIntegrals.set(motifScratch.integrals); }
      else { out.motif.fill(0); out.motifIntegrals.fill(0); }
      return out;
  };
}

// Independently reusable harmonic/percussive/afterglow descriptors from a compact
// RMS spectrum. No FFT, playback, full-track PCM or instrument-labelled stems.
export async function createSpectralTextures({ data, frames, channels: descriptorCount, step, centers, duration = (frames - 1) * step } = {}, { signal, yieldTask, timeWindowSeconds = .25, frequencyBins = 5, boundaries = [250, 2000] } = {}) {
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  if (!Number.isInteger(frames) || frames < 1 || frames > 144001 || !Number.isInteger(descriptorCount) || descriptorCount < 3 || descriptorCount > 512 || !finite(step) || step <= 0 || !finite(duration) || duration < 0 || duration > 7200 || duration > frames * step || !data || data.length !== frames * descriptorCount || !centers || centers.length !== descriptorCount) throw new TypeError('Pass bounded time-major RMS descriptors, ordered frequency centers, frames, channels, step and duration.');
  if (!finite(timeWindowSeconds) || timeWindowSeconds <= 0 || timeWindowSeconds > 2 || !Number.isInteger(frequencyBins) || frequencyBins < 3 || frequencyBins > 31 || !(frequencyBins % 2) || boundaries.length !== 2 || !boundaries.every(finite) || boundaries[0] <= 0 || boundaries[1] <= boundaries[0] || (yieldTask !== undefined && typeof yieldTask !== 'function')) throw new RangeError('Use a 0–2 second time window, odd 3–31 frequency bins, ascending group boundaries and a task scheduler.');
  for (let bin = 0; bin < descriptorCount; bin++) if (!finite(centers[bin]) || centers[bin] <= 0 || (bin && centers[bin] <= centers[bin - 1])) throw new RangeError('Frequency centers must be positive and strictly increasing.');
  if (frames * descriptorCount * (Math.max(1, Math.round(timeWindowSeconds / 2 / step)) * 2 + 1) > 1e9) throw new RangeError('Texture median work exceeds the descriptor budget.');
  const clock = () => globalThis.performance?.now?.() ?? Date.now(), startedAt = clock();
  let lastYield = startedAt, yields = 0;
  const checkAbort = () => { if (signal?.aborted) { const error = new Error('Spectral texture analysis aborted.'); error.name = 'AbortError'; throw error; } };
  const yieldBoundary = yieldTask || (() => new Promise(resolve => setTimeout(resolve, 0)));
  const checkpoint = () => { checkAbort(); if (clock() - lastYield < 5) return null; return Promise.resolve(yieldBoundary()).then(() => { checkAbort(); yields++; lastYield = clock(); }); };
  checkAbort();
  for (let index = 0; index < data.length; index++) { if (!finite(data[index]) || data[index] < 0 || data[index] > 4) throw new RangeError('RMS descriptors must be finite values between zero and four.'); if (!(index & 1023)) { const pause = checkpoint(); if (pause) await pause; } }
  const descriptors = data, frequencyRadius = (frequencyBins - 1) / 2;
  const histogramBins = 256, histogramLow = -96, histogramHigh = 6, noiseFloorDb = -68, floorPower = 10 ** (noiseFloorDb / 10), floorAmplitude = Math.sqrt(floorPower);
  const clamp01 = value => Math.max(0, Math.min(1, value));
  const normalizedPower = (value, reference) => { if (!(value > floorPower)) return 0; const gate = clamp01((10 * Math.log10(value) - noiseFloorDb) / 20); return clamp01(Math.log1p(6 * Math.max(0, Math.sqrt(value) - floorAmplitude) / reference) / Math.log(7)) * gate * gate * (3 - 2 * gate); };
  const harmonics = new Float32Array(frames * 3), percussives = new Float32Array(frames * 3), afterglows = new Float32Array(frames * 3);
  const timeRadius = Math.max(1, Math.round(timeWindowSeconds / 2 / step)), timeScratch = new Float64Array(timeRadius * 2 + 1), frequencyScratch = new Float64Array(frequencyBins);
  const hpssReferences = new Float64Array(3), groupPowers = new Float32Array(frames * 3);
  for (let frame = 0; frame < frames; frame++) {
    for (let bin = 0; bin < descriptorCount; bin++) {
      const amplitude = descriptors[frame * descriptorCount + bin]; if (!amplitude) continue;
      for (let offset = -timeRadius; offset <= timeRadius; offset++) { const f = frame + offset; timeScratch[offset + timeRadius] = f >= 0 && f < frames ? descriptors[f * descriptorCount + bin] : 0; }
      for (let offset = -frequencyRadius; offset <= frequencyRadius; offset++) { const b = bin + offset; frequencyScratch[offset + frequencyRadius] = b >= 0 && b < descriptorCount ? descriptors[frame * descriptorCount + b] : 0; }
      timeScratch.sort(); frequencyScratch.sort();
      const harmonic = timeScratch[timeRadius], percussive = frequencyScratch[frequencyRadius];
      const mask = harmonic * harmonic / (harmonic * harmonic + percussive * percussive + 1e-20);
      const group = centers[bin] < boundaries[0] ? 0 : centers[bin] < boundaries[1] ? 1 : 2, index = frame * 3 + group, value = amplitude * amplitude;
      harmonics[index] += value * mask; percussives[index] += value * (1 - mask); groupPowers[index] += value;
    }
    if (!(frame & 7)) { const pause = checkpoint(); if (pause) await pause; }
  }
  for (let group = 0; group < 3; group++) {
    const histogram = new Uint32Array(histogramBins); let active = 0;
    for (let frame = 0; frame < frames; frame++) { const value = groupPowers[frame * 3 + group]; if (value > floorPower) { const bucket = Math.max(0, Math.min(histogramBins - 1, Math.floor((10 * Math.log10(value) - histogramLow) / (histogramHigh - histogramLow) * histogramBins))); histogram[bucket]++; active++; } if (!(frame & 255)) { const pause = checkpoint(); if (pause) await pause; } }
    const target = Math.ceil(active * .9); let bucket = 0, seen = 0;
    if (target) for (; bucket < histogramBins - 1; bucket++) { seen += histogram[bucket]; if (seen >= target) break; }
    hpssReferences[group] = 10 ** (Math.max(-36, histogramLow + (bucket + .5) / histogramBins * (histogramHigh - histogramLow)) / 20);
  }
  for (let frame = 0; frame < frames; frame++) {
    for (let group = 0; group < 3; group++) {
      const index = frame * 3 + group, h = normalizedPower(harmonics[index], hpssReferences[group]), p = normalizedPower(percussives[index], hpssReferences[group]);
      const previousH = frame ? harmonics[index - 3] : 0, previousP = frame ? percussives[index - 3] : 0, previousGlow = frame ? afterglows[index - 3] : 0;
      harmonics[index] = previousH + (h - previousH) * -Math.expm1(-step / (h > previousH ? .12 : .8));
      percussives[index] = p >= previousP ? p : previousP * Math.exp(-step / .12);
      const glow = Math.max(h, p);
      afterglows[index] = previousGlow + (glow - previousGlow) * -Math.expm1(-step / (glow > previousGlow ? .18 : 2.4));
    }
    if (!(frame & 31)) { const pause = checkpoint(); if (pause) await pause; }
  }

  checkAbort();
  const metadata = Object.freeze({ method: 'RMS-log-spectrum time/frequency median descriptors; not instrument stems', version: 1, timeWindowSeconds: (timeRadius * 2 + 1) * step, frequencyBins, boundaries: Object.freeze([...boundaries]), noiseFloorDb, maximumGainDb: 36, retainedArrayBytes: frames * 36, temporaryArrayBytes: groupPowers.byteLength + hpssReferences.byteLength + timeScratch.byteLength + frequencyScratch.byteLength + histogramBins * 4, preparationMs: clock() - startedAt, yields });
  return Object.freeze({ duration, step, frames, channels: 3, harmonic: harmonics, percussive: percussives, afterglow: afterglows, metadata, sample: spectralTextureSampler({ duration, step, frames, harmonics, percussives, afterglows }) });
}

function spectralTextureSampler({ duration, step, frames, harmonics, percussives, afterglows }) {
  const fields = ['harmonic', 'percussive', 'afterglow'], values = [harmonics, percussives, afterglows];
  return function sample(time, out = {}) {
    if (!out || typeof out !== 'object') throw new TypeError('sample output must be an object.');
    time = Number.isFinite(time) ? Math.max(0, Math.min(duration, time)) : time === Infinity ? duration : 0;
    const frame = Math.min(frames - 1, Math.floor(time / step)), next = Math.min(frames - 1, frame + 1), fraction = frame === next ? 0 : Math.max(0, Math.min(1, time / step - frame));
    for (let field = 0; field < fields.length; field++) { const name = fields[field]; if (!(out[name] instanceof Float32Array) || out[name].length < 3) out[name] = new Float32Array(3); for (let group = 0; group < 3; group++) { const a = values[field][frame * 3 + group], b = values[field][next * 3 + group]; out[name][group] = a + (b - a) * fraction; } }
    return out;
  };
}
