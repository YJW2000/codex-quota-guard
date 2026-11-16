param([string]$StateDir = (Join-Path $env:LOCALAPPDATA 'CodexQuotaGuard'))
$ErrorActionPreference = 'Stop'
$settings = Get-Content -LiteralPath (Join-Path $StateDir 'app\installation.json') -Raw | ConvertFrom-Json
$env:CODEX_CLI_PATH = $settings.nativePath
$env:CODEX_QUOTA_GUARD_HOME = $StateDir
$package = Get-AppxPackage -Name 'OpenAI.Codex' | Select-Object -First 1
if (-not $package) { throw 'Codex Windows package not found.' }
$appPath = Join-Path $package.InstallLocation 'app\Codex.exe'
Start-Process -FilePath $appPath -WindowStyle Hidden
