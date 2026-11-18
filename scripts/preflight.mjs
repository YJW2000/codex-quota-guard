import {spawnSync,spawn} from 'node:child_process';
import fs from 'node:fs';
import {Peer} from '../src/rpc.mjs';
const [bridge,backend]=process.argv.slice(2);
let ok=false;let child;
try{
 const args=['app-server','--print-startup-config','--startup-client-info',JSON.stringify({name:'codex_desktop',version:'quota-guard-preflight'})];
 const env={...process.env,CODEX_QUOTA_REAL_CLI:backend,CODEX_QUOTA_PREFLIGHT:'1'};
 delete env.CODEX_QUOTA_LAUNCH_ID;
 const direct=spawnSync(backend,args,{stdio:['ignore','pipe','pipe'],encoding:'utf8',windowsHide:true,timeout:15000});
 const wrapped=spawnSync(bridge,args,{stdio:['ignore','pipe','pipe'],encoding:'utf8',windowsHide:true,env,timeout:15000});
 if(direct.status!==0||wrapped.status!==0||direct.stdout!==wrapped.stdout)throw new Error('Desktop startup configuration mismatch');
 JSON.parse(wrapped.stdout);
 child=spawn(bridge,['app-server'],{stdio:['pipe','pipe','ignore'],windowsHide:true,env});const p=new Peer(child.stdout,child.stdin);
 await p.call('initialize',{clientInfo:{name:'codex_quota_preflight',version:'0.4.0'}},12000);p.send({method:'initialized'});
 await p.call('configRequirements/read',{},12000);await p.call('config/read',{},12000);
 ok=true;console.log(JSON.stringify({ok:true,startupConfig:true,initialize:true,configRequirements:true,configRead:true}));
}catch(e){console.log(JSON.stringify({ok:false,error:e.message}));process.exitCode=1;}
finally{if(child){child.stdin.end();const t=setTimeout(()=>child.kill(),1000);t.unref();}}
