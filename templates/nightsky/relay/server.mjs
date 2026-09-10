#!/usr/bin/env node
// Ephemeral WebRTC signalling only. Reverse-proxy TLS; never log capability tokens.
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer } from 'ws';

export function configFromEnv(env = process.env, positionalPort) {
  const list = key => (env[key] || '').split(',').map(s => s.trim()).filter(Boolean);
  const config = { host: env.HOST || '127.0.0.1', port: Number(positionalPort ?? env.PORT ?? 8787),
    token: env.RELAY_TOKEN || '', allowedRooms: list('RELAY_ALLOWED_ROOMS'), allowedOrigins: list('RELAY_ALLOWED_ORIGINS'),
    allowMissingOrigin: env.RELAY_ALLOW_MISSING_ORIGIN === 'true' };
  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) throw new Error('Invalid PORT');
  const production = env.NODE_ENV === 'production';
  if (production && (config.token.length < 32 || !config.allowedRooms.length)) throw new Error('Production requires RELAY_TOKEN (32+ characters) and RELAY_ALLOWED_ROOMS');
  if (!['127.0.0.1','::1','localhost'].includes(config.host) && !production) throw new Error('Public binding requires production protections');
  return config;
}
const text = (value, max, required = true) => typeof value === 'string' && (!required || value.length > 0) && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
const sameToken = (a,b) => { const aa=Buffer.from(a),bb=Buffer.from(b);return aa.length===bb.length && timingSafeEqual(aa,bb); };
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
export function createRelay(config = configFromEnv(), limits = {}) {
  const L = { connections:256, perIP:32, rooms:64, peers:32, payload:32768, buffered:131072, burst:120, perSecond:60, heartbeatMs:30000, ...limits };
  const rooms = new Map(), ips = new Map();
  const server = http.createServer((req,res) => {
    if (req.url === '/health') { res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{"ok":true}');return; }
    res.writeHead(200,{'Content-Type':'text/plain'});res.end('song signalling relay\n');
  });
  server.headersTimeout=10000;server.requestTimeout=10000;server.keepAliveTimeout=5000;
  server.maxConnections=L.connections + 32;
  const wss = new WebSocketServer({ noServer:true, maxPayload:L.payload, perMessageDeflate:false });
  let stopping=false;
  const sendWire = (socket, encoded) => {
    if (socket.readyState !== 1) return;
    if (socket.bufferedAmount > L.buffered) { socket.terminate();return; }
    try { socket.send(encoded, error => { if(error)socket.terminate(); }); } catch { socket.terminate(); }
  };
  const send = (socket, message) => {
    let encoded;try { encoded=JSON.stringify(message); }catch { return false; }
    sendWire(socket,encoded);return true;
  };
  server.on('upgrade',(req,socket,head) => {
    socket.on('error',()=>{});
    const reject = (code=403) => { socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`); };
    if(stopping)return reject(503);
    let u;try { if(!req.url?.startsWith('/') || req.url.length>8192)throw Error();u=new URL(req.url,'http://relay.local'); }catch{return reject(400);}
    const room=u.searchParams.get('room'),id=u.searchParams.get('id'),tag=u.searchParams.get('tag')||'',name=u.searchParams.get('name')||'';
    if(!text(room,128)||!text(id,128)||!text(tag,128,false)||!text(name,128,false))return reject(400);
    if(config.token && !sameToken(u.searchParams.get('token')||'',config.token))return reject();
    if(config.allowedRooms?.length && !config.allowedRooms.includes(room))return reject();
    const origin=req.headers.origin;
    if(config.allowedOrigins?.length && !(origin ? config.allowedOrigins.includes(origin) : config.allowMissingOrigin))return reject();
    const ip=req.socket.remoteAddress; // Never trust a caller-supplied X-Forwarded-For.
    if(wss.clients.size>=L.connections || (ips.get(ip)||0)>=L.perIP || (!rooms.has(room)&&rooms.size>=L.rooms) || (rooms.get(room)?.size||0)>=L.peers)return reject(429);
    if(rooms.get(room)?.has(id))return reject(409);
    wss.handleUpgrade(req,socket,head,ws => {
      ips.set(ip,(ips.get(ip)||0)+1);
      if(!rooms.has(room))rooms.set(room,new Map());
      const peers=rooms.get(room);peers.set(id,{ws,tag,name});
      ws.alive=true;ws.on('pong',()=>{ws.alive=true;});ws.on('error',()=>ws.terminate());
      send(ws,{type:'peers',peers:[...peers].filter(([pid])=>pid!==id).map(([pid,p])=>({id:pid,tag:p.tag,name:p.name}))});
      for(const [pid,p] of peers)if(pid!==id)send(p.ws,{type:'join',peer:{id,tag,name}});
      let tokens=L.burst,last=performance.now();
      ws.on('message',(data,binary)=>{
        const now=performance.now();tokens=Math.min(L.burst,tokens+(now-last)*L.perSecond/1000);last=now;
        if(--tokens<0){ws.close(1008,'rate limit');return;}
        if(binary){ws.close(1003,'text JSON required');return;}
        let m;try{m=JSON.parse(String(data));}catch{ws.close(1008,'invalid JSON');return;}
        if(!m||typeof m!=='object'||Array.isArray(m)){ws.close(1008,'object required');return;}
        if(m.type==='signal' && text(m.to,128) && m.payload && typeof m.payload==='object' && !Array.isArray(m.payload)) {
          const payload=signalPayload(m.payload);
          if(!payload){ws.close(1008,'invalid signal');return;}
          let encoded;try{encoded=JSON.stringify({type:'signal',from:id,payload});}catch{ws.close(1008,'invalid signal');return;}
          const peer=peers.get(m.to);if(peer)sendWire(peer.ws,encoded);
        } else if(m.type==='ping' && Number.isFinite(m.t))send(ws,{type:'pong',t:m.t,now:Date.now()});
        else ws.close(1008,'invalid message');
      });
      ws.on('close',()=>{
        const count=(ips.get(ip)||1)-1;if(count)ips.set(ip,count);else ips.delete(ip);
        if(peers.get(id)?.ws!==ws)return;
        peers.delete(id);for(const p of peers.values())send(p.ws,{type:'leave',id});if(!peers.size)rooms.delete(room);
      });
      // With noServer, handleUpgrade itself adds the client to wss.clients.
      wss.emit('connection',ws,req);
    });
  });
  const heartbeat=setInterval(()=>{for(const ws of wss.clients){if(!ws.alive){ws.terminate();continue;}ws.alive=false;ws.ping(undefined,undefined,error=>{if(error)ws.terminate();});}},L.heartbeatMs);heartbeat.unref();
  let closing;
  const close=()=>closing ||= new Promise(resolve=>{stopping=true;clearInterval(heartbeat);for(const ws of wss.clients)ws.close(1001,'server stopping');const timer=setTimeout(()=>{for(const ws of wss.clients)ws.terminate();server.closeAllConnections();},1000);timer.unref();server.close(()=>{clearTimeout(timer);resolve();});});
  return {server,wss,close,rooms,send};
}
if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  const config=configFromEnv(process.env,process.argv[2]),relay=createRelay(config);
  relay.server.listen(config.port,config.host,()=>console.log('song signalling relay on http://'+config.host+':'+relay.server.address().port));
  for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{relay.close().then(()=>process.exit(0));});
}
