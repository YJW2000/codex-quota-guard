param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'CodexQuotaGuard\app'),
    [string]$StateDir = (Join-Path $env:LOCALAPPDATA 'CodexQuotaGuard'),
    [string]$BackendPath = $env:CODEX_APP_RUNTIME_CLI_PATH,
    [switch]$SkipTests,
    [switch]$NoActivate,
    [switch]$SkipPluginInstall
)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
if (-not $BackendPath) { $BackendPath = (Get-Command codex.exe -ErrorAction Stop).Source }
$BackendPath = (Resolve-Path -LiteralPath $BackendPath).Path
if ([IO.Path]::GetFileName($BackendPath) -eq 'codex-quota-bridge.exe') { throw 'Provide the original Codex backend using -BackendPath.' }
$InstallRoot = [IO.Path]::GetFullPath($InstallRoot)
$StateDir = [IO.Path]::GetFullPath($StateDir)
if ($InstallRoot -eq [IO.Path]::GetPathRoot($InstallRoot) -or $StateDir -eq [IO.Path]::GetPathRoot($StateDir)) { throw 'Invalid install location.' }
if (-not $SkipTests) {
    & $nodePath (Join-Path $projectRoot 'scripts\check.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Source verification failed.' }
    & $nodePath (Join-Path $projectRoot 'scripts\test.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }
}
& (Join-Path $projectRoot 'scripts\build.ps1') -ProjectRoot $projectRoot
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
$probeLines = & $nodePath (Join-Path $projectRoot 'scripts\doctor.mjs') --backend $BackendPath
if ($LASTEXITCODE -ne 0) { throw 'Codex protocol compatibility check failed; no startup settings changed.' }
$probe = ($probeLines | Select-Object -Last 1) | ConvertFrom-Json
if (-not $probe.compatible) { throw 'Incompatible Codex engine.' }

New-Item -ItemType Directory -Path $StateDir -Force | Out-Null
$quotaSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $StateDir /inheritance:r /grant:r "*$($quotaSid):(OI)(CI)F" '*S-1-5-18:(OI)(CI)F' | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Unable to restrict runtime data access.' }
New-Item -ItemType Directory -Path $InstallRoot -Force | Out-Null
$backupPath = Join-Path $StateDir 'install-backup.json'
$utf8 = New-Object Text.UTF8Encoding($false)
if (-not (Test-Path -LiteralPath $backupPath)) {
    $backup = @{ previousCliPath = [Environment]::GetEnvironmentVariable('CODEX_CLI_PATH', 'User'); recordedAt = [DateTime]::UtcNow.ToString('o') }
    [IO.File]::WriteAllText($backupPath, ($backup | ConvertTo-Json), $utf8)
}
foreach ($entry in @('src', 'native', 'scripts', 'skills', 'assets', 'dist', '.codex-plugin', '.agents', 'plugin.json', 'mcp.json', 'package.json', 'README.md')) {
    $source = Join-Path $projectRoot $entry
    if (Test-Path -LiteralPath $source) { Copy-Item -LiteralPath $source -Destination $InstallRoot -Recurse -Force }
}
$nativePath = Join-Path $InstallRoot 'dist\codex-quota-bridge.exe'
$settings = @{ root = $InstallRoot; stateDir = $StateDir; backendPath = $BackendPath; nodePath = $nodePath; nativePath = $nativePath; testedEngineVersion = $probe.version; trayEnabled = (-not $NoActivate) }
[IO.File]::WriteAllText((Join-Path $InstallRoot 'installation.json'), ($settings | ConvertTo-Json), $utf8)
$mcpPath = Join-Path $InstallRoot 'mcp.json'
$mcpSettings = Get-Content -LiteralPath $mcpPath -Raw | ConvertFrom-Json
$mcpSettings.mcpServers.'quota-guard' | Add-Member -MemberType NoteProperty -Name env -Value @{ CODEX_QUOTA_GUARD_HOME = $StateDir } -Force
[IO.File]::WriteAllText($mcpPath, ($mcpSettings | ConvertTo-Json -Depth 20), $utf8)

if (-not $SkipPluginInstall) {
    & $BackendPath plugin marketplace add $InstallRoot --json
    if ($LASTEXITCODE -ne 0) { throw 'Marketplace registration failed; startup unchanged.' }
    & $BackendPath plugin add 'codex-quota-guard@quota-guard-local' --json
    if ($LASTEXITCODE -ne 0) { throw 'Plugin installation failed; startup unchanged.' }
}
if (-not $NoActivate) {
    [Environment]::SetEnvironmentVariable('CODEX_CLI_PATH', $nativePath, 'User')
    Write-Output 'Installed and configured. Fully exit Codex and reopen it to protect desktop tasks.'
} else { Write-Output 'Installed without changing CODEX_CLI_PATH.' }
Write-Output "Launcher: $nativePath"
Write-Output "Runtime data: $StateDir"
