// Pick small, stable constellations from the existing star field once per resize.
// Runtime motion still comes from the same orbital coordinates as their stars.
export function createConstellationGraph(stars, { aspect = 1 } = {}) {
  if (!Array.isArray(stars) || stars.length > 40000 || !Number.isFinite(aspect) || aspect <= 0 || aspect > 10) throw new RangeError('Use a bounded star field and finite positive aspect ratio.');
  const anchors = [[.24,.23,0,0],[.74,.25,3,1],[.76,.69,5,2],[.22,.67,8,1]], groups = [], used = new Set();
  for (let id = 0; id < anchors.length; id++) {
    const [x,y,family,region] = anchors[id];
    const pool = [];
    for (let index = 0; index < stars.length; index++) {
      const star = stars[index];
      if (used.has(index) || star?.music !== family || !Number.isFinite(star.x) || !Number.isFinite(star.y)) continue;
      const distance = Math.hypot((star.x-x)*aspect,star.y-y);
      if (distance < .24) pool.push({index,score:distance*distance+.0008/(.1+Math.max(0,Math.min(2,Number(star.light)||0)))});
    }
    pool.sort((a,b)=>a.score-b.score||a.index-b.index);
    if(pool.length<4)continue;
    const selected = [], center = stars[pool[0].index];
    // A compact group stays legible. Spacing avoids nearly coincident vertices.
    for (const candidate of pool) {
      const star=stars[candidate.index];
      if(Math.hypot((star.x-center.x)*aspect,star.y-center.y)>.16)continue;
      if(selected.some(index=>Math.hypot((star.x-stars[index].x)*aspect,star.y-stars[index].y)<.025))continue;
      selected.push(candidate.index);if(selected.length===6)break;
    }
    if(selected.length<4)continue;
    // Deterministic minimum spanning tree: no dense mesh, crossing random chords,
    // instantaneous sorting by loudness, or IDs that change with musical activity.
    const connected=new Set([0]),edges=[];
    while(connected.size<selected.length){
      let best=null;
      for(const a of connected)for(let b=0;b<selected.length;b++)if(!connected.has(b)){
        const A=stars[selected[a]],B=stars[selected[b]],distance=((A.x-B.x)*aspect)**2+(A.y-B.y)**2;
        if(!best||distance<best.distance)best={a,b,distance};
      }
      edges.push(Object.freeze([best.a,best.b]));connected.add(best.b);
    }
    selected.forEach(index=>used.add(index));
    groups.push(Object.freeze({id,family,region,stars:Object.freeze(selected),edges:Object.freeze(edges)}));
  }
  return Object.freeze({version:1,groups:Object.freeze(groups)});
}
