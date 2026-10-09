param([switch]$ComputerTools, [switch]$ArtifactTools, [switch]$CloudAudio)
$ErrorActionPreference = 'Stop'
$runtimeRoot = Join-Path $env:LOCALAPPDATA 'BitsBytesChat\runtime'
New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
$uvExe = Join-Path $runtimeRoot 'uv.exe'
if (-not (Test-Path -LiteralPath $uvExe)) {
  $archive = Join-Path $runtimeRoot 'uv.zip'
  Invoke-WebRequest -Uri 'https://github.com/astral-sh/uv/releases/download/0.12.23/uv-x86_64-pc-windows-msvc.zip' -OutFile $archive
  Expand-Archive -LiteralPath $archive -DestinationPath $runtimeRoot -Force
}
$env:UV_PYTHON_INSTALL_DIR = Join-Path $runtimeRoot 'python'
$env:UV_CACHE_DIR = Join-Path $runtimeRoot 'cache'
$env:UV_PYTHON_BIN_DIR = Join-Path $runtimeRoot 'bin'
if ($ComputerTools) {
  & $uvExe python install 3.14.8 --no-bin
  if ($LASTEXITCODE -ne 0) { throw 'Python installation failed' }
  & $uvExe venv --allow-existing --python (Join-Path $runtimeRoot 'python\cpython-3.14.8-windows-x86_64-none\python.exe') (Join-Path $runtimeRoot 'windows-mcp')
  if ($LASTEXITCODE -ne 0) { throw 'Windows tools environment creation failed' }
  & $uvExe pip install --quiet --python (Join-Path $runtimeRoot 'windows-mcp\Scripts\python.exe') 'windows-mcp==0.8.7'
  if ($LASTEXITCODE -ne 0) { throw 'Windows tools installation failed' }
  exit 0
}
& $uvExe python install 3.12.11 --no-bin
if ($LASTEXITCODE -ne 0) { throw 'Python installation failed' }
$environment = Join-Path $runtimeRoot $(if ($ArtifactTools) { 'artifacts' } else { 'worker' })
& $uvExe venv --allow-existing --python (Join-Path $runtimeRoot 'python\cpython-3.12.11-windows-x86_64-none\python.exe') $environment
if ($LASTEXITCODE -ne 0) { throw 'Speech environment creation failed' }
& $uvExe pip install --quiet --python (Join-Path $environment 'Scripts\python.exe') --requirements (Join-Path $PSScriptRoot $(if ($ArtifactTools) { 'artifact-requirements.txt' } elseif ($CloudAudio) { 'requirements-audio-cloud.txt' } else { 'requirements.txt' }))
if ($LASTEXITCODE -ne 0) { throw 'Speech libraries installation failed' }
