import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {Controller} from './automation.mjs';
import {atomicWrite} from './store.mjs';
import {DEFAULT_CONFIG} from './quota.mjs';
export function createGuard(home,monitorConfig,settings={}){
 const file=path.join(home,'automation-state.json');let data={version:1,enabled:true,config:{...DEFAULT_CONFIG},jobs:[],lastError:null};
 if(fs.existsSync(file)){data=JSON.parse(fs.readFileSync(file,'utf8'));if(data.version!==1||!Array.isArray(data.jobs))throw new Error('Invalid automation state');}
 for(const j of data.jobs)if(j.state==='dispatching'){j.state='attention';j.reason='派发结果未确认，请核对原聊天后再处理';}
 const store={data,save:()=>atomicWrite(file,data)};let power=null,error=null,stopped=false;const safeFile=path.join(home,'automation-safe-mode');
 const c=new Controller(store,{onChange:()=>{
  const hold=!stopped&&data.enabled&&monitorConfig().enabled&&monitorConfig().preventSleep&&data.jobs.some(j=>['pending','interrupting','dispatching'].includes(j.state));
  if(hold&&!power&&settings.bridgePath&&fs.existsSync(settings.bridgePath)){
   const p=power=spawn(settings.bridgePath,['--power'],{stdio:['pipe','ignore','ignore'],windowsHide:true});p.on('error',()=>{if(power===p)power=null;});p.on('exit',()=>{if(power===p)power=null;});
  }else if(!hold&&power){power.stdin.end();power=null;}
 }});
 let ticking=null,again=false;
 async function tick(){
  if(stopped)return;
  if(ticking){again=true;return ticking;}
  ticking=(async()=>{do{again=false;await tickOnce();}while(again);})().finally(()=>{ticking=null;});return ticking;
 }
 async function tickOnce(){
  if(stopped)return;
  try{
   if(fs.existsSync(safeFile))data.enabled=false;
   const commits=path.join(home,'automation-commits.jsonl');
   if(fs.existsSync(commits))for(const line of fs.readFileSync(commits,'utf8').trim().split('\n')){
    let event;try{event=JSON.parse(line);}catch{continue;}
    const j=data.jobs.find(j=>j.id===event.jobId&&j.state==='proposed');if(j)j.state='pending';
   }
   for(const j of data.jobs)if(j.state==='proposed'&&Date.now()-j.createdAt>60000)j.state='canceled';
   data.config={...monitorConfig(),enabled:data.enabled&&monitorConfig().enabled};
   const cancels=path.join(home,'automation-cancels.jsonl');
   if(fs.existsSync(cancels))for(const line of fs.readFileSync(cancels,'utf8').trim().split('\n')){
    let event;try{event=JSON.parse(line);}catch{continue;}
    for(const j of data.jobs)if(j.threadId===event.threadId&&event.at>=j.createdAt&&['pending','interrupting'].includes(j.state))j.state='canceled';
   }
   await c.tick();error=null;
  }catch(e){error=e.message;}
 }
 function add(peer,engineKey='local'){const id=randomUUID();const a={id,ready:false,accountId:null,engineKey,
  call:(method,params,timeout=5000)=>peer.call('engine.call',{method,params,timeout},timeout+500),listActive:()=>peer.call('engine.active',{},10000),inspect:threadId=>peer.call('engine.inspect',{threadId},5000),
  hasLoaded:threadId=>peer.call('engine.loaded',{threadId},5000),ensureLoaded:threadId=>peer.call('engine.load',{threadId},5000)};c.addAdapter(id,a);return a;
 }
 async function handle(method,params={},adapter){
  if(method==='guard.status')return {...c.status(),enabled:data.enabled,error};
  if(method==='guard.enable'){fs.rmSync(safeFile,{force:true});data.enabled=true;store.save();await tick();return {enabled:true};}
  if(method==='guard.safeMode'){fs.writeFileSync(safeFile,'safe\n',{mode:0o600});data.enabled=false;data.config.enabled=false;c.changed();return {enabled:false,monitorRetained:true};}
  if(method==='guard.cancelJob'){c.cancel(params.id);return {ok:true};}
  if(!adapter)throw new Error('No guarded engine connection');
  if(method==='guard.ready'){adapter.ready=true;await tick();return {ok:true};}
  if(method==='guard.commit'){tick();return {ok:true};}
  if(method==='guard.changed'){if(params.accountChanged){adapter.accountId=null;adapter.revision=(adapter.revision||0)+1;}tick();return {ok:true};}
  if(method==='guard.cancel'){c.cancelThread(params.threadId,adapter.accountId);return {ok:true};}
  if(method==='guard.gate'){
   if(stopped||!data.enabled||fs.existsSync(safeFile)||!monitorConfig().enabled||error)return {allowed:true,degraded:Boolean(error)};
   const m=params.message,p=m.params||{};
   const done=p.clientUserMessageId&&data.jobs.find(j=>j.accountId===adapter.accountId&&j.threadId===p.threadId&&j.key===p.clientUserMessageId&&j.state==='done');
   if(done)return {completed:true,result:done.result};
   if(c.policy(adapter.accountId).state!=='paused')return {allowed:true};
   const j=c.capture(adapter,m,'proposed');return {allowed:false,jobId:j.id};
  }
  throw new Error('Unknown automation command');
 }
 return {tick,add,handle,remove:id=>c.removeAdapter(id),status:()=>({...c.status(),enabled:data.enabled,error}),close(){stopped=true;data.config.enabled=false;if(power){power.stdin.end();power=null;}},controller:c};
}
