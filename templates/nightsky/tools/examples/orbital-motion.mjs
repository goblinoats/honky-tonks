// Shared fixed-pole geometry for deterministic audio-driven celestial trails.
// phase is an accumulated angle, never a current band level multiplied by time.
export function orbitalPoint(seed, time, phase = 0, out = new Float32Array(2)) {
  const px = seed[0] + .16, py = seed[1] - .13;
  const radius2 = px * px + py * py;
  const rate = .006 * (.93 + .14 * seed[2]) / (1 + .05 * radius2);
  const angle = Math.max(0, time) * rate + phase;
  const c = Math.cos(angle), s = Math.sin(angle);
  out[0] = -.16 + c * px - s * py;
  out[1] = .13 + s * px + c * py;
  return out;
}

export function orbitalGLSL() {
  return `vec2 songOrbitalPoint(vec3 seed,float t,float phase){
    vec2 p=seed.xy-vec2(-.16,.13);
    float rate=.006*(.93+.14*seed.z)/(1.+.05*dot(p,p));
    float angle=max(0.,t)*rate+phase,c=cos(angle),s=sin(angle);
    return vec2(-.16,.13)+vec2(c*p.x-s*p.y,s*p.x+c*p.y);
  }`;
}
