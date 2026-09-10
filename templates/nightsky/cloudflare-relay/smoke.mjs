import fs from 'node:fs';
import crypto from 'node:crypto';
import WebSocket from 'ws';
const sockets=[];let deadline;
try {
 const path=process.argv[2]||'.relay-private/capability.txt';
 const fd=fs.openSync(path,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW),st=fs.fstatSync(fd);
 if(!st.isFile()||st.uid!==process.getuid()||(st.mode&0o077))throw Error();
 const base=new URL(fs.readFileSync(fd,'utf8').trim());fs.closeSync(fd);
 if(!['wss:','ws:'].includes(base.protocol)||base.username||base.password||base.hash||!base.searchParams.get('token')||base.searchParams.get('token').length<32)throw Error();
 if(base.protocol==='ws:'&&!['127.0.0.1','localhost'].includes(base.hostname))throw Error();
 const room='nightsky-'+crypto.randomBytes(6).toString('hex');
 const request=(id,origin='https://tonk.network',bad=false)=>new Promise((resolve,reject)=>{
  const u=new URL(base);u.searchParams.set('room',room);u.searchParams.set('id',id);if(bad)u.searchParams.set('token','invalid');
  const ws=new WebSocket(u,{origin,handshakeTimeout:4000});sockets.push(ws);
  const queue=[],waiters=[];ws.on('message',raw=>{let m;try{m=JSON.parse(raw);}catch{return;}const index=waiters.findIndex(w=>w.p(m));if(index<0)queue.push(m);else{const w=waiters.splice(index,1)[0];clearTimeout(w.timer);w.resolve(m);}});
  ws.once('error',()=>reject(Error('Connection rejected')));ws.once('unexpected-response',(_,r)=>{r.resume();ws.terminate();resolve({status:r.statusCode});});
  ws.once('open',()=>resolve({ws,status:101,next(p){const n=queue.findIndex(p);if(n>=0)return Promise.resolve(queue.splice(n,1)[0]);return new Promise((resolve,reject)=>{const w={p,resolve,timer:setTimeout(()=>reject(Error('Timed out')),4000)};waiters.push(w);});}}));
 });
 const work=async()=>{
  const health=new URL(base);health.protocol=base.protocol==='wss:'?'https:':'http:';health.pathname='/health';health.search='';
  const response=await fetch(health,{signal:AbortSignal.timeout(4000)});if(!response.ok||(await response.json()).ok!==true)throw Error();
  if((await request('bad','https://tonk.network',true)).status!==403)throw Error();
  if((await request('origin','https://invalid.example')).status!==403)throw Error();
  const a=await request('a'),b=await request('b','null');if(a.status!==101||b.status!==101)throw Error();
  await a.next(m=>m.type==='peers');const peers=await b.next(m=>m.type==='peers');if(!peers.peers.some(p=>p.id==='a'))throw Error();
  if((await request('a')).status!==409)throw Error();
  a.ws.send(JSON.stringify({type:'signal',to:'b',payload:{sdp:{type:'offer',sdp:'v=0\r\n'}}}));await b.next(m=>m.type==='signal'&&m.from==='a');
  b.ws.send(JSON.stringify({type:'signal',to:'a',payload:{sdp:{type:'answer',sdp:'v=0\r\n'}}}));await a.next(m=>m.type==='signal'&&m.from==='b');
  console.log(JSON.stringify({ok:true,hostname:base.hostname,health:true,authentication:true,opaqueOrigin:true,discovery:true,bidirectionalSignal:true,duplicatePreserved:true}));
 };
 await Promise.race([work(),new Promise((_,reject)=>{deadline=setTimeout(()=>reject(Error()),15000);})]);
} catch {console.error('Relay smoke test failed; private endpoint and errors withheld.');process.exitCode=1;}
finally{clearTimeout(deadline);for(const ws of sockets)try{ws.terminate();}catch{}}
