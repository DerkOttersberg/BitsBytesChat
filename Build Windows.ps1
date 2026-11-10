$ErrorActionPreference = 'Stop'
Push-Location (Join-Path $PSScriptRoot 'transcription')
try {
  & npm ci --no-audit --no-fund
  if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed' }
  & (Join-Path $PSScriptRoot 'transcription\scripts\ensure-electron.ps1')
  & npm run typecheck
  if ($LASTEXITCODE -ne 0) { throw 'Type checking failed' }
  & npm test
  if ($LASTEXITCODE -ne 0) { throw 'Recovery tests failed' }
  & npm run build
  if ($LASTEXITCODE -ne 0) { throw 'Application build failed' }
  & npm run test:desktop
  if ($LASTEXITCODE -ne 0) { throw 'Desktop tests failed' }
  & npm run package:win
  if ($LASTEXITCODE -ne 0) { throw 'Installer build failed' }
} finally { Pop-Location }
