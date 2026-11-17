import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {Store} from '../src/store.mjs';
import {Monitor} from '../src/monitor.mjs';
import {QuotaReader} from '../src/reader.mjs';
import {evaluateQuota} from '../src/quota.mjs';
import {runDaemon} from '../src/daemon.mjs';
import {control,ROOT} from '../src/client.mjs';
import {Peer} from '../src/rpc.mjs';
import {testHome,cleanHome,usage} from './helpers.mjs';
const fixture=path.join(ROOT,'test/fixtures/engine.mjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function setup(t){const home=testHome();t.after(()=>cleanHome(home));return {home,store:new Store(home)};}
for(const [label,input,state] of [['available',usage(),'available'],['low',usage(95),'low'],['weekly',usage(0,99),'low'],['missing',{},'unavailable'],['null',null,'unavailable'],['bad-number',{...usage(),rateLimits:{primary:{usedPercent:-1}}},'unavailable']])
 test('truthful quota: '+label,()=>{const s=evaluateQuota(input);assert.equal(s.state,state);if(state==='unavailable'){assert.equal(s.label,'暂不可用');assert.deepEqual(s.windows,[]);}});
test('failure and expiry clear previously successful percentages',async t=>{
 const {store}=setup(t);let now=1;let fail=false;const reader=new EventEmitter();reader.read=async()=>{if(fail)throw Error();return usage();};reader.close=()=>{};
 const m=new Monitor(store,reader,()=>now);assert.equal((await m.check()).state,'available');fail=true;assert.equal((await m.check()).state,'unavailable');assert.deepEqual(m.status().windows,[]);
 fail=false;await m.check();now+=70000;assert.equal(m.status().state,'unavailable');await m.check();reader.emit('unavailable');assert.deepEqual(m.status().windows,[]);
});
test('legacy job state and other files remain byte-for-byte intact',t=>{
 const {home}=setup(t);const file=path.join(home,'state.json');const legacy='{"jobs":[{"state":"pending","method":"turn/start"}]}';fs.writeFileSync(file,legacy);
 const store=new Store(home);store.configure({enabled:false});assert.equal(fs.readFileSync(file,'utf8'),legacy);
});
for(const mode of ['good','missing','fail','hang','crash'])test('isolated reader: '+mode,async t=>{
 const {home,store}=setup(t);const log=path.join(home,'calls');const reader=new QuotaReader({backendPath:process.execPath,backendArgs:[fixture],timeoutMs:mode==='hang'?350:2000,
 spawnProcess:(exe,args,opts)=>spawn(exe,args,{...opts,env:{...opts.env,QUOTA_TEST_MODE:mode,QUOTA_TEST_LOG:log}})});
 const m=new Monitor(store,reader);t.after(()=>m.close());const start=Date.now();const result=await m.check();assert.equal(result.state,mode==='good'?'available':'unavailable');assert.ok(Date.now()-start<4500);
 if(fs.existsSync(log))assert.ok(fs.readFileSync(log,'utf8').trim().split('\n').every(x=>['initialize','account/rateLimits/read'].includes(x)));
});
test('child sanitization never mutates parent override; legacy bridge is rejected',async t=>{
 const {store}=setup(t);const before=process.env.CODEX_CLI_PATH;
 const reader=new QuotaReader({backendPath:process.execPath,backendArgs:[fixture],spawnProcess:(exe,args,opts)=>{assert.equal(opts.env.CODEX_CLI_PATH,undefined);assert.equal(opts.env.CODEX_APP_RUNTIME_CLI_PATH,undefined);return spawn(exe,args,opts);}});
 await new Monitor(store,reader).check();reader.close();assert.equal(process.env.CODEX_CLI_PATH,before);
 await assert.rejects(new QuotaReader({backendPath:'C:\\Users\\test\\codex-quota-bridge.exe'}).read());
});
test('monitor daemon exit affects only monitor, not an independent desktop stub',async t=>{
 const {home}=setup(t);const desktop=spawn(process.execPath,['-e','setInterval(()=>{},1000)','codex-quota-guard-desktop-stub'],{windowsHide:true,stdio:'ignore'});
 const reader=new EventEmitter();reader.read=async()=>usage();reader.close=()=>{};
 let d;t.after(async()=>{await d?.shutdown();desktop.kill();await wait(50);});d=await runDaemon({home,reader});
 assert.equal((await control('check',{}, {home})).state,'available');await d.shutdown();assert.equal((await control('status',{}, {home})).state,'unavailable');assert.equal(desktop.exitCode,null);
});
test('MCP initialization and discovery need no daemon, backend or credentials',async t=>{
 const {home}=setup(t);const child=spawn(process.execPath,[path.join(ROOT,'src/main.mjs'),'mcp'],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,CODEX_QUOTA_GUARD_HOME:home}});
 const peer=new Peer(child.stdout,child.stdin);t.after(()=>{child.stdin.end();child.kill();});
 const r=await peer.call('initialize',{protocolVersion:'2025-06-18'});assert.equal(r.serverInfo.version,'0.2.0');assert.equal((await peer.call('tools/list')).tools.length,5);
 const result=await peer.call('tools/call',{name:'guard_status',arguments:{}});assert.equal(result.structuredContent.label,'暂不可用');assert.equal(fs.existsSync(path.join(home,'monitor-token')),false);
});
test('daemon crash is reported as unavailable by its client',{timeout:5000},async t=>{
 const {home}=setup(t);const child=spawn(process.execPath,[path.join(ROOT,'src/main.mjs'),'daemon'],{windowsHide:true,stdio:'ignore',env:{...process.env,CODEX_QUOTA_GUARD_HOME:home}});
 t.after(()=>child.kill());for(let i=0;i<30&&!fs.existsSync(path.join(home,'monitor-token'));i++)await wait(30);
 if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;}assert.equal((await control('status',{}, {home})).label,'暂不可用');
});

test('an old query cannot repopulate cleared values after disabling and reenabling',async t=>{
 const {store}=setup(t);let resolve;const reader=new EventEmitter();reader.read=()=>new Promise(r=>resolve=r);reader.close=()=>{};
 const m=new Monitor(store,reader);const pending=m.check();m.configure({enabled:false});m.configure({enabled:true});resolve(usage());await pending;assert.equal(m.status().state,'unavailable');assert.deepEqual(m.status().windows,[]);
});
