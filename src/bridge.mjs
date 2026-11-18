import {spawn} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import {Peer} from './rpc.mjs';
import {installation} from './client.mjs';
import {pipeName,stateDirectory} from './store.mjs';
export const MODEL_ACTIONS=new Set(['turn/start','turn/steer','turn/addUserMessage','thread/queue/start','review/start','thread/compact/start','thread/startAeon']);
export async function runBridge(args,{backendPath=process.env.CODEX_QUOTA_REAL_CLI||installation().backendPath,backendArgs=[],input=process.stdin,output=process.stdout,home=stateDirectory(),gateMs=300}={}){
 if(!backendPath)throw new Error('Original CLI is unavailable');
 const engineKey=process.env.CODEX_QUOTA_GUARD_ENGINE_ID||createHash('sha256').update(process.env.CODEX_HOME||'default').digest('hex').slice(0,16);
 const sessionId=process.env.CODEX_QUOTA_LAUNCH_ID;
 const preflight=process.env.CODEX_QUOTA_PREFLIGHT==='1';
 const childEnv={...process.env,CODEX_APP_RUNTIME_CLI_PATH:backendPath};
 delete childEnv.CODEX_QUOTA_LAUNCH_ID;
 const child=spawn(backendPath,[...backendArgs,...args],{windowsHide:true,stdio:['pipe','pipe','pipe'],env:childEnv});
 child.stderr.pipe(process.stderr);
 let closed=false,ready=false,service=null,connecting=null,connectingSocket=null;const pending=new Map(),approval=new Map(),prefix='qg-internal:'+randomUUID()+':';let sequence=0;
 function journal(name,event){const fd=fs.openSync(path.join(home,name),'a',0o600);try{fs.writeFileSync(fd,JSON.stringify(event)+'\n');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}}
 const send=m=>child.stdin.write(JSON.stringify(m)+'\n');
 const call=(method,params={},timeout=5000)=>new Promise((resolve,reject)=>{const id=prefix+(++sequence);const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Engine timeout'));},timeout);pending.set(id,{resolve,reject,timer});try{send({id,method,params});}catch(e){clearTimeout(timer);pending.delete(id);reject(e);}});
 function lines(stream,onLine,onEnd){let text='';stream.setEncoding('utf8');stream.on('data',chunk=>{text+=chunk;let n;while((n=text.indexOf('\n'))>=0){const line=text.slice(0,n+1);text=text.slice(n+1);onLine(line);}if(text.length>32*1024*1024){onLine(text);text='';}});stream.on('end',()=>{if(text)onLine(text);onEnd?.();});}
 async function inspect(threadId){const {thread}=await call('thread/read',{threadId,includeTurns:false});const {data}=await call('thread/turns/list',{threadId,limit:1,sortDirection:'desc',itemsView:'notLoaded'});return {archived:thread.archived===true,active:thread.status?.type==='active',approvalWaiting:thread.status?.activeFlags?.some(x=>['waitingOnApproval','waitingOnUserInput'].includes(x))||[...approval.values()].includes(threadId),latestTurn:data?.[0]??null,child:Boolean(thread.parentThreadId||thread.source?.subAgent)};}
 async function connect(){
  if(service&&!service.closed)return service;if(connecting)return connecting;
  connecting=(async()=>{let socket,p;
   try{const token=fs.readFileSync(path.join(home,'monitor-token'),'utf8').trim();socket=connectingSocket=net.createConnection(pipeName(home));p=new Peer(socket);
    p.on('message',async req=>{try{let r;const a=req.params||{};
     if(req.method==='engine.call'){if(!new Set(['account/rateLimits/read','turn/interrupt','turn/start','thread/queue/start','thread/compact/start','review/start','thread/startAeon']).has(a.method))throw new Error('Unsupported method');r=await call(a.method,a.params,Math.min(a.timeout||5000,30000));}
     else if(req.method==='engine.inspect')r=await inspect(a.threadId);
     else if(req.method==='engine.loaded')r=(await call('thread/loaded/list')).data.includes(a.threadId);
     else if(req.method==='engine.load')r=await call('thread/resume',{threadId:a.threadId,excludeTurns:true});
     else if(req.method==='engine.active'){const {data}=await call('thread/loaded/list');r=(await Promise.all(data.map(async id=>{const t=await inspect(id);return t.active&&t.latestTurn?.status==='inProgress'?{id,turnId:t.latestTurn.id,approvalWaiting:t.approvalWaiting,child:t.child}:null;}))).filter(Boolean);}
     else throw new Error('Unknown request');p.reply(req,r);
    }catch(e){try{p.reject(req,e);}catch{}}});
    await p.call('hello',{token,role:'bridge',engineKey},gateMs);
    await p.call('guard.ready',{},10000);
    if(closed)throw Error('Bridge closed');
    if(sessionId){
     // Require a round trip through the desktop's initialized backend before
     // confirming this launch. A simulator/preflight never announces a session.
     await call('configRequirements/read',{},5000);
     await p.call('guard.connected',{sessionId},2000);
    }
    if(closed)throw Error('Bridge closed');
    service=p;p.on('disconnect',()=>{if(service===p)service=null;});return p;
   }catch(e){socket?.destroy();p?.fail(e);throw e;}
  })().finally(()=>{connecting=null;connectingSocket=null;});return connecting;
 }
 function notify(method,params={}){if(ready&&!closed&&!preflight)connect().then(p=>p.call(method,params,5000)).catch(()=>{});}
 lines(child.stdout,line=>{let m;try{m=JSON.parse(line);}catch{output.write(line);return;}
  const own=pending.get(m.id);if(own){clearTimeout(own.timer);pending.delete(m.id);m.error?own.reject(Object.assign(new Error(m.error.message),m.error)):own.resolve(m.result);return;}
  // Late internal replies are never exposed as desktop responses.
  if(typeof m.id==='string'&&m.id.startsWith(prefix))return;
  if(m.method&&m.id!==undefined&&/requestApproval|requestUserInput|elicitation/.test(m.method))approval.set(m.id,m.params?.threadId);
  output.write(line);if(['account/rateLimits/updated','turn/completed','account/updated'].includes(m.method))notify('guard.changed',{accountChanged:m.method==='account/updated'});
 });
 let chain=Promise.resolve();lines(input,line=>{chain=chain.then(async()=>{let m;try{m=JSON.parse(line);}catch{child.stdin.write(line);return;}
  if(!m.method)approval.delete(m.id);
  if(m.method==='initialized'){child.stdin.write(line);ready=true;notify('guard.changed');return;}
  if(['turn/interrupt','thread/archive','thread/delete','thread/revert','thread/queue/delete'].includes(m.method)){try{journal('automation-cancels.jsonl',{threadId:m.params?.threadId,at:Date.now()});}catch{}notify('guard.cancel',{threadId:m.params?.threadId});}
  if(ready&&MODEL_ACTIONS.has(m.method)){
   // Monitoring is optional: failure, timeout, unsupported protocol, or disk errors fail open.
   try{const p=service; if(p&&!p.closed){const v=await p.call('guard.gate',{message:m},gateMs);
    if(v.completed){output.write(JSON.stringify({id:m.id,result:v.result})+'\n');return;}
    if(v.allowed===false){
     // Only commit a queue entry after receiving the gate response. A lost or
     // delayed response forwards the original request and cannot later replay it.
     journal('automation-commits.jsonl',{jobId:v.jobId});
     notify('guard.commit');output.write(JSON.stringify({id:m.id,error:{code:-32003,message:'额度偏低，任务已保存，恢复后自动继续。',data:{type:'quota_guard_paused',jobId:v.jobId}}})+'\n');return;}
   }}catch{}
  }
  child.stdin.write(line);
 }).catch(()=>{if(!child.stdin.destroyed)child.stdin.write(line);});},()=>{chain.finally(()=>child.stdin.end());});
 const heartbeat=setInterval(()=>{if(ready&&!closed&&!preflight)connect().catch(()=>{});},1000);heartbeat.unref();
 function close(){if(closed)return;closed=true;clearInterval(heartbeat);connectingSocket?.destroy();service?.output.destroy();for(const p of pending.values()){clearTimeout(p.timer);p.reject(new Error('Engine exited'));}pending.clear();}
 child.on('close',code=>{close();if(input===process.stdin){input.destroy();output.end();process.exitCode=code??1;}});child.stdin.on('error',()=>{});child.on('error',()=>{close();if(input===process.stdin){input.destroy();process.exitCode=1;}});
 return {child,close,call};
}
