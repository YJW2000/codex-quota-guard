param([string]$ProjectRoot=(Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference='Stop'
$compiler=Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if(-not(Test-Path -LiteralPath $compiler)){throw '.NET Framework C# compiler is required.'}
$output=Join-Path $ProjectRoot 'dist';New-Item -ItemType Directory -Path $output -Force|Out-Null
& $compiler /nologo /target:winexe /optimize+ /utf8output /reference:System.Windows.Forms.dll /reference:System.Drawing.dll /reference:System.Web.Extensions.dll "/out:$(Join-Path $output 'codex-quota-monitor.exe')" (Join-Path $ProjectRoot 'native\Monitor.cs')
if($LASTEXITCODE -ne 0){throw 'Monitor UI build failed.'}
