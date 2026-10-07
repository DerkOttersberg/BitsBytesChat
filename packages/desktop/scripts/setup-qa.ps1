$ErrorActionPreference = 'Stop'
$qaProject = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..\..\..')).Path
$qaFolder = Join-Path $qaProject '.tools\qa'
New-Item -ItemType Directory -Path (Join-Path $qaFolder 'results') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'qa-package.json') -Destination (Join-Path $qaFolder 'package.json')
$qaBun = Join-Path $qaProject '.tools\bun-windows-x64\bun.exe'
if (-not (Test-Path -LiteralPath $qaBun)) { $qaBun = (Get-Command bun -ErrorAction Stop).Source }
& $qaBun install --cwd $qaFolder
if ($LASTEXITCODE -ne 0) { throw 'QA dependencies could not be installed.' }
Write-Host 'QA is ready. Run scripts from packages\desktop with Node.js 24 or later. Microsoft Edge supplies the browser.'
