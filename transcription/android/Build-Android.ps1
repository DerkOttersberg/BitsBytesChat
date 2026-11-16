param(
    [string]$OutputDirectory = "$PSScriptRoot/artifacts"
)
$ErrorActionPreference = 'Stop'
if (!$env:ANDROID_HOME -or !(Test-Path -LiteralPath $env:ANDROID_HOME)) { throw 'Set ANDROID_HOME to your Android SDK.' }
if (!$env:BITSBYTES_ANDROID_KEYSTORE -or !(Test-Path -LiteralPath $env:BITSBYTES_ANDROID_KEYSTORE)) { throw 'Set BITSBYTES_ANDROID_KEYSTORE to your private release keystore.' }
if (!$env:BITSBYTES_ANDROID_PASSWORD_FILE -or !(Test-Path -LiteralPath $env:BITSBYTES_ANDROID_PASSWORD_FILE)) { throw 'Set BITSBYTES_ANDROID_PASSWORD_FILE to the private password file.' }
Push-Location $PSScriptRoot
try {
    & ./gradlew.bat assembleRelease lintRelease --console=plain
    if ($LASTEXITCODE -ne 0) { throw 'Android build or lint failed.' }
    $taskTools = Get-ChildItem -LiteralPath "$env:ANDROID_HOME/build-tools" -Directory | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
    $taskApk = "$PSScriptRoot/app/build/outputs/apk/release/app-release.apk"
    & "$($taskTools.FullName)/apksigner.bat" verify --verbose --print-certs $taskApk
    if ($LASTEXITCODE -ne 0) { throw 'APK signature verification failed.' }
    New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
    $taskDestination = Join-Path $OutputDirectory 'BitsBytes-Transcription-Android-1.0.0.apk'
    Copy-Item -LiteralPath $taskApk -Destination $taskDestination
    $taskHash = (Get-FileHash -LiteralPath $taskDestination -Algorithm SHA256).Hash.ToLowerInvariant()
    [IO.File]::WriteAllText((Join-Path $OutputDirectory 'SHA256SUMS.txt'), "$taskHash  BitsBytes-Transcription-Android-1.0.0.apk`n")
    Write-Output $taskDestination
} finally { Pop-Location }
