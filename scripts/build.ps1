param([string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) { throw '.NET Framework C# compiler is required.' }
$output = Join-Path $ProjectRoot 'dist'
New-Item -ItemType Directory -Path $output -Force | Out-Null
& $compiler /nologo /target:exe /optimize+ /utf8output /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/out:$(Join-Path $output 'codex-quota-bridge.exe')" (Join-Path $ProjectRoot 'native\Launcher.cs')
if ($LASTEXITCODE -ne 0) { throw 'Native launcher build failed.' }
Write-Output 'Native launcher built.'
