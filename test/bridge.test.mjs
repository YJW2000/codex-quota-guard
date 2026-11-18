import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import {PassThrough} from 'node:stream';
import {once,EventEmitter} from 'node:events';
import {runBridge} from '../src/bridge.mjs';
import {runDaemon} from '../src/daemon.mjs';
import {createGuard} from '../src/guard-service.mjs';
import {loadToken,pipeName} from '../src/store.mjs';
import {DEFAULT_CONFIG} from '../src/quota.mjs';
import {control,ROOT} from '../src/client.mjs';
import {Peer} from '../src/rpc.mjs';
import {testHome,cleanHome,usage} from './helpers.mjs';
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<150;i++){if(await fn())return;await wait(20);}throw Error('Condition not reached');}
async function setup(t,{daemon=false,gateMs=300,mailTransport}={}){
 const home=testHome(),input=new PassThrough(),output=new PassThrough();let d;
 const reader=new EventEmitter();reader.read=async()=>usage();reader.close=()=>{};
 if(daemon)d=await runDaemon({home,reader,mailTransport});
 const b=await runBridge(['app-server'],{home,input,output,gateMs,backendPath:process.execPath,backendArgs:[path.join(ROOT,'test/fixtures/guard-engine.mjs')]});
 const peer=new Peer(output,input);
 t.after(async()=>{input.end();b.close();b.child.kill();await wait(50);await d?.shutdown();cleanHome(home);});
 await peer.call('initialize',{extra:'原样参数'});peer.send({method:'initialized'});
 if(daemon)await until(async()=>((await control('guard.status',{}, {home})).accounts||[]).length>0);
 return {home,b,peer,input,output,d};
}
test('monitor absent: initialize, parameters, extensions and server requests pass through',async t=>{
 const {peer}=await setup(t);assert.deepEqual(await peer.call('config/read',{text:'中文 " \\'}),{echo:{text:'中文 " \\'},extension:{retained:true}});
 const event=once(peer,'message');await peer.call('test/serverRequest');assert.equal((await event)[0].id,'server-approval');
 const now=Date.now();assert.ok((await peer.call('turn/start',{threadId:'a'})).turn);assert.ok(Date.now()-now<1000);
});
test('EOF drains backend output including a final line without newline; backend exit preserved',async t=>{
 const {b,input,output}=await setup(t);let raw='';output.on('data',x=>raw+=x);
 const closed=once(b.child,'close');input.end(JSON.stringify({id:82,method:'test/partial'})+'\n');
 assert.equal((await closed)[0],7);assert.match(raw,/末行不带换行/);assert.ok(raw.endsWith('}}'));
});
test('real pipe: pause all, queue once, resume once, daemon death fail-open and reconnect',async t=>{
 const mail=[];
 const {peer,home,d}=await setup(t,{daemon:true,mailTransport:{send:async message=>mail.push(message)}});
 await peer.call('test/set',{used:98,threads:['a','b']});
 await until(async()=> (await control('guard.status',{}, {home})).pendingCount===2);
 await assert.rejects(peer.call('turn/start',{threadId:'queued',clientUserMessageId:'once',input:[{type:'text',text:'继续'}]}),e=>e.data?.type==='quota_guard_paused');
 await until(async()=> (await control('guard.status',{}, {home})).pendingCount===3);
 assert.equal(mail.length,1);assert.match(mail[0].subject,/5 小时/);
 await peer.call('test/set',{used:1});await until(async()=> (await control('guard.status',{}, {home})).pendingCount===0);
 let state=await peer.call('test/state');assert.equal(state.calls.filter(x=>x==='turn/interrupt').length,2);assert.equal(state.calls.filter(x=>x==='turn/start').length,3);
 // Completed client IDs return the cached result instead of starting a second turn.
 await peer.call('turn/start',{threadId:'queued',clientUserMessageId:'once'});
 state=await peer.call('test/state');assert.equal(state.calls.filter(x=>x==='turn/start').length,3);
 await d.shutdown();await peer.call('test/set',{used:98});assert.ok((await peer.call('turn/start',{threadId:'offline'})).turn);
 const reader=new EventEmitter();reader.read=async()=>usage();reader.close=()=>{};const recovered=await runDaemon({home,reader});t.after(()=>recovered.shutdown());
 await until(async()=>((await control('guard.status',{}, {home})).bridges||[]).some(b=>b.ready));
 await until(async()=> (await control('guard.status',{}, {home})).accounts?.[0]?.state==='paused');
 await control('guard.safeMode',{}, {home});assert.ok((await peer.call('turn/start',{threadId:'safe'})).turn);
 assert.equal((await control('status',{}, {home})).state,'available');
});
test('gate response timeout fails open; an unconfirmed proposal can never replay',async t=>{
 const {home,peer}=await setup(t,{gateMs:70});const token=loadToken(home),guard=createGuard(home,()=>({...DEFAULT_CONFIG}));
 const sockets=new Set();const server=net.createServer(s=>{
  sockets.add(s);s.on('close',()=>sockets.delete(s));const p=new Peer(s);let a;
  p.on('message',async r=>{try{
   if(r.method==='hello'){assert.equal(r.params.token,token);a=guard.add(p);p.reply(r,{ok:true});return;}
   const v=await guard.handle(r.method,r.params,a);if(r.method==='guard.gate')await wait(220);p.reply(r,v);
  }catch(e){try{p.reject(r,e);}catch{}}});
 });await new Promise(r=>server.listen(pipeName(home),r));
 t.after(async()=>{for(const s of sockets)s.destroy();await new Promise(r=>server.close(r));guard.close();});
 await until(()=>guard.status().bridges.some(b=>b.ready));await peer.call('test/set',{used:99});await until(()=>guard.status().accounts[0]?.state==='paused');
 assert.ok((await peer.call('turn/start',{threadId:'timeout',clientUserMessageId:'never-replay'})).turn);
 await wait(300);await peer.call('test/set',{used:1});await guard.tick();
 assert.ok(guard.controller.store.data.jobs.filter(j=>j.kind==='request').every(j=>j.state==='proposed'));
 const state=await peer.call('test/state');assert.equal(state.requests.filter(x=>x.method==='turn/start'&&x.params.clientUserMessageId==='never-replay').length,1);
});
test('corrupt automation state leaves independent monitoring usable',async t=>{
 const home=testHome();fs.writeFileSync(path.join(home,'automation-state.json'),'{broken');
 const reader=new EventEmitter();reader.read=async()=>usage();reader.close=()=>{};const d=await runDaemon({home,reader});
 t.after(async()=>{await d.shutdown();cleanHome(home);});assert.equal((await control('check',{}, {home})).state,'available');
 assert.equal((await control('guard.status',{}, {home})).enabled,false);assert.equal(fs.readFileSync(path.join(home,'automation-state.json'),'utf8'),'{broken');
});
test('approval requests are forwarded and never silently approved or auto-resumed',async t=>{
 const {peer,home}=await setup(t,{daemon:true});await peer.call('test/set',{threads:['approval']});
 const event=once(peer,'message');await peer.call('test/serverRequest',{threadId:'approval'});assert.equal((await event)[0].id,'server-approval');
 await peer.call('test/set',{used:99});await until(async()=> (await control('guard.status',{}, {home})).pendingCount===1);
 await peer.call('test/set',{used:1});await until(async()=> (await control('guard.status',{}, {home})).accounts?.[0]?.state==='running');
 assert.equal((await control('guard.status',{}, {home})).pendingCount,1);
 peer.send({id:'server-approval',result:{decision:'cancel'}});await peer.call('test/set',{used:1});
 await until(async()=> (await control('guard.status',{}, {home})).jobs?.[0]?.state==='attention');
 const state=await peer.call('test/state');assert.equal(state.calls.filter(x=>x==='turn/start').length,0);
});
test('daemon shutdown during an in-flight quota read cannot later pause desktop work',async t=>{
 const home=testHome(),guard=createGuard(home,()=>({...DEFAULT_CONFIG}));let resolve;
 const adapter={id:'pending',ready:true,accountId:'account-a',call:()=>new Promise(r=>resolve=r),listActive:async()=>{throw Error('Must not inspect after shutdown');}};
 guard.controller.addAdapter(adapter.id,adapter);const checking=guard.tick();guard.close();resolve(usage(99));await checking;
 assert.equal(guard.controller.store.data.jobs.length,0);cleanHome(home);
});
