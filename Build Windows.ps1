$ErrorActionPreference = 'Stop'
$projectRoot = $PSScriptRoot
$bunExe = Join-Path $projectRoot '.tools\bun-windows-x64\bun.exe'
if (-not (Test-Path -LiteralPath $bunExe)) {
  $found = Get-Command bun -ErrorAction SilentlyContinue
  if (-not $found) { throw 'Install Bun 1.3.14, then run this script again.' }
  $bunExe = $found.Source
}
$env:PATH = (Split-Path $bunExe) + ';' + $env:PATH
$env:OPENCODE_CHANNEL = 'prod'
Push-Location $projectRoot
try {
  & $bunExe install
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
  Push-Location (Join-Path $projectRoot 'packages\desktop')
  try {
    if (-not (Test-Path -LiteralPath 'node_modules\electron\dist\electron.exe')) {
      & $bunExe node_modules\electron\install.js
      if ($LASTEXITCODE -ne 0) { throw 'Electron installation failed' }
    }
    & $bunExe typecheck
    if ($LASTEXITCODE -ne 0) { throw 'Type checking failed' }
    & $bunExe run build
    if ($LASTEXITCODE -ne 0) { throw 'Application build failed' }
    & $bunExe run package:win -- --publish never
    if ($LASTEXITCODE -ne 0) { throw 'Windows packaging failed' }
  } finally { Pop-Location }
} finally { Pop-Location }
