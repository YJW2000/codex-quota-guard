param([string]$StateDir=(Join-Path $env:LOCALAPPDATA 'CodexQuotaGuard'),[string]$InstallRoot,[switch]$RemovePlugin,[string]$StartupDir=[Environment]::GetFolderPath('Startup'))
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'migration.ps1')
. (Join-Path $PSScriptRoot 'lifecycle.ps1')
if (-not $InstallRoot) { $InstallRoot=Join-Path $StateDir 'app' }
Repair-LegacyOverride $InstallRoot $StateDir | Format-Table -AutoSize
$settingsPath=Join-Path $InstallRoot 'installation.json'
if(Test-Path -LiteralPath $settingsPath) {
    $settings=Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8|ConvertFrom-Json
    if($settings.mode -eq 'independent-monitor') {
        $env:CODEX_QUOTA_GUARD_HOME=$StateDir
        & $settings.nodePath (Join-Path $InstallRoot 'src\main.mjs') shutdown | Out-Null
        Set-MonitorStartup (Join-Path $InstallRoot 'dist\codex-quota-monitor.exe') $StartupDir $false
        Start-Process -FilePath (Join-Path $InstallRoot 'dist\codex-quota-monitor.exe') -ArgumentList '--close-tray' -WindowStyle Hidden -Wait
    }
    if($RemovePlugin -and $settings.backendPath) { & $settings.backendPath plugin remove 'codex-quota-guard@quota-guard-local'; if($LASTEXITCODE -ne 0){throw 'Own plugin removal failed.'} }
}
Write-Output 'Monitor stopped. Credentials, sessions, projects, other plugins and legacy recovery data were preserved.'
