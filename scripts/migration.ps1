# Only this module may repair legacy startup overrides. Dot-sourcing is read-only.
function Normalize-OverridePath([string]$Value) {
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    try {
        $candidate = [Environment]::ExpandEnvironmentVariables($Value.Trim().Trim('"'))
        if (-not [IO.Path]::IsPathRooted($candidate)) { return $null }
        return [IO.Path]::GetFullPath($candidate).TrimEnd([IO.Path]::DirectorySeparatorChar, [IO.Path]::AltDirectorySeparatorChar)
    } catch { return $null }
}
function Get-LegacyRepairPlan([string]$Current, [string[]]$OwnedPaths, [object]$PreviousValue, [bool]$HasBackup = $false) {
    $normalized = Normalize-OverridePath $Current
    $owned = @($OwnedPaths | ForEach-Object { Normalize-OverridePath $_ })
    if (-not $normalized -or -not ($owned -contains $normalized)) { return @{ Action = 'Keep'; Value = $Current } }
    $previous = if ($HasBackup -and $PreviousValue -is [string]) { $PreviousValue } else { $null }
    if ([string]::IsNullOrEmpty($previous) -or ($owned -contains (Normalize-OverridePath $previous))) { return @{ Action = 'Delete'; Value = $null } }
    return @{ Action = 'Restore'; Value = $previous }
}
function Repair-LegacyOverride([string]$InstallRoot, [string]$StateDir) {
    $owned = @((Join-Path $env:LOCALAPPDATA 'CodexQuotaGuard\app\dist\codex-quota-bridge.exe'))
    # A custom directory is owned only when its plugin manifest proves identity.
    # The caller merely naming an InstallRoot is not evidence of ownership.
    $manifest = Join-Path $InstallRoot 'plugin.json'
    if (Test-Path -LiteralPath $manifest) {
        try { if ((Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 | ConvertFrom-Json).name -eq 'codex-quota-guard') { $owned += Join-Path $InstallRoot 'dist\codex-quota-bridge.exe' } } catch {}
    }
    $previous = $null; $hasBackup = $false
    $backup = Join-Path $StateDir 'install-backup.json'
    if (Test-Path -LiteralPath $backup) {
        try { $record = Get-Content -LiteralPath $backup -Raw -Encoding UTF8 | ConvertFrom-Json; $previous = $record.previousCliPath; $hasBackup = $true }
        catch { Write-Warning 'Legacy backup is invalid; only an exact owned override can be cleared.' }
    }
    foreach ($scope in @('User','Machine','Process')) {
        $current = [Environment]::GetEnvironmentVariable('CODEX_CLI_PATH', $scope)
        $plan = Get-LegacyRepairPlan $current $owned $previous ($hasBackup -and $scope -ne 'Machine')
        if ($plan.Action -ne 'Keep') {
            # Recheck immediately: never overwrite a path changed by the user meanwhile.
            if ([Environment]::GetEnvironmentVariable('CODEX_CLI_PATH',$scope) -cne $current) { continue }
            try { [Environment]::SetEnvironmentVariable('CODEX_CLI_PATH',$plan.Value,$scope) }
            catch { throw "Unable to repair owned legacy override in $scope scope. No new startup override was installed." }
        }
        [pscustomobject]@{ Scope = $scope; Action = $plan.Action }
    }
}
