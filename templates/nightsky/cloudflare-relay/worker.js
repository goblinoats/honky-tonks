import { DurableObject } from 'cloudflare:workers';
export const LIMITS = Object.freeze({connections:256,perIP:32,rooms:64,peers:32,payload:32768,outPayload:65536,buffered:131072,burst:120,perSecond:60,outBurst:131072,outPerSecond:65536});
const enc = new TextEncoder();
const text = (value, max, required = true) => typeof value === 'string' && (!required || value.length > 0) && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
// Rebuild only the shallow WebRTC wire fields; arbitrary peer-supplied trees never reach an encoder.
function signalPayload(p) {
  const object = v => v && typeof v === 'object' && !Array.isArray(v);
  const keys = (v, allowed) => Object.keys(v).every(k => allowed.includes(k));
  if (!object(p) || !keys(p,['sdp','candidate','tag','name'])) return null;
  const identity = {};
  for (const key of ['tag','name']) if (key in p) { if (!text(p[key],128,false)) return null; identity[key]=p[key]; }
  if (p.sdp && !('candidate' in p)) {
    const d=p.sdp;
    if (!object(d) || !keys(d,['type','sdp']) || !['offer','answer'].includes(d.type) || typeof d.sdp!=='string' || !d.sdp.length || d.sdp.length>24576) return null;
    return {sdp:{type:d.type,sdp:d.sdp},...identity};
  }
  if (p.candidate && !('sdp' in p)) {
    const c=p.candidate;
    if (!object(c) || !keys(c,['candidate','sdpMid','sdpMLineIndex','usernameFragment']) || !text(c.candidate,4096,false)) return null;
    const candidate={candidate:c.candidate};
    for (const key of ['sdpMid','usernameFragment']) if (key in c) { if(c[key]!==null && !text(c[key],256,false))return null; candidate[key]=c[key]; }
    if ('sdpMLineIndex' in c) { if(c.sdpMLineIndex!==null && (!Number.isInteger(c.sdpMLineIndex)||c.sdpMLineIndex<0||c.sdpMLineIndex>65535))return null;candidate.sdpMLineIndex=c.sdpMLineIndex; }
    return {candidate,...identity};
  }
  return null;
}

const rejected = (code=403) => new Response('Rejected', {status:code,headers:{'Cache-Control':'no-store'}});
function configuration(env) {
  if(typeof env.RELAY_TOKEN!=='string'||env.RELAY_TOKEN.length<32||env.RELAY_TOKEN.length>256||!/^[a-z0-9-]{8,64}$/.test(env.RELAY_NAMESPACE||''))return null;
  const origins=(env.RELAY_ALLOWED_ORIGINS||'').split(',').map(s=>s.trim()).filter(Boolean);
  if(!origins.length||!text(env.RELAY_AUTH_EPOCH,128))return null;
  return {origins,missing:env.RELAY_ALLOW_MISSING_ORIGIN==='true'};
}
async function equalSecret(a,b){const [x,y]=await Promise.all([a,b].map(s=>crypto.subtle.digest('SHA-256',enc.encode(s))));const xx=new Uint8Array(x),yy=new Uint8Array(y);let d=0;for(let i=0;i<32;i++)d|=xx[i]^yy[i];return d===0;}
function params(request){
  if(request.url.length>8192)return null;
  let u;try{u=new URL(request.url);}catch{return null;}
  if(u.pathname!=='/')return null;
  const q=u.searchParams,room=q.get('room'),id=q.get('id'),tag=q.get('tag')||'',name=q.get('name')||'';
  if(!/^(?:song|nightsky)-[a-z0-9]{1,64}$/.test(room||'')||!text(id,128)||!text(tag,128,false)||!text(name,128,false))return null;
  if(['room','id','tag','name','token'].some(k=>q.getAll(k).length>1))return null;
  return {room,id,tag,name,token:q.get('token')||''};
}
export default {async fetch(request,env){
  const u=new URL(request.url);
  if(request.method==='GET'&&u.pathname==='/health')return Response.json({ok:true},{headers:{'Cache-Control':'no-store'}});
  if(request.method!=='GET'||request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return rejected(400);
  const config=configuration(env),p=params(request);if(!config)return rejected(503);if(!p)return rejected(400);
  const origin=request.headers.get('Origin');if(origin===null?!config.missing:!config.origins.includes(origin))return rejected();
  if(!await equalSecret(p.token,env.RELAY_TOKEN))return rejected();
  // Namespace comes from operator configuration, NEVER from an untrusted room ID.
  return env.RELAY.get(env.RELAY.idFromName(env.RELAY_NAMESPACE)).fetch(request);
}};
export class Relay extends DurableObject {
  constructor(ctx,env){super(ctx,env);this.rooms=new Map();this.ips=new Map();this.sockets=new Map();this.generation=crypto.randomUUID();
    for(const ws of ctx.getWebSockets()){
      let a;try{a=ws.deserializeAttachment();}catch{this.close(ws,1011);continue;}
      if(ws.readyState!==1||!a||a.v!==1||!/^(?:song|nightsky)-[a-z0-9]{1,64}$/.test(a.room)||!text(a.id,128)||!text(a.ip,128)||!text(a.tag,128,false)||!text(a.name,128,false)||a.epoch!==env.RELAY_AUTH_EPOCH||!Number.isFinite(a.tokens)||!Number.isFinite(a.last)||!Number.isFinite(a.outTokens)||!Number.isFinite(a.outLast)||!Number.isFinite(a.controlTokens)||!Number.isFinite(a.controlLast)){this.close(ws,1011);continue;}
      if(this.rooms.get(a.room)?.has(a.id)){this.close(ws,1011);continue;}
      this.add(ws,a);
    }
  }
  add(ws,a){if(!this.rooms.has(a.room))this.rooms.set(a.room,new Map());this.rooms.get(a.room).set(a.id,ws);this.sockets.set(ws,a);this.ips.set(a.ip,(this.ips.get(a.ip)||0)+1);}
  close(ws,code=1008,reason='Rejected'){try{ws.close(code,reason);}catch{}this.remove(ws);}
  remove(ws){const a=this.sockets.get(ws);if(!a)return;this.sockets.delete(ws);const n=(this.ips.get(a.ip)||1)-1;if(n)this.ips.set(a.ip,n);else this.ips.delete(a.ip);const peers=this.rooms.get(a.room);if(peers?.get(a.id)!==ws)return;peers.delete(a.id);for(const p of [...peers.values()])if(!this.send(p,{type:'leave',id:a.id}))this.close(p,1013,'Membership delivery failed');if(!peers.size)this.rooms.delete(a.room);}
  send(ws,message){const a=this.sockets.get(ws);if(!a||ws.readyState!==1)return;let wire;try{wire=JSON.stringify(message);}catch{return;}
    const bytes=enc.encode(wire).length,now=Date.now(),control=['peers','join','leave'].includes(message.type),bucket=control?'controlTokens':'outTokens',last=control?'controlLast':'outLast';a[bucket]=Math.min(LIMITS.outBurst,a[bucket]+Math.max(0,now-a[last])*LIMITS.outPerSecond/1000);a[last]=now;
    // Runtime does not promise Node ws.bufferedAmount; bound traffic even where unavailable.
    if(bytes>LIMITS.outPayload||bytes>a[bucket]||(typeof ws.bufferedAmount==='number'&&ws.bufferedAmount>LIMITS.buffered)){return false;}
    a[bucket]-=bytes;ws.serializeAttachment(a);try{ws.send(wire);return true;}catch{this.close(ws,1011);return false;}
  }
  async fetch(request){
    if(request.method!=='GET'||request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return rejected(400);
    const p=params(request);if(!p)return rejected(400);
    // Defense in depth; direct Durable Object test/stub calls do not bypass auth.
    const config=configuration(this.env);if(!config||!await equalSecret(p.token,this.env.RELAY_TOKEN))return rejected();
    const origin=request.headers.get('Origin');if(origin===null?!config.missing:!config.origins.includes(origin))return rejected();
    const ip=request.headers.get('CF-Connecting-IP')||'unknown';if(!text(ip,128))return rejected(400);
    const peers=this.rooms.get(p.room);if(peers?.has(p.id))return rejected(409);
    if(this.sockets.size>=LIMITS.connections||(this.ips.get(ip)||0)>=LIMITS.perIP||(!peers&&this.rooms.size>=LIMITS.rooms)||(peers?.size||0)>=LIMITS.peers)return rejected(429);
    const [client,server]=Object.values(new WebSocketPair()),now=Date.now();const a={v:1,epoch:this.env.RELAY_AUTH_EPOCH,room:p.room,id:p.id,tag:p.tag,name:p.name,ip,tokens:LIMITS.burst,last:now,outTokens:LIMITS.outBurst,outLast:now,controlTokens:LIMITS.outBurst,controlLast:now};
    this.ctx.acceptWebSocket(server);server.serializeAttachment(a);this.add(server,a);
    const welcomed=this.send(server,{type:'peers',peers:[...(peers||[])].filter(([id])=>id!==p.id).map(([id,ws])=>{const b=this.sockets.get(ws);return{id,tag:b.tag,name:b.name};})});
    if(!welcomed){this.close(server,1013);return new Response(null,{status:101,webSocket:client});}
    for(const [id,ws]of this.rooms.get(p.room))if(id!==p.id&&!this.send(ws,{type:'join',peer:{id:p.id,tag:p.tag,name:p.name}}))this.close(ws,1013,'Membership delivery failed');
    return new Response(null,{status:101,webSocket:client});
  }
  webSocketMessage(ws,data){const a=this.sockets.get(ws);if(!a)return this.close(ws,1011);const now=Date.now();a.tokens=Math.min(LIMITS.burst,a.tokens+Math.max(0,now-a.last)*LIMITS.perSecond/1000);a.last=now;
    if(--a.tokens<0)return this.close(ws,1008,'Rate limit');ws.serializeAttachment(a);
    if(typeof data!=='string')return this.close(ws,1003,'Text JSON required');if(data.length>LIMITS.payload||enc.encode(data).length>LIMITS.payload)return this.close(ws,1009,'Message too large');
    let m;try{m=JSON.parse(data);}catch{return this.close(ws,1008,'Invalid JSON');}
    if(!m||typeof m!=='object'||Array.isArray(m))return this.close(ws,1008,'Object required');
    if(m.type==='ping'&&Number.isFinite(m.t))return this.send(ws,{type:'pong',t:m.t,now});
    if(m.type!=='signal'||!text(m.to,128))return this.close(ws,1008,'Invalid message');const payload=signalPayload(m.payload);if(!payload)return this.close(ws,1008,'Invalid signal');
    const target=this.rooms.get(a.room)?.get(m.to);if(target&&!this.send(target,{type:'signal',from:a.id,payload}))this.close(ws,1008,'Recipient budget exceeded');
  }
  webSocketClose(ws,code,reason){try{ws.close(code===1005?1000:code,reason);}catch{}this.remove(ws);}
  webSocketError(ws){this.close(ws,1011);}
}
