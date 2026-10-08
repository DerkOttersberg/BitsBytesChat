$ErrorActionPreference = 'Stop'
$bitsProject = $PSScriptRoot
$bitsBuild = (Get-Content -LiteralPath (Join-Path $bitsProject 'packages\desktop\package.json') -Raw | ConvertFrom-Json).version
$bitsExe = Join-Path $bitsProject "packages\desktop\dist\$bitsBuild\win-unpacked\BitsBytesChat.exe"
$bitsRoot = Join-Path $env:LOCALAPPDATA 'BitsBytesChat'
$bitsDesktop = Join-Path $bitsRoot 'desktop'
$bitsLogFolder = Join-Path $bitsRoot 'launcher'
$bitsHiddenQA = $env:BB_QA_ISOLATED -eq '1' -and $env:BB_QA_HIDDEN -eq '1'
$bitsQAOwned = @($env:BB_QA_OWNED_PIDS -split ',' | Where-Object { $_ -match '^\d+$' })
$bitsStartOptions = @{}
if ($bitsHiddenQA) { $bitsStartOptions.WindowStyle = 'Hidden' }

function Get-BitsInstances {
  $processes = @(Get-CimInstance Win32_Process -Filter "Name = 'BitsBytesChat.exe' OR Name = 'BitsBytesChat-Mobile.exe'")
  foreach ($entry in $processes) {
    if (-not $entry.ExecutablePath -or $entry.CommandLine -match '(?:^|\s)--type=') { continue }
    # Node/MCP helpers use the same executable, but belong to their parent app.
    if ($processes.ProcessId -contains $entry.ParentProcessId) { continue }
    if ($entry.SessionId -ne (Get-Process -Id $PID).SessionId) { continue }
    $children = @($processes | Where-Object { $_.ParentProcessId -eq $entry.ProcessId })
    $profiles = @($children | ForEach-Object {
      if ($_.CommandLine -match '--user-data-dir=(?:"([^"]+)"|(\S+))') {
        if ($Matches[1]) { $Matches[1] } else { $Matches[2] }
      }
    })
    # Different local-data profiles can run together, as in an isolated test.
    if ($profiles.Count -gt 0 -and -not ($profiles -contains $bitsDesktop)) { continue }
    # A profile-less helper cannot be attributed to this QA run by its name.
    # Only an explicitly owned PID may participate in a hidden recovery check.
    if ($bitsHiddenQA -and $profiles.Count -eq 0 -and -not ($bitsQAOwned -contains [string]$entry.ProcessId)) { continue }
    if (-not (Test-Path -LiteralPath $entry.ExecutablePath)) { continue }
    if ([Diagnostics.FileVersionInfo]::GetVersionInfo($entry.ExecutablePath).ProductName -notmatch '^BitsBytesChat(?:-Mobile)?$') { continue }
    $entry
  }
}

try {
  if (-not (Test-Path -LiteralPath $bitsExe)) {
    throw 'The Windows build is missing. See README.BitsBytes.md for build instructions.'
  }
  $bitsVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($bitsExe).FileVersion
  $existing = @(Get-BitsInstances)
  foreach ($entry in $existing) {
    $process = Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue
    if (-not $process) { continue }
    $process.Refresh()
    if ($entry.ExecutablePath -eq $bitsExe -and ($process.MainWindowHandle -ne 0 -or ($bitsHiddenQA -and -not ($bitsQAOwned -contains [string]$entry.ProcessId)))) {
      # Electron forwards this launch to the existing window.
      Start-Process -FilePath $bitsExe -WorkingDirectory (Split-Path $bitsExe) @bitsStartOptions
      exit 0
    }
    $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($entry.ExecutablePath).FileVersion
    Write-Host "Bits & Bytes Chat v$version is already running (process $($entry.ProcessId))."
    if ($process.MainWindowHandle -eq 0) {
      Write-Host 'It has no visible window and prevents another copy from opening.'
    }
    Write-Host "To open v$bitsVersion, the existing copy must close first."
    $answer = Read-Host 'Close this copy and open the new build? Any active work may be interrupted. [y/N]'
    if ($answer -notmatch '^(?i:y|yes)$') {
      Write-Host 'The existing copy was left running. No files or chats were removed.'
      exit 0
    }
    # Recheck identity before acting on the explicitly approved process.
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($entry.ProcessId)"
    if (-not $current) { continue }
    if ($current.CreationDate -ne $entry.CreationDate -or $current.ExecutablePath -ne $entry.ExecutablePath) {
      throw 'The running process changed. Run the launcher again.'
    }
    if ($process.MainWindowHandle -ne 0 -and $process.CloseMainWindow()) {
      if ($process.WaitForExit(8000)) { continue }
      $answer = Read-Host 'The app did not close. Force-close this copy and its background tools? [y/N]'
      if ($answer -notmatch '^(?i:y|yes)$') { exit 0 }
    }
    & "$env:SystemRoot\System32\taskkill.exe" /PID $entry.ProcessId /T /F | Out-Null
    if ($LASTEXITCODE -ne 0 -and (Get-Process -Id $entry.ProcessId -ErrorAction SilentlyContinue)) {
      throw 'The background copy could not be closed. Close BitsBytesChat in Task Manager and try again.'
    }
    if (-not $process.WaitForExit(8000)) { throw 'The previous copy is still closing. Try again in a moment.' }
  }

  New-Item -ItemType Directory -Path $bitsLogFolder -Force | Out-Null
  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $stdout = Join-Path $bitsLogFolder "$stamp-stdout.log"
  $stderr = Join-Path $bitsLogFolder "$stamp-stderr.log"
  # These flags belong to Electron's command-line helpers, not its desktop UI.
  Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
  Remove-Item Env:ELECTRON_NO_ASAR -ErrorAction SilentlyContinue
  Write-Host "Opening Bits & Bytes Chat v$bitsVersion..."
  $started = Start-Process -FilePath $bitsExe -WorkingDirectory (Split-Path $bitsExe) -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr @bitsStartOptions
  $deadline = (Get-Date).AddSeconds(25)
  while ((Get-Date) -lt $deadline) {
    $started.Refresh()
    if ($started.HasExited) {
      # Another double-click may have opened the same version first.
      $forwarded = @(Get-BitsInstances | Where-Object { $_.ExecutablePath -eq $bitsExe })
      if ($started.ExitCode -eq 0 -and $forwarded.Count -gt 0) { exit 0 }
      throw "The app exited before opening (code $($started.ExitCode)). Startup log: $stderr. App logs: $(Join-Path $bitsDesktop 'logs')."
    }
    if ($started.MainWindowHandle -ne 0) { exit 0 }
    if ($bitsHiddenQA -and @(Get-BitsInstances | Where-Object { $_.ProcessId -eq $started.Id }).Count -gt 0) { exit 0 }
    Start-Sleep -Milliseconds 250
  }
  Write-Host "The app is still starting, but no window has appeared. Startup log: $stderr"
  Write-Host "App logs: $(Join-Path $bitsDesktop 'logs')"
  exit 2
} catch {
  Write-Host $_.Exception.Message -ForegroundColor Red
  exit 1
}
