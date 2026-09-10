// Reusable examples for the actual Song Kit v1 API. No automatic playback changes.
const clamp = (value, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const number = value => Number.isFinite(value) ? value : 0;

// dt and both time constants are seconds. Each call creates independent state.
export function smoothEnvelope({ attack = .12, release = .8 } = {}) {
  if (!(attack > 0) || !(release > 0)) throw new RangeError('Envelope times must be positive seconds.');
  let value = 0;
  return (target, dt) => {
    target = clamp(number(target));
    const time = target > value ? attack : release;
    value += (target - value) * (1 - Math.exp(-Math.max(0, number(dt)) / time));
    return value;
  };
}

// Every function has Analysis.use's exact signature: (features, dtSeconds) => value.
export function createAudioModules() {
  const bass = smoothEnvelope({ attack: .15, release: 1.1 });
  const transient = smoothEnvelope({ attack: .025, release: .28 });
  const mids = smoothEnvelope({ attack: .25, release: .75 });
  const brightness = smoothEnvelope({ attack: .2, release: .9 });
  return {
    bassSwell: (f, dt) => bass(number(f.bands?.bass) * 1.35, dt),
    transient: (f, dt) => transient(Math.max(number(f.flux) * 7, f.beat ? .7 : 0), dt),
    midEnergy: (f, dt) => mids(number(f.bands?.mid) * 1.3, dt),
    brightness: (f, dt) => brightness(number(f.rms) > .003 ? (number(f.centroidHz) - 200) / 7800 : 0, dt),
  };
}

// Multiple visuals can share one namespace without installing duplicate processors.
// Reserve that namespace for these examples; use a different one for other plugins.
// Share ownership when a local ES-module consumer and the bundled kit coexist.
const installationKey = Symbol.for('song.audio-modules.installations.v1');
export function installAudioModules(analysis, namespace = 'night') {
  if (!analysis || typeof analysis.use !== 'function') throw new TypeError('Pass a Song.Analysis instance.');
  if (typeof namespace !== 'string' || !namespace) throw new TypeError('Choose a nonempty plugin namespace.');
  let groups = analysis[installationKey];
  if (!groups) { groups = new Map(); Object.defineProperty(analysis, installationKey, { value: groups, configurable: true }); }
  let group = groups.get(namespace);
  if (!group) {
    const modules = createAudioModules();
    const keys = Object.fromEntries(Object.keys(modules).map(name => [name, `${namespace}.${name}`]));
    const off = Object.entries(modules).map(([name, process]) => analysis.use(keys[name], process));
    group = { keys: Object.freeze(keys), off, references: 0 }; groups.set(namespace, group);
  }
  group.references++;
  let disposed = false;
  return {
    keys: group.keys,
    dispose() {
      if (disposed) return; disposed = true;
      if (--group.references) return;
      for (const remove of group.off) remove();
      groups.delete(namespace); if (!groups.size) delete analysis[installationKey];
    },
  };
}

// Call from a connected custom element; call the returned function on disconnect.
// render receives a frame-local view. Copy waveform/spectrum if retaining a history.
export function connectAudioVisual(element, render, { namespace = 'night' } = {}) {
  if (!element?.isConnected) throw new Error('Connect the visual to its room before binding audio.');
  if (typeof render !== 'function') throw new TypeError('A render callback is required.');
  let disposed = false, room = null, current = null, installation = null;
  const doc = element.ownerDocument, view = doc.defaultView || globalThis;
  const motion = view.matchMedia?.('(prefers-reduced-motion: reduce)');
  const dispose = () => {
    if (disposed) return; disposed = true;
    doc.removeEventListener('song-kit-ready', bind);
    room?.target.removeEventListener('song-tick', tick);
    motion?.removeEventListener?.('change', motionChanged);
    installation?.dispose(); installation = null; current = null;
  };
  const paint = frame => {
    if (disposed || !element.isConnected || !frame?.features) return;
    const analysis = room.target.querySelector('song-player')?.analysis;
    if (analysis !== current) {
      installation?.dispose(); installation = null; current = analysis;
      if (analysis) installation = installAudioModules(analysis, namespace);
    }
    const signals = { bassSwell: 0, transient: 0, midEnergy: 0, brightness: 0 };
    for (const [name, key] of Object.entries(installation?.keys || {})) signals[name] = number(frame.features.custom?.[key]);
    try { render({ frame, signals, reducedMotion: !!motion?.matches }); }
    catch (error) { dispose(); console.warn('Audio visual disconnected after render error:', error); }
  };
  const tick = event => paint(event.detail);
  const motionChanged = () => { if (room?.audio) paint(room.audio); };
  function bind() {
    if (disposed || room || !element.isConnected || !view.Song) return;
    room = view.Song.room(element);
    room.target.addEventListener('song-tick', tick);
    motion?.addEventListener?.('change', motionChanged);
    if (room.audio) paint(room.audio);
  }
  if (view.Song) bind(); else doc.addEventListener('song-kit-ready', bind, { once: true });
  return dispose;
}

// An optional graph for a source YOUR remix owns. This never connects to song-player.
// The caller explicitly supplies an output. Silence until a source connects to input.
export function createProcessingChain(Song, context, output, { level = .25, frequency = 12000, pan = 0, delay = 0 } = {}) {
  if (!Song?.effects || !context || !output) throw new TypeError('Pass Song, an AudioContext, and an explicit output node.');
  const input = Song.effects.gain(context, 1);
  const filter = Song.effects.filter(context, 'lowpass', clamp(number(frequency), 20, context.sampleRate / 2), .7);
  const balance = Song.effects.pan(context, number(pan));
  const echo = delay > 0 ? Song.effects.delay(context, clamp(number(delay), 0, 2)) : null;
  const gain = Song.effects.gain(context, clamp(number(level), 0, .8));
  const nodes = [filter, balance, ...(echo ? [echo] : []), gain];
  const disconnect = Song.effects.chain(input, nodes, output);
  let disposed = false;
  return {
    input, nodes: { filter, balance, delay: echo, gain },
    setLevel(next) {
      if (disposed || !Number.isFinite(next)) return;
      gain.gain.setTargetAtTime(clamp(next, 0, .8), context.currentTime, .03);
    },
    dispose() { if (disposed) return; disposed = true; disconnect(); },
  };
}

// Shared numeric coefficients for the JavaScript path and its generated GLSL source.
// Coordinates are centered on the viewport and measured in viewport-height units.
const songFlow = Object.freeze({
  poleX: -.16, poleY: .13, rate: .028, depthBase: .55, depthRange: .55,
  differential: .35, radiusPhase: 2.4, anglePhaseRate: .09,
  shearXFrequency: 3.4, shearYFrequency: 4.2, shearXRate: .055, shearYRate: -.037,
  shearYScale: .8, shearYPhase: 1.3, driftXRate: .047, driftYRate: .033,
  tau: Math.PI * 2,
});

// vec4: angular displacement, shear amplitude, pole translation, trail seconds.
// Music changes geometry, never the coefficient multiplying playback time.
export function flowControls(signals = {}, out = new Float32Array(4)) {
  const bass = clamp(number(signals.bassSwell)), mid = clamp(number(signals.midEnergy));
  const brightness = clamp(number(signals.brightness)), transient = clamp(number(signals.transient));
  out[0] = .015 + .085 * mid + .045 * bass + .005 * transient;
  out[1] = .025 + .055 * bass + .035 * mid;
  out[2] = .005 + .015 * bass + .008 * brightness;
  out[3] = 5 + 6 * mid + 2 * brightness + transient;
  return out;
}

// seed=[x,y,depth,phase], depth and phase are 0–1. Every evaluation is history-free.
// Passing t-age yields a coherent trail under the same current geometry controls.
export function flowPath(seed, playbackSeconds, controls, out = new Float32Array(2)) {
  const c = songFlow, time = Math.max(0, number(playbackSeconds));
  const x = clamp(number(seed?.[0]), -4, 4) - c.poleX;
  const y = clamp(number(seed?.[1]), -4, 4) - c.poleY;
  const depth = clamp(number(seed?.[2])), phase = clamp(number(seed?.[3])) * c.tau;
  const angleAmount = clamp(number(controls?.[0]), 0, .3);
  const shear = clamp(number(controls?.[1]), 0, .18), drift = clamp(number(controls?.[2]), 0, .08);
  const radiusSquared = x * x + y * y;
  const rate = c.rate * (c.depthBase + c.depthRange * depth) / (1 + c.differential * radiusSquared);
  const angle = time * rate + angleAmount * Math.sin(phase + Math.sqrt(radiusSquared) * c.radiusPhase + time * c.anglePhaseRate);
  const cosine = Math.cos(angle), sine = Math.sin(angle);
  let px = cosine * x - sine * y, py = sine * x + cosine * y;
  // Sequential sinusoidal shears. Each shear is area-preserving for fixed parameters.
  px += shear * Math.sin(c.shearXFrequency * py + time * c.shearXRate + phase);
  py += c.shearYScale * shear * Math.sin(c.shearYFrequency * px + time * c.shearYRate + c.shearYPhase * phase);
  out[0] = px + c.poleX + drift * Math.sin(time * c.driftXRate + phase);
  out[1] = py + c.poleY + drift * Math.cos(time * c.driftYRate + phase);
  return out;
}

// Include once in a WebGL1/2 shader; the host shader supplies floating-point precision.
// This function intentionally contains no randomness, frame delta, integration or uniforms.
export function flowGLSL() {
  const c = Object.fromEntries(Object.entries(songFlow).map(([name, value]) => [name, value.toFixed(12)]));
  return `
#ifndef SONG_FLOW_PATH_V1
#define SONG_FLOW_PATH_V1
vec2 songFlowPath(vec4 seed, float songTime, vec4 controls) {
  float t=max(0.0,songTime);
  vec2 pole=vec2(${c.poleX},${c.poleY});
  vec2 p=clamp(seed.xy,vec2(-4.0),vec2(4.0))-pole;
  float depth=clamp(seed.z,0.0,1.0);
  float phase=clamp(seed.w,0.0,1.0)*${c.tau};
  float angleAmount=clamp(controls.x,0.0,0.3);
  float shear=clamp(controls.y,0.0,0.18);
  float drift=clamp(controls.z,0.0,0.08);
  float radiusSquared=dot(p,p);
  float rate=${c.rate}*(${c.depthBase}+${c.depthRange}*depth)/(1.0+${c.differential}*radiusSquared);
  float angle=t*rate+angleAmount*sin(phase+sqrt(radiusSquared)*${c.radiusPhase}+t*${c.anglePhaseRate});
  float cosine=cos(angle),sine=sin(angle);
  p=vec2(cosine*p.x-sine*p.y,sine*p.x+cosine*p.y);
  p.x+=shear*sin(${c.shearXFrequency}*p.y+t*${c.shearXRate}+phase);
  p.y+=${c.shearYScale}*shear*sin(${c.shearYFrequency}*p.x+t*${c.shearYRate}+${c.shearYPhase}*phase);
  return p+pole+drift*vec2(sin(t*${c.driftXRate}+phase),cos(t*${c.driftYRate}+phase));
}
#endif`;
}
