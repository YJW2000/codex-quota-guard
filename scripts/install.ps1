param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'CodexQuotaGuard\app'),
    [string]$StateDir = (Join-Path $env:LOCALAPPDATA 'CodexQuotaGuard'),
    [string]$BackendPath,
    [switch]$SkipTests,
    [switch]$RegisterPlugin,
    [switch]$AutoStart,
    [string]$StartupDir = [Environment]::GetFolderPath('Startup')
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'migration.ps1')
. (Join-Path $PSScriptRoot 'lifecycle.ps1')
$projectRoot = Split-Path -Parent $PSScriptRoot
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot); $StateDir = [IO.Path]::GetFullPath($StateDir)
Assert-OwnInstallRoot $InstallRoot
# Run repair even offline. Only exact legacy paths may change.
Repair-LegacyOverride $InstallRoot $StateDir | Format-Table -AutoSize
if ($StateDir -eq [IO.Path]::GetPathRoot($StateDir) -or (Test-Path -LiteralPath (Join-Path $StateDir 'auth.json')) -or $StateDir -eq (Join-Path $env:USERPROFILE '.codex')) { throw 'Monitor data must use a dedicated directory, not CODEX_HOME.' }
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
if (-not $BackendPath) { $BackendPath = $env:CODEX_APP_RUNTIME_CLI_PATH }
if (-not $BackendPath) { $package=$null;try{$package=Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction Stop|Select-Object -First 1}catch{};if($package){$candidate=Join-Path $package.InstallLocation 'app/resources/codex.exe';if(Test-Path -LiteralPath $candidate){$BackendPath=$candidate}} }
if (-not $BackendPath) { $command = Get-Command codex.exe -ErrorAction SilentlyContinue; if ($command) { $BackendPath = $command.Source } }
if ($BackendPath -match '(^|[\\/])codex-quota-(bridge|monitor)\.exe$') { $BackendPath = $null }
if (-not $SkipTests) {
    & $nodePath (Join-Path $projectRoot 'scripts\check.mjs'); if ($LASTEXITCODE -ne 0) { throw 'Source verification failed.' }
    & $nodePath (Join-Path $projectRoot 'scripts\test.mjs'); if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }
}
& (Join-Path $projectRoot 'scripts\build.ps1') -ProjectRoot $projectRoot
# Never overwrite a running session bridge, and never stop a desktop by process name.
$bridgeFile=Join-Path $InstallRoot 'dist/codex-quota-bridge.exe'
$inUse=@(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -and [string]::Equals($_.ExecutablePath,$bridgeFile,[StringComparison]::OrdinalIgnoreCase)})
if($inUse.Count){throw 'The installed bridge is running. Exit the old tray or guarded desktop before updating; no desktop was stopped.'}
$oldSettingsFile=Join-Path $InstallRoot 'installation.json'
if(Test-Path -LiteralPath $oldSettingsFile){
 $old=Get-Content -LiteralPath $oldSettingsFile -Raw -Encoding UTF8|ConvertFrom-Json
 if($old.mode -eq 'independent-monitor'){
  $env:CODEX_QUOTA_GUARD_HOME=$StateDir
  & $old.nodePath (Join-Path $InstallRoot 'src/main.mjs') shutdown|Out-Null
  $trayFile=Join-Path $InstallRoot 'dist/codex-quota-monitor.exe'
  if(Test-Path -LiteralPath $trayFile){& $trayFile --close-tray}
  for($attempt=0;$attempt -lt 50;$attempt++){
   $tray=@(Get-CimInstance Win32_Process|Where-Object{$_.ExecutablePath -and [string]::Equals($_.ExecutablePath,$trayFile,[StringComparison]::OrdinalIgnoreCase)})
   if(-not $tray.Count){break};Start-Sleep -Milliseconds 100
  }
  if($tray.Count){throw 'The monitor tray did not exit. Close that tray before updating.'}
 }
}
New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
$quotaSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $StateDir /inheritance:r /grant:r "*$($quotaSid):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to restrict monitor data access.' }
New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
foreach ($entry in @('src','native','scripts','skills','assets','docs','.codex-plugin','.agents','plugin.json','mcp.json','package.json','README.md','rollback.cmd')) {
    $source = Join-Path $projectRoot $entry
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $InstallRoot -Recurse -Force }
}
New-Item -ItemType Directory -Path (Join-Path $InstallRoot 'dist') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $projectRoot 'dist\codex-quota-monitor.exe') -Destination (Join-Path $InstallRoot 'dist') -Force
Copy-Item -LiteralPath (Join-Path $projectRoot 'dist\codex-quota-bridge.exe') -Destination (Join-Path $InstallRoot 'dist') -Force
# Retire superseded v0.1 sources without touching data or pending work.
foreach ($relative in @('src\controller.mjs','native\Launcher.cs')) {
    $target = [IO.Path]::GetFullPath((Join-Path $InstallRoot $relative))
    if (-not $target.StartsWith($InstallRoot.TrimEnd([IO.Path]::DirectorySeparatorChar)+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)) { throw 'Unsafe legacy path.' }
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Force }
}
$utf8 = New-Object Text.UTF8Encoding($false)
$settings = @{ root=$InstallRoot; stateDir=$StateDir; backendPath=$BackendPath; nodePath=$nodePath; nativePath=(Join-Path $InstallRoot 'dist\codex-quota-monitor.exe'); mode='independent-monitor'; version='0.3.0'; bridgePath=(Join-Path $InstallRoot 'dist\codex-quota-bridge.exe') }
[IO.File]::WriteAllText((Join-Path $InstallRoot 'installation.json'),($settings|ConvertTo-Json),$utf8)
$mcpPath = Join-Path $InstallRoot 'mcp.json'; $mcp = Get-Content -LiteralPath $mcpPath -Raw -Encoding UTF8 | ConvertFrom-Json
$mcp.mcpServers.'quota-guard' | Add-Member NoteProperty env @{ CODEX_QUOTA_GUARD_HOME=$StateDir } -Force
[IO.File]::WriteAllText($mcpPath,($mcp|ConvertTo-Json -Depth 20),$utf8)
if ($AutoStart) { Set-MonitorStartup $settings.nativePath $StartupDir $true }
if ($RegisterPlugin) {
    if (-not $BackendPath) { throw 'Original CLI unavailable; standalone monitor installed. Plugin registration was not attempted.' }
    & $BackendPath plugin marketplace add $InstallRoot --json; if ($LASTEXITCODE -ne 0) { throw 'Own marketplace registration failed.' }
    & $BackendPath plugin add 'codex-quota-guard@quota-guard-local' --json; if ($LASTEXITCODE -ne 0) { throw 'Own plugin registration failed.' }
}
Write-Output 'Independent monitor installed. Codex launch is unchanged. Start monitoring separately using start-monitor.ps1.'
