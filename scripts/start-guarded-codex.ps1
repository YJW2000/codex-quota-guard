param(
    [string]$StateDir=(Join-Path $env:LOCALAPPDATA 'CodexQuotaGuard'),
    [string]$AppPath,
    [switch]$MonitorOnly,
    [ValidateRange(1,120)][int]$HandshakeTimeoutSeconds=30
)
$ErrorActionPreference='Stop'
$settings=Get-Content -LiteralPath (Join-Path $StateDir 'app/installation.json') -Raw -Encoding UTF8|ConvertFrom-Json
if(-not $AppPath){
    $package=Get-AppxPackage -Name 'OpenAI.Codex'|Select-Object -First 1
    if(-not $package){throw 'Codex package not found.'}
    # Codex.exe is an activation stub on some releases. Launch the packaged
    # desktop executable directly so it inherits this one process environment.
    $manifest=Get-AppxPackageManifest -Package $package
    $entry=@($manifest.Package.Applications.Application | Where-Object { $_.Id -eq 'App' })
    if($entry.Count -ne 1 -or -not $entry[0].Executable){throw 'Cannot resolve the Codex desktop executable from its package manifest.'}
    $AppPath=Join-Path $package.InstallLocation $entry[0].Executable
}
$AppPath=[IO.Path]::GetFullPath($AppPath)
$appRoot=Split-Path -Parent $AppPath
$existing=@(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and (Split-Path -Parent $_.ExecutablePath) -eq $appRoot -and
    $_.Name -in @('Codex.exe','ChatGPT.exe') -and $_.CommandLine -notmatch '--type='
})
if($existing.Count){throw 'Fully exit Codex first. Existing desktop tasks have not been interrupted.'}
$env:CODEX_QUOTA_GUARD_HOME=$StateDir
$main=Join-Path $settings.root 'src/main.mjs'
& $settings.nodePath $main start
$useBridge=$false
if(-not $MonitorOnly){
    & $settings.nodePath (Join-Path $settings.root 'scripts/preflight.mjs') $settings.bridgePath $settings.backendPath
    $useBridge=($LASTEXITCODE -eq 0)
}
$info=New-Object Diagnostics.ProcessStartInfo
$info.FileName=$AppPath
$info.UseShellExecute=$false
if($useBridge){
    & $settings.nodePath $main enable|Out-Null
    $launchId=[Guid]::NewGuid().ToString()
    $info.EnvironmentVariables['CODEX_QUOTA_LAUNCH_ID']=$launchId
    $info.EnvironmentVariables['CODEX_CLI_PATH']=$settings.bridgePath
    $info.EnvironmentVariables['CODEX_QUOTA_REAL_CLI']=$settings.backendPath
    $info.EnvironmentVariables['CODEX_QUOTA_GUARD_HOME']=$StateDir
    $info.EnvironmentVariables.Remove('CODEX_QUOTA_PREFLIGHT')
}else{
    Write-Warning 'Launching the original desktop with independent monitoring.'
    if($info.EnvironmentVariables['CODEX_CLI_PATH'] -eq $settings.bridgePath){$info.EnvironmentVariables.Remove('CODEX_CLI_PATH')}
    $info.EnvironmentVariables.Remove('CODEX_QUOTA_LAUNCH_ID')
}

$started=[Diagnostics.Process]::Start($info)
try{$created=$started.StartTime.ToUniversalTime().ToString('o')}catch{$created=$null}
$record=@{processId=$started.Id;startedAt=$created;appPath=$AppPath;guarded=$false;sessionId=$launchId}
$recordFile=Join-Path $StateDir 'desktop-launch.json'
$record | ConvertTo-Json | Set-Content -LiteralPath $recordFile -Encoding UTF8
if($useBridge){
    & $settings.nodePath (Join-Path $settings.root 'scripts/wait-session.mjs') $launchId $HandshakeTimeoutSeconds
    if($LASTEXITCODE -ne 0){
        throw 'Codex 已打开，本次启动尚未确认任务引擎连接。请在托盘查看实时连接状态；当前桌面可以继续使用。'
    }
    $record.guarded=$true
    $record | ConvertTo-Json | Set-Content -LiteralPath $recordFile -Encoding UTF8
}
Write-Output "Desktop launched. Engine handshake confirmed: $($record.guarded)."
