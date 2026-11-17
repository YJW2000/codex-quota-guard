import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync,execFileSync} from 'node:child_process';
import {ROOT} from '../src/client.mjs';
import {testHome,cleanHome} from './helpers.mjs';
const ps=s=>{
 const file=path.join(ROOT,'.cache','native-ps-output-'+Math.random()+'.log');fs.mkdirSync(path.dirname(file),{recursive:true});const fd=fs.openSync(file,'w');let failure;
 try{execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',s],{stdio:['ignore',fd,fd],windowsHide:true,cwd:ROOT,timeout:45000});}catch(e){failure=e;}finally{fs.closeSync(fd);}
 const output=fs.readFileSync(file,'utf8');fs.unlinkSync(file);if(failure)throw Error(output||failure.message);return output;
};
const quote=s=>"'"+s.replaceAll("'","''")+"'";
function fixture(t){
 const home=testHome(),root=path.join(home,'app'),dist=path.join(root,'dist');fs.mkdirSync(dist,{recursive:true});
 const backend=path.join(dist,'Codex.exe'),bridge=path.join(dist,'codex-quota-bridge.exe');
 const compiler=path.join(process.env.WINDIR,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
 execFileSync(compiler,['/nologo','/reference:System.Web.Extensions.dll','/out:'+backend,path.join(ROOT,'test/fixtures/NativeEngine.cs')],{windowsHide:true});
 fs.copyFileSync(path.join(ROOT,'dist/codex-quota-bridge.exe'),bridge);
 for(const d of ['src','scripts'])fs.cpSync(path.join(ROOT,d),path.join(root,d),{recursive:true});
 const settings={root,stateDir:home,backendPath:backend,nodePath:process.execPath,bridgePath:bridge,mode:'independent-monitor'};
 const save=()=>fs.writeFileSync(path.join(root,'installation.json'),JSON.stringify(settings));save();
 t.after(()=>cleanHome(home));return {home,root,bridge,backend,settings,save};
}
test('native bridge bypasses one-shot startup with stdin ignored; preserves Unicode argv, stderr and exit',t=>{
 const {bridge}=fixture(t);const args=['app-server','--print-startup-config','--startup-client-info','{"name":"桌面"}'];
 const r=spawnSync(bridge,args,{stdio:['ignore','pipe','pipe'],encoding:'utf8',windowsHide:true,timeout:5000});
 assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),{organizations:[],fixture:true});
 const echo=['--echo','','中文 空格','quote"中','C:\\has space\\','three\\\\\\"end'];
 const e=spawnSync(bridge,echo,{stdio:['ignore','pipe','pipe'],encoding:'utf8',windowsHide:true,timeout:5000});
 assert.equal(e.status,23,e.stderr);assert.deepEqual(JSON.parse(e.stdout),echo);assert.equal(e.stderr,'stderr-kept');
});
test('native RPC relay drains input/output through EOF; missing Node or malformed settings falls back',t=>{
 const {bridge,settings,backend,save}=fixture(t);
 const input=JSON.stringify({id:1,method:'initialize',params:{text:'你好 " \\'}})+'\n'+JSON.stringify({method:'initialized'})+'\n';
 for(const mode of ['bridge','missing-node','bad-settings']){
  if(mode==='missing-node'){settings.nodePath='C:\\missing\\node.exe';save();}
  if(mode==='bad-settings')fs.writeFileSync(path.join(settings.root,'installation.json'),'{bad');
  const r=spawnSync(bridge,['app-server'],{input,encoding:'utf8',windowsHide:true,timeout:5000,env:{...process.env,CODEX_QUOTA_REAL_CLI:backend,CODEX_QUOTA_GUARD_HOME:settings.stateDir}});
  assert.equal(r.status,0,mode+': '+r.stderr);assert.deepEqual(JSON.parse(r.stdout),{id:1,result:{text:'你好 " \\'}});
 }
});
test('session launch and one-click rollback change only child environment; identity prevents killing another process',t=>{
 const {home,root,settings,backend}=fixture(t);let before;
 const cleanup=`$env:CODEX_QUOTA_GUARD_HOME=${quote(home)};& ${quote(process.execPath)} ${quote(path.join(root,'src/main.mjs'))} shutdown|Out-Null;`;
 try{
  before=ps(`$ErrorActionPreference='Stop';$before=@{};foreach($scope in @('User','Machine','Process')){$before[$scope]=[Environment]::GetEnvironmentVariable('CODEX_CLI_PATH',$scope)};
   & ./scripts/start-guarded-codex.ps1 -StateDir ${quote(home)} -AppPath ${quote(backend)};
   $record=Get-Content -LiteralPath ${quote(path.join(home,'desktop-launch.json'))} -Raw|ConvertFrom-Json;if(-not $record.guarded){throw 'Mock preflight did not enable scoped session'};
   & ./scripts/rollback.ps1 -StateDir ${quote(home)} -RestartDesktop;
   foreach($scope in @('User','Machine','Process')){if([Environment]::GetEnvironmentVariable('CODEX_CLI_PATH',$scope) -cne $before[$scope]){throw "Environment changed: $scope"}};'LAUNCH_ROLLBACK_OK'`);
  assert.match(before,/LAUNCH_ROLLBACK_OK/);
  const record=JSON.parse(fs.readFileSync(path.join(home,'desktop-launch.json'),'utf8').replace(/^\uFEFF/,''));
  assert.equal(record.guarded,false);assert.ok(fs.existsSync(path.join(home,'monitor-token')));
  // A reused PID or edited launch record must never terminate a foreign process.
  record.startedAt='2000-01-01T00:00:00Z';fs.writeFileSync(path.join(home,'desktop-launch.json'),JSON.stringify(record));
  assert.throws(()=>ps(`$ErrorActionPreference='Stop';& ./scripts/rollback.ps1 -StateDir ${quote(home)} -RestartDesktop`),/Recorded process identity changed/);
 }finally{
  ps(`${cleanup}if(Test-Path -LiteralPath ${quote(path.join(home,'desktop-launch.json'))}){$r=Get-Content -LiteralPath ${quote(path.join(home,'desktop-launch.json'))} -Raw|ConvertFrom-Json;$p=Get-Process -Id $r.processId -ErrorAction SilentlyContinue;if($p -and $p.Path -eq ${quote(backend)}){Stop-Process -Id $p.Id}}`);
 }
});
test('offline rollback disables automation without deleting its queue or legacy ledger',t=>{
 const home=testHome();t.after(()=>cleanHome(home));const file=path.join(home,'automation-state.json');
 const jobs=[{id:'kept',state:'pending',params:{input:['original']}}];fs.writeFileSync(file,JSON.stringify({version:1,enabled:true,jobs}));
 fs.writeFileSync(path.join(home,'state.json'),'legacy-kept');
 execFileSync(process.execPath,[path.join(ROOT,'scripts/safe-mode.mjs'),home],{windowsHide:true});
 const data=JSON.parse(fs.readFileSync(file,'utf8'));assert.equal(data.enabled,false);assert.deepEqual(data.jobs,jobs);assert.equal(fs.readFileSync(path.join(home,'state.json'),'utf8'),'legacy-kept');
 fs.writeFileSync(file,'{broken');assert.throws(()=>execFileSync(process.execPath,[path.join(ROOT,'scripts/safe-mode.mjs'),home],{stdio:'pipe',windowsHide:true}));assert.equal(fs.readFileSync(file,'utf8'),'{broken');
});
