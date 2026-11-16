param([string]$StateDir = (Join-Path $env:LOCALAPPDATA 'CodexQuotaGuard'))
$ErrorActionPreference = 'Stop'
$StateDir = [IO.Path]::GetFullPath($StateDir)
$settingsPath = Join-Path $StateDir 'app\installation.json'
$settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json
$current = [Environment]::GetEnvironmentVariable('CODEX_CLI_PATH', 'User')
if ($current -eq $settings.nativePath) {
    $backup = Get-Content -LiteralPath (Join-Path $StateDir 'install-backup.json') -Raw | ConvertFrom-Json
    [Environment]::SetEnvironmentVariable('CODEX_CLI_PATH', $backup.previousCliPath, 'User')
}
$env:CODEX_QUOTA_GUARD_HOME = $StateDir
& $settings.nativePath --close-tray
& $settings.nodePath (Join-Path $settings.root 'src\main.mjs') disable
& $settings.nodePath (Join-Path $settings.root 'src\main.mjs') shutdown
& $settings.backendPath plugin remove 'codex-quota-guard@quota-guard-local'
if ($LASTEXITCODE -ne 0) { Write-Warning 'Plugin removal needs checking in Codex settings.' }
Write-Output 'Startup override restored. Restart Codex. Runtime data and recovery records are retained.'
