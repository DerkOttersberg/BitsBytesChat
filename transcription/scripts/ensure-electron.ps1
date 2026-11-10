$ErrorActionPreference = 'Stop'
$packageRoot = Split-Path $PSScriptRoot
$electronRoot = Join-Path $packageRoot 'node_modules\electron'
if (Test-Path -LiteralPath (Join-Path $electronRoot 'dist\electron.exe')) {
  Set-Content -LiteralPath (Join-Path $electronRoot 'path.txt') -Value 'electron.exe' -NoNewline
  exit 0
}
Push-Location $packageRoot
try {
  # Use the checksum-verified official archive, with Windows ZIP extraction.
  $taskElectronArchive = & node --input-type=module -e 'import {downloadArtifact} from "@electron/get"; import {createRequire} from "node:module"; const require=createRequire(import.meta.url); console.log(await downloadArtifact({version:require("electron/package.json").version,artifactName:"electron",platform:"win32",arch:"x64"}));'
  if ($LASTEXITCODE -ne 0) { throw 'Electron download failed' }
  Expand-Archive -LiteralPath $taskElectronArchive.Trim() -DestinationPath (Join-Path $electronRoot 'dist') -Force
  Set-Content -LiteralPath (Join-Path $electronRoot 'path.txt') -Value 'electron.exe' -NoNewline
} finally { Pop-Location }
