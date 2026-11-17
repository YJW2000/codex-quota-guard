param([string]$StateDir=(Join-Path $env:LOCALAPPDATA 'CodexQuotaGuard'))
$ErrorActionPreference='Stop'
$settings=Get-Content -LiteralPath (Join-Path $StateDir 'app\installation.json') -Raw -Encoding UTF8|ConvertFrom-Json
if($settings.mode -ne 'independent-monitor'){throw 'Install the independent monitor version first.'}
$env:CODEX_QUOTA_GUARD_HOME=$StateDir
& $settings.nodePath (Join-Path $settings.root 'src\main.mjs') start
Start-Process -FilePath $settings.nativePath -ArgumentList '--tray' -WindowStyle Hidden
