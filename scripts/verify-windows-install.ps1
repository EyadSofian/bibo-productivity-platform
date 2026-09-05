<#
.SYNOPSIS
  Verifies an installed BiBoTracking build actually shipped a working sidecar (V13).

.DESCRIPTION
  Run this after installing the NSIS/MSI package. It checks the things that a
  "it installed fine" smoke test would miss:

    1. The app executable is where the installer said it would be.
    2. The media-publisher sidecar is installed NEXT TO IT - this is what
       `sidecar_path()` looks for at runtime.
    3. The installed sidecar actually runs and captures, via its own --selftest.
       A present-but-broken binary is worse than a missing one, because the agent
       will spawn it and then wait.
    4. The app launches and stays up.

  Exits non-zero on the first failure, so it is usable as a release gate.
#>
[CmdletBinding()]
param(
    # Default matches the current per-machine BiBoTracking NSIS configuration.
    [string]$InstallDir = "$env:ProgramFiles\BiBoTracking",
    # Skip launching the GUI (useful on a headless runner).
    [switch]$SkipLaunch
)

# NOT 'Stop': the sidecar writes its JSON logs to stderr, which PowerShell 5.1 would
# otherwise turn into a terminating error. Exit codes are checked explicitly instead.
$ErrorActionPreference = 'Continue'
Set-StrictMode -Version Latest

$fail = 0
function Check($name, $ok, $detail) {
    if ($ok) { Write-Host "  PASS  $name" -ForegroundColor Green }
    else     { Write-Host "  FAIL  $name" -ForegroundColor Red; $script:fail++ }
    if ($detail) { Write-Host "        $detail" }
}

Write-Host "Verifying install at $InstallDir" -ForegroundColor Cyan

# 1. app executable.
# NOTE: the installer directory is named after productName (BiBoTracking) but the
# binary keeps the Cargo package name (ctracking.exe). Accept either so a rename of
# one does not silently fail this check.
$app = $null
foreach ($n in @('ctracking.exe', 'BiBoTracking.exe')) {
    $p = Join-Path $InstallDir $n
    if (Test-Path $p) { $app = $p; break }
}
Check 'app executable installed' ($null -ne $app) $app
if (-not $app) { exit 1 }

# 2. sidecar next to it - the path the agent resolves at runtime
$sidecar = $null
foreach ($n in @('media-publisher.exe', 'media-publisher-x86_64-pc-windows-msvc.exe')) {
    $p = Join-Path $InstallDir $n
    if (Test-Path $p) { $sidecar = $p; break }
}
Check 'sidecar bundled next to the app' ($null -ne $sidecar) $sidecar
if (-not $sidecar) {
    Write-Host 'Live view would fail at runtime: the agent cannot find the sidecar.' -ForegroundColor Red
    exit 1
}
$mb = [math]::Round((Get-Item $sidecar).Length / 1MB, 1)
Write-Host "        sidecar size: $mb MB"

# 3. the installed sidecar really captures
Write-Host '  ...running installed sidecar --selftest (3s capture)'
$out = & $sidecar --selftest 2>&1 | Out-String
$code = $LASTEXITCODE
$frames = 0
if ($out -match '"frames_captured":(\d+)') { $frames = [int]$Matches[1] }
Check 'installed sidecar selftest exits 0' ($code -eq 0) "exit=$code"
Check 'installed sidecar captured frames' ($frames -gt 0) "frames_captured=$frames"
if ($out -match '"fps":([\d.]+)') { Write-Host "        fps: $($Matches[1])" }

# 4. app launches and stays up
if (-not $SkipLaunch) {
    Write-Host '  ...launching the app'
    $proc = Start-Process -FilePath $app -PassThru
    Start-Sleep -Seconds 6
    $alive = -not $proc.HasExited
    Check 'app launches and stays running' $alive "pid=$($proc.Id)"
    if ($alive) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue }
}

Write-Host ''
if ($fail -eq 0) {
    Write-Host 'Install verification PASSED' -ForegroundColor Green
    exit 0
}
Write-Host "Install verification FAILED ($fail check(s))" -ForegroundColor Red
exit 1
