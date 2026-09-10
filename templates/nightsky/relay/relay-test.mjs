import assert from 'node:assert/strict';
import { once } from 'node:events';
import WebSocket from 'ws';
import net from 'node:net';
import { configFromEnv,createRelay } from './server.mjs';
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const fixtures=new Set(), sockets=new Set();
const deadline=setTimeout(()=>{
  console.error('FAIL relay suite exceeded 50-second deadline');
  for(const socket of sockets)socket.terminate?.() || socket.destroy?.();
  for(const relay of fixtures){for(const ws of relay.wss.clients)ws.terminate();relay.server.closeAllConnections();relay.server.close();}
  setTimeout(()=>process.exit(1),100).unref();process.exitCode=1;
},50000);
function bounded(promise,label,ms=5000){let timer;return Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Timed out: '+label)),ms);})]).finally(()=>clearTimeout(timer));}
const event=(target,name)=>once(target,name,{signal:AbortSignal.timeout(5000)});
function inbox(ws){
  const messages=[],waiters=[];
  ws.on('message',data=>{
    const message=JSON.parse(String(data)),index=waiters.findIndex(w=>w.predicate(message));
    if(index>=0)waiters.splice(index,1)[0].resolve(message);else messages.push(message);
  });
  ws.nextMessage=(predicate,label)=>{
    const index=messages.findIndex(predicate);if(index>=0)return Promise.resolve(messages.splice(index,1)[0]);
    let waiter;const pending=new Promise(resolve=>{waiter={predicate,resolve};waiters.push(waiter);});
    return bounded(pending,label).finally(()=>{const i=waiters.indexOf(waiter);if(i>=0)waiters.splice(i,1);});
  };
  ws.closed=new Promise(resolve=>ws.once('close',(...args)=>resolve(args)));
}
const closed=ws=>bounded(ws.closed,'socket close');
async function shutdown(relay){await bounded(relay.close(),'relay shutdown');fixtures.delete(relay);}
try {
assert.throws(()=>configFromEnv({NODE_ENV:'production'}));
assert.throws(()=>configFromEnv({HOST:'0.0.0.0'}));
const token='a'.repeat(32), config=configFromEnv({NODE_ENV:'production',RELAY_TOKEN:token,RELAY_ALLOWED_ROOMS:'one,two',RELAY_ALLOWED_ORIGINS:'null,https://example.test'});
async function fixture(limits={}){const relay=createRelay(config,limits);fixtures.add(relay);relay.server.listen(0,'127.0.0.1');await event(relay.server,'listening');return Object.assign(relay,{url:`ws://127.0.0.1:${relay.server.address().port}`});}
function connect(r,id,options={}){
  const ws=new WebSocket(`${r.url}/?room=${options.room||'one'}&id=${id}&token=${options.token??token}`,{origin:options.origin??'null',...options.ws});
  sockets.add(ws);inbox(ws);ws.on('close',()=>sockets.delete(ws));ws.on('error',()=>{});
  return bounded(new Promise((resolve,reject)=>{ws.once('error',reject);ws.once('open',()=>resolve(ws));}),'connect '+id).catch(error=>{ws.terminate();throw error;});
}
async function denied(r,id,options){await assert.rejects(connect(r,id,options),/Unexpected server response: (400|403|409|429)/);}
const r=await fixture({heartbeatMs:1000});
try{
  const raw=net.connect(r.server.address().port,'127.0.0.1');sockets.add(raw);raw.on('close',()=>sockets.delete(raw));await event(raw,'connect');
  raw.write('GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n');
  const response=String((await event(raw,'data'))[0]);assert.match(response,/400/);raw.destroy();
  const a=await connect(r,'a'), b=await connect(r,'b'), c=await connect(r,'c',{room:'two'});
  await denied(r,'a');assert.equal(a.readyState,1,'duplicate does not evict incumbent');
  await denied(r,'bad',{token:'wrong'});await denied(r,'bad',{room:'other'});await denied(r,'bad',{origin:'https://evil.test'});
  await denied(r,'bad',{ws:{origin:undefined}});await denied(r,'x'.repeat(129));
  const signal=b.nextMessage(m=>m.type==='signal'&&m.payload.sdp?.sdp==='example','initial SDP');a.send(JSON.stringify({type:'signal',to:'b',payload:{sdp:{type:'offer',sdp:'example'}}}));assert.deepEqual(await signal,{type:'signal',from:'a',payload:{sdp:{type:'offer',sdp:'example'}}});
  let crossed=false;c.on('message',data=>{if(JSON.parse(String(data)).type==='signal')crossed=true;});a.send(JSON.stringify({type:'signal',to:'c',payload:{sdp:{type:'offer',sdp:'cross'}}}));await pause(20);assert.equal(crossed,false);
  for(const [value,binary] of [['null',false],['1',false],['[]',false],['true',false],['"text"',false],['{',false],[JSON.stringify({type:'signal',to:'b',payload:7}),false],['hi',true],['x'.repeat(40000),false]]){
    const ws=await connect(r,'bad'+Math.random());const closure=closed(ws);ws.send(value,{binary});await closure;assert.equal(r.server.listening,true);
  }
  const attacker=await connect(r,'nested');const rejected=closed(attacker);
  attacker.send('{"type":"signal","to":"b","payload":{"a":'+ '['.repeat(10000)+'0'+']'.repeat(10000)+'}}');
  assert.equal((await rejected)[0],1008);assert.equal(b.readyState,1,'malformed sender cannot disconnect target');
  const continued=b.nextMessage(m=>m.type==='signal'&&m.payload.candidate?.candidate==='candidate:example','valid ICE after attack');a.send(JSON.stringify({type:'signal',to:'b',payload:{candidate:{candidate:'candidate:example',sdpMid:'0',sdpMLineIndex:0,usernameFragment:null}}}));
  const forwarded=await continued;
  assert.equal(forwarded.payload.candidate.sdpMid,'0');assert.equal(b.readyState,1);
  const pong=a.nextMessage(m=>m.type==='pong'&&m.t===123,'survival pong');a.send(JSON.stringify({type:'ping',t:123}));assert.equal((await pong).t,123,'legitimate socket survives adversarial inputs');
  const health=await fetch(r.url.replace('ws:','http:')+'/health',{signal:AbortSignal.timeout(5000)});assert.deepEqual(await bounded(health.json(),'health body'),{ok:true});
  const leave=a.nextMessage(m=>m.type==='leave'&&m.id==='b','specific peer departure');b.close();assert.equal((await leave).id,'b');
  const dead=await connect(r,'dead',{ws:{autoPong:false}});await closed(dead);await pause(20);assert.equal(r.rooms.get('one').has('dead'),false);
  const fake={readyState:1,bufferedAmount:1e6,terminate(){this.stopped=true;},send(){throw Error('must not enqueue');}};r.send(fake,{type:'ping'});assert.equal(fake.stopped,true);
  a.close();c.close();
}finally{await shutdown(r);}
for(const [limits,ids] of [[{connections:1},[['one','a'],['two','b']]],[{perIP:1},[['one','a'],['one','b']]],[{peers:1},[['one','a'],['one','b']]],[{rooms:1},[['one','a'],['two','b']]]]){
 const relay=await fixture(limits);try{await connect(relay,ids[0][1],{room:ids[0][0]});await denied(relay,ids[1][1],{room:ids[1][0]});}finally{await shutdown(relay);}
}
const flood=await fixture({burst:2,perSecond:0});try{const ws=await connect(flood,'flood');const closure=closed(ws);for(let i=0;i<5;i++)ws.send(JSON.stringify({type:'ping',t:i}));assert.equal((await closure)[0],1008);}finally{await shutdown(flood);}
console.log('PASS config/auth/origin/schema/binary/oversize/duplicate/room isolation, two-peer signal, generic health, heartbeat, cleanup, backpressure, capacity and flooding');

} finally {
  for(const socket of sockets){if(socket.terminate)socket.terminate();else socket.destroy();}
  await Promise.allSettled([...fixtures].map(shutdown));clearTimeout(deadline);
}
