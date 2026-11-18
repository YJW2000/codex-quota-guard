function Assert-OwnInstallRoot([string]$InstallRoot) {
    $resolved = [IO.Path]::GetFullPath($InstallRoot)
    if ($resolved -eq [IO.Path]::GetPathRoot($resolved)) { throw 'Invalid install root.' }
    $cursor = $resolved
    while ($cursor) {
        if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Install root must not traverse reparse points.' }
        $cursor = Split-Path -Parent $cursor
    }
    if (Test-Path -LiteralPath $resolved) {
        if (@(Get-ChildItem -LiteralPath $resolved -Force -Recurse -Attributes ReparsePoint).Count -gt 0) { throw 'Owned install directory contains reparse points.' }
        $items = @(Get-ChildItem -LiteralPath $resolved -Force)
        if ($items.Count -gt 0) {
            $manifest = Join-Path $resolved 'plugin.json'
            if (-not (Test-Path -LiteralPath $manifest) -or (Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json).name -ne 'codex-quota-guard') { throw 'Install root is not an owned plugin directory.' }
        }
    }
}
function Set-MonitorStartup([string]$NativePath, [string]$StartupDir, [bool]$Enabled) {
    $shortcut = Join-Path $StartupDir 'Codex Quota Monitor.lnk'
    $shell = New-Object -ComObject WScript.Shell
    if (Test-Path -LiteralPath $shortcut) {
        $existing = $shell.CreateShortcut($shortcut)
        if (-not [string]::Equals($existing.TargetPath,$NativePath,[StringComparison]::OrdinalIgnoreCase)) { throw 'Startup shortcut belongs to another application.' }
    }
    if ($Enabled) {
        New-Item -ItemType Directory -Path $StartupDir -Force | Out-Null
        $link = $shell.CreateShortcut($shortcut); $link.TargetPath = $NativePath; $link.Arguments = '--tray'; $link.WorkingDirectory = Split-Path -Parent $NativePath; $link.Save()
    } elseif (Test-Path -LiteralPath $shortcut) { Remove-Item -LiteralPath $shortcut }
}
