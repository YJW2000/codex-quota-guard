param([string]$StateDir=(Join-Path $env:LOCALAPPDATA 'CodexQuotaGuard'),[switch]$RestartDesktop)
$ErrorActionPreference='Stop'
$settings=Get-Content -LiteralPath (Join-Path $StateDir 'app/installation.json') -Raw -Encoding UTF8|ConvertFrom-Json
$env:CODEX_QUOTA_GUARD_HOME=$StateDir
& $settings.nodePath (Join-Path $settings.root 'src/main.mjs') guard.safeMode
& $settings.nodePath (Join-Path $settings.root 'scripts/safe-mode.mjs') $StateDir
if($LASTEXITCODE -ne 0){Write-Warning 'Automation state could not be changed offline; data was preserved. The desktop relaunch still bypasses this bridge.'}
# Rollback keeps the independent monitor and all pending work. It never uninstalls the plugin.
. (Join-Path $PSScriptRoot 'migration.ps1')
Repair-LegacyOverride $settings.root $StateDir|Out-Null
if($RestartDesktop){
 if(-not (Test-Path -LiteralPath (Join-Path $StateDir 'desktop-launch.json'))){Write-Output 'No guarded desktop was recorded; safe mode is active and monitoring is retained.';return}
 $record=Get-Content -LiteralPath (Join-Path $StateDir 'desktop-launch.json') -Raw -Encoding UTF8|ConvertFrom-Json
 $process=Get-Process -Id $record.processId -ErrorAction SilentlyContinue
 if($process){
  if(-not [string]::Equals($process.Path,$record.appPath,[StringComparison]::OrdinalIgnoreCase) -or [Math]::Abs(($process.StartTime.ToUniversalTime()-[DateTime]::Parse($record.startedAt).ToUniversalTime()).TotalSeconds) -gt 1){throw 'Recorded process identity changed; refusing to stop another application.'}
  Stop-Process -Id $process.Id; $process.WaitForExit(5000)|Out-Null
 }
 $info=New-Object Diagnostics.ProcessStartInfo;$info.FileName=$record.appPath;$info.UseShellExecute=$false
 if($info.EnvironmentVariables['CODEX_CLI_PATH'] -eq $settings.bridgePath){$info.EnvironmentVariables.Remove('CODEX_CLI_PATH')}
 $restarted=[Diagnostics.Process]::Start($info)
 @{processId=$restarted.Id;startedAt=$restarted.StartTime.ToUniversalTime().ToString('o');appPath=$record.appPath;guarded=$false}|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $StateDir 'desktop-launch.json') -Encoding UTF8
}
Write-Output 'Safe mode: monitoring and plugin retained; automation is recoverably off. RestartDesktop can reopen the recorded desktop without the bridge.'
