// Recurring nonnegative spectral patterns, not instruments or separated stems.
// A bounded whole-track fit produces fixed bases; every frame is projected
// independently so seeking and repeated phrases do not depend on playback history.
const spectralMotifStates = new WeakMap();

export async function createSpectralMotifs(input, { signal, yieldTask, components = 4 } = {}) {
  const { data, frames, channels, step, centers, duration } = input || {};
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  const maxFrames = 57601, maxFitFrames = 2048, fitIterations = 36, projectionSweeps = 24;
  if (!Number.isInteger(frames) || frames < 1 || frames > maxFrames || channels !== 32 || !data || data.length !== frames * channels) throw new RangeError('Motifs require 1–57,601 frames of 32 time-major RMS channels.');
  if (!Number.isInteger(components) || components < 4 || components > 8) throw new RangeError('Motif components must be an integer from 4 to 8.');
  if (!finite(step) || step <= 0 || step > 1 || !finite(duration) || duration < 0 || duration > 7200 || (frames > 1 && (duration > (frames - 1) * step + 1e-7 || duration < (frames - 2) * step - 1e-7)) || (frames === 1 && duration > step)) throw new RangeError('Motif duration must fit its sample grid with at most one padded endpoint.');
  if (!centers || centers.length !== channels || [...centers].some(value => !finite(value) || value <= 0) || new Set(centers).size !== channels) throw new TypeError('Pass 32 distinct positive frequency centres.');
  if (yieldTask !== undefined && typeof yieldTask !== 'function') throw new TypeError('yieldTask must return a task-boundary promise.');
  const clock = () => globalThis.performance?.now?.() ?? Date.now();
  const yieldBoundary = yieldTask || (() => new Promise(resolve => setTimeout(resolve, 0)));
  const abort = () => { if (signal?.aborted) { const error = new Error('Spectral motif analysis aborted.'); error.name = 'AbortError'; throw error; } };
  let lastYield = clock(), yields = 0, longestSliceMs = 0;
  const checkpoint = () => {
    abort(); const elapsed = clock() - lastYield; longestSliceMs = Math.max(longestSliceMs, elapsed);
    if (elapsed < 5) return null;
    return Promise.resolve(yieldBoundary()).then(() => { abort(); yields++; lastYield = clock(); });
  };
  abort(); await yieldBoundary(); abort(); yields++; lastYield = clock();
  // Canonicalise columns once. Permuting input columns with their centres cannot
  // exchange motif identities or alter a fit's arithmetic order.
  const order = Array.from({length:channels},(_,index)=>index).sort((a,b)=>centers[a]-centers[b]);
  const orderedCenters = order.map(index=>centers[index]);
  const kCount = components, epsilon = 1e-12, floor = 10 ** (-68 / 20), gateTop = 10 ** (-48 / 20);
  const norms = new Float64Array(frames), gates = new Float32Array(frames), active = [];
  for (let frame = 0; frame < frames; frame++) {
    let square = 0, maximum = 0;
    for (let channel = 0; channel < channels; channel++) {
      const value = data[frame * channels + order[channel]];
      if (!finite(value) || value < 0 || value > 4) throw new TypeError('RMS descriptors must be finite values between 0 and 4.');
      maximum = Math.max(maximum,value); if (value > floor) square += value*value;
    }
    norms[frame] = Math.sqrt(square);
    // A second absolute guard protects direct users of this module too. Weak
    // above-floor noise remains weak even if it is the only pattern in a track.
    gates[frame] = maximum <= floor ? 0 : maximum >= gateTop ? 1 : ((20*Math.log10(maximum)+68)/20) ** 2;
    if (norms[frame] > epsilon && gates[frame] > 0) active.push(frame);
    if (!(frame & 31)) { const pause=checkpoint();if(pause)await pause; }
  }
  const fitFrames = Math.min(active.length,maxFitFrames);
  const training = new Float64Array(fitFrames * channels);
  for (let row = 0; row < fitFrames; row++) {
    const frame = active[Math.floor((row+.5)*active.length/fitFrames)], norm=norms[frame];
    for(let channel=0;channel<channels;channel++){const value=data[frame*channels+order[channel]];training[row*channels+channel]=value>floor?value/norm:0;}
    if (!(row & 31)) { const pause=checkpoint();if(pause)await pause; }
  }
  // Canonical row traversal removes time-order-dependent labels on fits that
  // contain the same frames. The capped fit remains stratified in track time.
  const rows=Array.from({length:fitFrames},(_,index)=>index).sort((a,b)=>{
    for(let channel=0;channel<channels;channel++){const difference=training[a*channels+channel]-training[b*channels+channel];if(difference)return difference;}
    return 0;
  });
  const basis=new Float64Array(kCount*channels), fitH=new Float64Array(fitFrames*kCount), gram=new Float64Array(kCount*kCount);
  const dot=new Float64Array(kCount), activation=new Float64Array(kCount), vector=new Float64Array(channels);
  const refreshGram=()=>{for(let k=0;k<kCount;k++)for(let j=0;j<kCount;j++){let value=0;for(let c=0;c<channels;c++)value+=basis[k*channels+c]*basis[j*channels+c];gram[k*kCount+j]=value;}};
  const solve=(values,offset,out,outOffset,sweeps)=>{
    for(let k=0;k<kCount;k++){let value=0;for(let c=0;c<channels;c++)value+=values[offset+c]*basis[k*channels+c];dot[k]=value;}
    for(let sweep=0;sweep<sweeps;sweep++)for(let k=0;k<kCount;k++){
      const diagonal=gram[k*kCount+k];if(diagonal<epsilon){out[outOffset+k]=0;continue;}
      let residual=dot[k];for(let j=0;j<kCount;j++)residual-=gram[k*kCount+j]*out[outOffset+j];
      out[outOffset+k]=Math.max(0,out[outOffset+k]+residual/diagonal);
    }
  };
  // Deterministic farthest-frame initialisation has no random state to seed.
  // Repeated identical patterns leave surplus components inactive, rather than
  // inventing additional motifs merely to fill the requested component count.
  const closest = new Float64Array(fitFrames);closest.fill(Infinity);
  for(let k=0;k<kCount&&fitFrames;k++){
    let chosen=rows[0],distance=-1;
    for(const row of rows){if(closest[row]>distance){chosen=row;distance=closest[row];}}
    if(k&&distance<1e-8)break;
    basis.set(training.subarray(chosen*channels,(chosen+1)*channels),k*channels);
    for(let index=0;index<rows.length;index++){
      const row=rows[index];let square=0;for(let c=0;c<channels;c++){const delta=training[row*channels+c]-basis[k*channels+c];square+=delta*delta;}closest[row]=Math.min(closest[row],square);
      if(!(index&31)){const pause=checkpoint();if(pause)await pause;}
    }
  }
  refreshGram();
  const covariance=new Float64Array(kCount*kCount), numerator=new Float64Array(kCount*channels);
  const reconstructionError=async()=>{
    let error=0,total=0;
    for(let index=0;index<rows.length;index++){
      const row=rows[index];for(let c=0;c<channels;c++){let predicted=0;for(let k=0;k<kCount;k++)predicted+=fitH[row*kCount+k]*basis[k*channels+c];const value=training[row*channels+c];error+=(predicted-value)**2;total+=value*value;}
      if(!(index&15)){const pause=checkpoint();if(pause)await pause;}
    }
    return total?Math.sqrt(error/total):0;
  };
  for(let index=0;index<rows.length;index++){const row=rows[index];solve(training,row*channels,fitH,row*kCount,projectionSweeps);if(!(index&15)){const pause=checkpoint();if(pause)await pause;}}
  const initialError=await reconstructionError();
  for(let iteration=0;iteration<fitIterations&&fitFrames;iteration++){
    refreshGram();covariance.fill(0);numerator.fill(0);
    for(let index=0;index<rows.length;index++){
      const row=rows[index],offset=row*kCount;solve(training,row*channels,fitH,offset,4);
      for(let k=0;k<kCount;k++){
        const h=fitH[offset+k];for(let j=0;j<kCount;j++)covariance[k*kCount+j]+=h*fitH[offset+j];
        for(let c=0;c<channels;c++)numerator[k*channels+c]+=h*training[row*channels+c];
      }
      if(!(index&15)){const pause=checkpoint();if(pause)await pause;}
    }
    for(let k=0;k<kCount;k++){
      const diagonal=covariance[k*kCount+k];if(diagonal<epsilon)continue;
      for(let c=0;c<channels;c++){let residual=numerator[k*channels+c];for(let j=0;j<kCount;j++)residual-=covariance[k*kCount+j]*basis[j*channels+c];basis[k*channels+c]=Math.max(0,basis[k*channels+c]+residual/diagonal);}
      const pause=checkpoint();if(pause)await pause;
    }
    // Rescale factors without changing their reconstruction.
    for(let k=0;k<kCount;k++){
      let square=0;for(let c=0;c<channels;c++)square+=basis[k*channels+c]**2;const norm=Math.sqrt(square);if(norm<epsilon)continue;
      for(let c=0;c<channels;c++)basis[k*channels+c]/=norm;
      for(let row=0;row<fitFrames;row++)fitH[row*kCount+k]*=norm;
    }
    const pause=checkpoint();if(pause)await pause;
  }
  refreshGram();
  for(let index=0;index<rows.length;index++){const row=rows[index];solve(training,row*channels,fitH,row*kCount,projectionSweeps);if(!(index&15)){const pause=checkpoint();if(pause)await pause;}}
  const finalError=await reconstructionError();
  const mean=new Float64Array(channels);let baselineSquare=0;
  for(let index=0;index<rows.length;index++){
    const row=rows[index];for(let c=0;c<channels;c++)mean[c]+=training[row*channels+c]/(fitFrames||1);
    if(!(index&31)){const pause=checkpoint();if(pause)await pause;}
  }
  for(let index=0;index<rows.length;index++){
    const row=rows[index];for(let c=0;c<channels;c++)baselineSquare+=(training[row*channels+c]-mean[c])**2;
    if(!(index&31)){const pause=checkpoint();if(pause)await pause;}
  }
  const centroid=k=>{let sum=0,weighted=0;for(let c=0;c<channels;c++){const weight=basis[k*channels+c]**2;sum+=weight;weighted+=weight*Math.log(orderedCenters[c]);}return sum>epsilon?Math.exp(weighted/sum):Infinity;};
  const identities=Array.from({length:kCount},(_,k)=>k).sort((a,b)=>centroid(a)-centroid(b)||a-b);
  const sortedBasis=new Float64Array(basis.length);identities.forEach((old,k)=>sortedBasis.set(basis.subarray(old*channels,(old+1)*channels),k*channels));basis.set(sortedBasis);refreshGram();
  const values=new Float32Array(frames*kCount), integrals=new Float64Array(frames*kCount);
  const bins=256, histograms=new Uint32Array(kCount*bins), counts=new Uint32Array(kCount);
  let projectionSquare=0,sourceSquare=0;
  for(let frame=0;frame<frames;frame++){
    activation.fill(0);
    if(gates[frame]>0){
      for(let c=0;c<channels;c++){const value=data[frame*channels+order[c]];vector[c]=value>floor?value*gates[frame]:0;}
      solve(vector,0,activation,0,projectionSweeps);
      for(let c=0;c<channels;c++){let predicted=0;for(let k=0;k<kCount;k++)predicted+=activation[k]*basis[k*channels+c];projectionSquare+=(predicted-vector[c])**2;sourceSquare+=vector[c]**2;}
    }
    for(let k=0;k<kCount;k++){
      const value=activation[k];values[frame*kCount+k]=value;
      if(value>floor){const bucket=Math.max(0,Math.min(bins-1,Math.floor((20*Math.log10(value)+90)/120*bins)));histograms[k*bins+bucket]++;counts[k]++;}
    }
    if(!(frame&7)){const pause=checkpoint();if(pause)await pause;}
  }
  const references=new Float64Array(kCount);
  for(let k=0;k<kCount;k++){
    const target=Math.ceil(counts[k]*.9);let seen=0,bucket=0;
    if(target)for(;bucket<bins-1;bucket++){seen+=histograms[k*bins+bucket];if(seen>=target)break;}
    references[k]=Math.max(1/16,10**((-90+(bucket+.5)*120/bins)/20));
  }
  for(let frame=0;frame<frames;frame++){
    for(let k=0;k<kCount;k++){
      const offset=frame*kCount+k;values[offset]=Math.min(1,values[offset]/references[k]);
      if(frame)integrals[offset]=integrals[offset-kCount]+(values[offset-kCount]+values[offset])*.5*step;
    }
    if(!(frame&127)){const pause=checkpoint();if(pause)await pause;}
  }
  abort();
  const publicBases=Object.freeze(Array.from({length:kCount},(_,k)=>Object.freeze(Array.from(basis.subarray(k*channels,(k+1)*channels)))));
  const centroids=Object.freeze(Array.from({length:kCount},(_,k)=>{const hz=centroid(k);return Number.isFinite(hz)?hz:null;}));
  const metadata=Object.freeze({method:'bounded nonnegative least squares factorisation',version:1,initialization:'deterministic farthest-frame; no RNG',fitFrames,fitIterations:fitFrames?fitIterations:0,projectionSweeps,initialRelativeError:initialError,fitRelativeError:finalError,meanSpectrumRelativeError:fitFrames?Math.sqrt(baselineSquare/fitFrames):0,projectionRelativeError:sourceSquare?Math.sqrt(projectionSquare/sourceSquare):0,effectiveComponents:centroids.filter(value=>value!==null).length,centroids,coefficientReferences:Object.freeze(Array.from(references)),maximumGain:16,noiseFloorDb:-68,fullGateDb:-48,retainedArrayBytes:values.byteLength+integrals.byteLength,limits:Object.freeze({maxFrames,maxFitFrames,maxComponents:8,maximumDuration:7200}),yields,longestSliceMs});
  return registerSpectralMotifs({duration,step,frames,components:kCount,channels,centers:Object.freeze(orderedCenters),bases:publicBases,metadata,values,integrals});
}

// Cache export must preserve the private double-precision prefix integrals;
// sampling the public Float32 outputs cannot reconstruct them losslessly.
export function getSpectralMotifState(timeline) {
  const state = spectralMotifStates.get(timeline);
  return state ? copySpectralMotifState(state, false) : null;
}

export function restoreSpectralMotifs(state) {
  if (!state || typeof state !== 'object') throw new TypeError('Pass a spectral motif state.');
  const { duration, step, frames, components, channels, centers, bases, metadata, values, integrals } = state;
  if (!Number.isInteger(frames) || frames < 1 || frames > 57601 || !Number.isInteger(components) || components < 4 || components > 8 || channels !== 32) throw new RangeError('Invalid spectral motif state dimensions.');
  if (!Number.isFinite(step) || step <= 0 || step > 1 || !Number.isFinite(duration) || duration < 0 || duration > 7200 || (frames > 1 && (duration > (frames - 1) * step + 1e-7 || duration < (frames - 2) * step - 1e-7)) || (frames === 1 && duration > step)) throw new RangeError('Motif duration must fit its sample grid with at most one padded endpoint.');
  if (!(values instanceof Float32Array) || !(integrals instanceof Float64Array) || values.length !== frames * components || integrals.length !== frames * components) throw new TypeError('Motif state requires Float32 values and Float64 integrals matching its dimensions.');
  if (!Array.isArray(centers) || centers.length !== channels || centers.some((value, index) => !Number.isFinite(value) || value <= 0 || (index > 0 && value <= centers[index - 1]))) throw new TypeError('Motif state requires ordered positive frequency centres.');
  if (!Array.isArray(bases) || bases.length !== components || bases.some(row => !Array.isArray(row) || row.length !== channels || row.some(value => !Number.isFinite(value) || value < 0))) throw new TypeError('Motif state requires finite nonnegative bases matching its dimensions.');
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata) || !Array.isArray(metadata.centroids) || metadata.centroids.length !== components || !Array.isArray(metadata.coefficientReferences) || metadata.coefficientReferences.length !== components || !metadata.limits || typeof metadata.limits !== 'object' || Array.isArray(metadata.limits)) throw new TypeError('Motif state metadata must match its components.');
  for (let index = 0; index < values.length; index++) {
    if (!Number.isFinite(values[index]) || values[index] < 0 || values[index] > 1 || !Number.isFinite(integrals[index]) || integrals[index] < 0) throw new TypeError('Motif state timelines must contain finite normalized values and nonnegative integrals.');
  }
  return registerSpectralMotifs(copySpectralMotifState(state, true));
}

function copySpectralMotifState(state, freeze) {
  const { duration, step, frames, components, channels } = state;
  const centers = state.centers.slice(), bases = state.bases.map(row => freeze ? Object.freeze(row.slice()) : row.slice());
  const metadata = copySpectralMotifMetadata(state.metadata, freeze);
  return {duration, step, frames, components, channels, centers:freeze ? Object.freeze(centers) : centers, bases:freeze ? Object.freeze(bases) : bases, metadata, values:new Float32Array(state.values), integrals:new Float64Array(state.integrals)};
}

function copySpectralMotifMetadata(value, freeze, seen = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
  if (!value || typeof value !== 'object' || (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) || seen.has(value)) throw new TypeError('Motif metadata must contain acyclic plain data.');
  seen.add(value);
  const copy = Array.isArray(value) ? value.map(item => copySpectralMotifMetadata(item, freeze, seen)) : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, copySpectralMotifMetadata(item, freeze, seen)]));
  seen.delete(value);
  return freeze ? Object.freeze(copy) : copy;
}

function registerSpectralMotifs(state) {
  const { duration, step, frames, components, channels, centers, bases, metadata, values, integrals } = state;
  const sample = spectralMotifSampler(values, integrals, frames, components, step, duration);
  const timeline = Object.freeze({duration, step, frames, components, channels, centers, bases, metadata, sample});
  // Only final sampling arrays and public descriptors survive construction.
  spectralMotifStates.set(timeline, state);
  return timeline;
}

// Separate closure scope: the returned sampler retains only its two timelines,
// not the training spectra or solver scratch arrays from construction.
function spectralMotifSampler(values,integrals,frames,kCount,step,duration) {
  return (time,out={})=>{
    const t=Number.isFinite(time)?Math.max(0,Math.min(duration,time)):0;
    if(!(out.values instanceof Float32Array)||out.values.length!==kCount)out.values=new Float32Array(kCount);
    if(!(out.integrals instanceof Float32Array)||out.integrals.length!==kCount)out.integrals=new Float32Array(kCount);
    const index=Math.min(frames-1,Math.floor(t/step)),next=Math.min(frames-1,index+1),elapsed=t-index*step,fraction=next===index?0:elapsed/step;
    for(let k=0;k<kCount;k++){
      const offset=index*kCount+k,a=values[offset],delta=values[next*kCount+k]-a;
      out.values[k]=a+delta*fraction;
      out.integrals[k]=integrals[offset]+a*elapsed+(next===index?0:.5*delta*elapsed*elapsed/step);
    }
    return out;
  };
}
