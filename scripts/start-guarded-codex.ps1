param([string]$StateDir=(Join-Path $env:LOCALAPPDATA 'CodexQuotaGuard'),[string]$AppPath,[switch]$MonitorOnly)
$ErrorActionPreference='Stop'
$settings=Get-Content -LiteralPath (Join-Path $StateDir 'app/installation.json') -Raw -Encoding UTF8|ConvertFrom-Json
if(-not $AppPath){$package=Get-AppxPackage -Name 'OpenAI.Codex'|Select-Object -First 1;if(-not $package){throw 'Codex package not found'};$AppPath=Join-Path $package.InstallLocation 'app/Codex.exe'}
$AppPath=[IO.Path]::GetFullPath($AppPath)
# This launch is opt-in. Never stop the currently running desktop to inject a bridge.
$appRoot=Split-Path -Parent $AppPath
$existing=@(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -and (Split-Path -Parent $_.ExecutablePath) -eq $appRoot -and $_.Name -in @('Codex.exe','ChatGPT.exe') -and $_.CommandLine -notmatch '--type='})
if($existing.Count){throw 'Fully exit Codex first. Existing desktop tasks have not been interrupted.'}
$env:CODEX_QUOTA_GUARD_HOME=$StateDir
& $settings.nodePath (Join-Path $settings.root 'src/main.mjs') start
$useBridge=$false
if(-not $MonitorOnly){& $settings.nodePath (Join-Path $settings.root 'scripts/preflight.mjs') $settings.bridgePath $settings.backendPath;$useBridge=($LASTEXITCODE -eq 0)}
if(-not $useBridge){Write-Warning 'Guard preflight unavailable; launching the original desktop normally. Monitoring remains available.'}
$info=New-Object Diagnostics.ProcessStartInfo
$info.FileName=$AppPath;$info.UseShellExecute=$false
# Environment applies only to this newly created child; no User/Machine variable write.
if($useBridge){
 & $settings.nodePath (Join-Path $settings.root 'src/main.mjs') guard.enable|Out-Null
 $info.EnvironmentVariables['CODEX_CLI_PATH']=$settings.bridgePath
 $info.EnvironmentVariables['CODEX_QUOTA_REAL_CLI']=$settings.backendPath
 $info.EnvironmentVariables['CODEX_QUOTA_GUARD_HOME']=$StateDir
}else{
 $value=$info.EnvironmentVariables['CODEX_CLI_PATH']
 if($value -eq $settings.bridgePath){$info.EnvironmentVariables.Remove('CODEX_CLI_PATH')}
}
$started=[Diagnostics.Process]::Start($info)
@{processId=$started.Id;startedAt=$started.StartTime.ToUniversalTime().ToString('o');appPath=$AppPath;guarded=$useBridge}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $StateDir 'desktop-launch.json') -Encoding UTF8
Write-Output "Desktop launched. Guarded session: $useBridge. Global startup override unchanged."
