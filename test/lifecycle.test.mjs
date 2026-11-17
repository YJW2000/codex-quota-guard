import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {execFileSync,spawnSync} from 'node:child_process';
import {ROOT} from '../src/client.mjs';
import {testHome,cleanHome} from './helpers.mjs';
const ps=(script)=>execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-Command',script],{encoding:'utf8',windowsHide:true,cwd:ROOT});
const quote=s=>"'"+s.replaceAll("'","''")+"'";
test('legacy repair decisions: exact ownership, missing override, backup, foreign path',()=>{
 const out=ps(`. ./scripts/migration.ps1; $owned=@('C:\\guard\\app\\dist\\codex-quota-bridge.exe'); @(
 (Get-LegacyRepairPlan 'C:\\guard\\app\\dist\\codex-quota-bridge.exe' $owned $null $true),
 (Get-LegacyRepairPlan 'C:\\guard\\app\\dist\\codex-quota-bridge.exe' $owned 'C:\\custom\\codex.exe' $true),
 (Get-LegacyRepairPlan 'C:\\other\\codex-quota-bridge.exe' $owned $null $false),
 (Get-LegacyRepairPlan $null $owned 'C:\\custom\\codex.exe' $true),
 (Get-LegacyRepairPlan '"C:\\GUARD\\app\\dist\\codex-quota-bridge.exe"' $owned 'C:\\guard\\app\\dist\\codex-quota-bridge.exe' $true)
 ) | ConvertTo-Json -Compress`);
 const rows=JSON.parse(out);assert.deepEqual(rows.map(r=>r.Action),['Delete','Restore','Keep','Keep','Delete']);assert.equal(rows[1].Value,'C:\\custom\\codex.exe');
});
test('install, update, optional monitor autostart and uninstall preserve desktop settings and sentinel Codex data',t=>{
 const home=testHome();t.after(()=>cleanHome(home));const runtime=path.join(home,'runtime'),app=path.join(runtime,'app'),startup=path.join(home,'startup'),codex=path.join(home,'codex');fs.mkdirSync(codex);
 const sentinels=['auth.json','config.toml','sessions','projects','plugins.json'];for(const f of sentinels)fs.writeFileSync(path.join(codex,f),'sentinel-'+f);
 const script=`$ErrorActionPreference='Stop';$before=@{};foreach($scope in @('User','Machine','Process')){$before[$scope]=[Environment]::GetEnvironmentVariable('CODEX_CLI_PATH',$scope)};
 $env:CODEX_HOME=${quote(codex)};
 & ./scripts/install.ps1 -InstallRoot ${quote(app)} -StateDir ${quote(runtime)} -StartupDir ${quote(startup)} -SkipTests -AutoStart;
 & ./scripts/install.ps1 -InstallRoot ${quote(app)} -StateDir ${quote(runtime)} -StartupDir ${quote(startup)} -SkipTests;
 & ./scripts/uninstall.ps1 -InstallRoot ${quote(app)} -StateDir ${quote(runtime)} -StartupDir ${quote(startup)};
 foreach($scope in @('User','Machine','Process')){if([Environment]::GetEnvironmentVariable('CODEX_CLI_PATH',$scope) -cne $before[$scope]){throw "Override changed: $scope"}};
 if(Test-Path -LiteralPath ${quote(path.join(startup,'Codex Quota Monitor.lnk'))}){throw 'Own autostart was not removed'};
 'LIFECYCLE_OK'`;
 const out=ps(script);assert.match(out,/LIFECYCLE_OK/);for(const f of sentinels)assert.equal(fs.readFileSync(path.join(codex,f),'utf8'),'sentinel-'+f);
 const settings=JSON.parse(fs.readFileSync(path.join(app,'installation.json'),'utf8'));assert.equal(settings.mode,'independent-monitor');assert.equal(fs.existsSync(path.join(app,'dist/codex-quota-bridge.exe')),true);
 const validate=spawnSync(path.join(app,'dist/codex-quota-monitor.exe'),['--validate'],{windowsHide:true});assert.equal(validate.status,0);
 const reject=spawnSync(path.join(app,'dist/codex-quota-monitor.exe'),['app-server'],{windowsHide:true});assert.equal(reject.status,2);
});
test('foreign per-process startup override is preserved; owned process override safely migrates',()=>{
 const script=`. ./scripts/migration.ps1; $homeDir=Join-Path (Get-Location) '.cache/migration-fixture';New-Item -ItemType Directory -Path $homeDir -Force|Out-Null;
 New-Item -ItemType Directory -Path (Join-Path $homeDir 'app') -Force|Out-Null; @{name='codex-quota-guard'}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $homeDir 'app/plugin.json') -Encoding UTF8; $original=$env:CODEX_CLI_PATH;try{
 $env:CODEX_CLI_PATH='C:\\custom\\codex.exe';Repair-LegacyOverride (Join-Path $homeDir 'app') $homeDir|Out-Null;if($env:CODEX_CLI_PATH -ne 'C:\\custom\\codex.exe'){throw 'Foreign override changed'};
 $env:CODEX_CLI_PATH=Join-Path $homeDir 'app/dist/codex-quota-bridge.exe';Repair-LegacyOverride (Join-Path $homeDir 'app') $homeDir|Out-Null;if($env:CODEX_CLI_PATH){throw 'Owned override not removed'};
 }finally{$env:CODEX_CLI_PATH=$original};'MIGRATION_OK'`;
 assert.match(ps(script),/MIGRATION_OK/);
});
test('persistent launch override writes are confined to guarded legacy migration',()=>{
 for(const dir of ['src','scripts','native'])for(const f of fs.readdirSync(path.join(ROOT,dir),{recursive:true})){
  if(!/\.(mjs|ps1|cs)$/.test(f))continue;const full=path.join(ROOT,dir,f),s=fs.readFileSync(full,'utf8');
  if(f!=='migration.ps1')assert.doesNotMatch(s,/SetEnvironmentVariable\(['"]CODEX_CLI_PATH|\$env:CODEX_CLI_PATH\s*=|setx\s+CODEX_CLI_PATH|Set-ItemProperty.*CODEX_CLI_PATH/i,full);
  if(!['automation.mjs','bridge.mjs','Bridge.cs'].includes(f))assert.doesNotMatch(s,/turn\/start|turn\/interrupt|thread\/resume|RunInherited|CreateProcess\(/,full);
  if(/EnvironmentVariables\[['"]CODEX_CLI_PATH/.test(s))assert.ok(['start-guarded-codex.ps1','rollback.ps1'].includes(f),full);
 }
});

test('recorded original restores only an owned override; an absent value is not resurrected',t=>{
 const home=testHome();t.after(()=>cleanHome(home));fs.mkdirSync(path.join(home,'app'));fs.writeFileSync(path.join(home,'app/plugin.json'),JSON.stringify({name:'codex-quota-guard'}));fs.writeFileSync(path.join(home,'install-backup.json'),JSON.stringify({previousCliPath:'C:\\custom\\original.exe'}));
 const script=`. ./scripts/migration.ps1; $saved=$env:CODEX_CLI_PATH;try{
 $env:CODEX_CLI_PATH=$null;Repair-LegacyOverride ${quote(path.join(home,'app'))} ${quote(home)}|Out-Null;if($env:CODEX_CLI_PATH){throw 'Absent override resurrected'};
 $env:CODEX_CLI_PATH=Join-Path ${quote(home)} 'app/dist/codex-quota-bridge.exe';Repair-LegacyOverride ${quote(path.join(home,'app'))} ${quote(home)}|Out-Null;
 if($env:CODEX_CLI_PATH -ne 'C:\\custom\\original.exe'){throw 'Original backup not restored'};
 }finally{$env:CODEX_CLI_PATH=$saved};'RESTORE_OK'`;
 assert.match(ps(script),/RESTORE_OK/);
});
test('foreign startup shortcut with the same name is never overwritten or deleted',t=>{
 const home=testHome();t.after(()=>cleanHome(home));
 const script=`. ./scripts/lifecycle.ps1;$dir=${quote(home)};$file=Join-Path $dir 'Codex Quota Monitor.lnk';$shell=New-Object -ComObject WScript.Shell;$link=$shell.CreateShortcut($file);$link.TargetPath='C:\\foreign\\app.exe';$link.Save();
 $before=[Convert]::ToBase64String([IO.File]::ReadAllBytes($file));$rejected=$false;try{Set-MonitorStartup 'C:\\monitor\\codex-quota-monitor.exe' $dir $false}catch{$rejected=$true};
 if(-not $rejected -or [Convert]::ToBase64String([IO.File]::ReadAllBytes($file)) -ne $before){throw 'Foreign shortcut changed'};'SHORTCUT_OK'`;
 assert.match(ps(script),/SHORTCUT_OK/);
});

test('a caller-supplied custom directory without plugin identity cannot claim a foreign override',t=>{
 const home=testHome();t.after(()=>cleanHome(home));
 const script=`. ./scripts/migration.ps1;$saved=$env:CODEX_CLI_PATH;try{$env:CODEX_CLI_PATH=Join-Path ${quote(home)} 'app/dist/codex-quota-bridge.exe';$before=$env:CODEX_CLI_PATH;Repair-LegacyOverride ${quote(path.join(home,'app'))} ${quote(home)}|Out-Null;if($env:CODEX_CLI_PATH -cne $before){throw 'Unowned path changed'}}finally{$env:CODEX_CLI_PATH=$saved};'UNOWNED_OK'`;
 assert.match(ps(script),/UNOWNED_OK/);
});
