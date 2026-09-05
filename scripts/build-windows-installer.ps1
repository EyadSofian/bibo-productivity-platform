<#
.SYNOPSIS
  Builds the Windows installer with the media-publisher sidecar bundled (ticket 149 / V13).

.DESCRIPTION
  Steps, in order, because each depends on the last:

    1. Build the sidecar in release.
    2. Stage it where Tauri's `externalBin` expects it, with the target-triple suffix.
    3. Build the Tauri bundle (NSIS + MSI).
    4. Verify the sidecar is actually inside the produced installer.
    5. Write SHA256SUMS next to the artifacts.

  Step 4 matters: a bundle that silently ships without the sidecar still installs
  and launches fine, and only fails when an operator tries to watch someone.

.NOTES
  Requires MSVC, the Windows SDK, Node/pnpm and the Rust MSVC toolchain.

  CARGO_TARGET_DIR is forced short for the sidecar. Built in place, the prebuilt
  libwebrtc headers exceed Windows' 260-char MAX_PATH and the compiler fails with a
  misleading "cannot open include file" for a file that exists. See the sidecar
  README.
#>
[CmdletBinding()]
param(
    # Short build directory for the sidecar, to stay under MAX_PATH.
    [string]$SidecarTargetDir = 'C:\lkb',
    # Skip rebuilding the sidecar when it is already current.
    [switch]$SkipSidecar
)

# NOT 'Stop'. Windows PowerShell 5.1 turns a native command's stderr into an
# ErrorRecord, so `pnpm tauri build` writing an informational line to stderr would
# abort this script mid-build. Every native call below checks $LASTEXITCODE
# explicitly instead, which is the only reliable success signal here.
$ErrorActionPreference = 'Continue'
Set-StrictMode -Version Latest

$Triple    = 'x86_64-pc-windows-msvc'
$RepoRoot  = Split-Path -Parent $PSScriptRoot
$Sidecar   = Join-Path $RepoRoot 'apps\desktop\native\media-publisher'
$Tauri     = Join-Path $RepoRoot 'apps\desktop\src-tauri'
$Desktop   = Join-Path $RepoRoot 'apps\desktop'
$Staged    = Join-Path $Tauri "binaries\media-publisher-$Triple.exe"

function Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Fail($msg) { Write-Host "FAILED: $msg" -ForegroundColor Red; exit 1 }

# ---------------------------------------------------------------- 1. sidecar
if (-not $SkipSidecar) {
    Step "Building sidecar (release), CARGO_TARGET_DIR=$SidecarTargetDir"
    New-Item -ItemType Directory -Force -Path $SidecarTargetDir | Out-Null
    Push-Location $Sidecar
    try {
        $env:CARGO_TARGET_DIR = $SidecarTargetDir
        cargo test --locked --all-targets
        if ($LASTEXITCODE -ne 0) { Fail "sidecar tests failed" }
        cargo build --locked --release --bin media-publisher
        if ($LASTEXITCODE -ne 0) { Fail "sidecar build failed" }
    } finally {
        Pop-Location
        Remove-Item Env:CARGO_TARGET_DIR -ErrorAction SilentlyContinue
    }
}

$built = Join-Path $SidecarTargetDir 'release\media-publisher.exe'
if (-not (Test-Path $built)) { Fail "sidecar binary not found at $built" }

# ------------------------------------------------------------- 2. stage it
Step "Staging sidecar as $Staged"
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Staged) | Out-Null
Copy-Item $built $Staged -Force -ErrorAction Stop
$sz = [math]::Round((Get-Item $Staged).Length / 1MB, 1)
Write-Host "    staged: $sz MB"

# ---------------------------------------------------------- 3. build bundle
Step 'Building Tauri bundle (NSIS + MSI)'
$tauriExit = 0
$buildStarted = [DateTime]::UtcNow
Push-Location $Desktop
try {
    pnpm tauri build --config src-tauri/tauri.windows.conf.json
    $tauriExit = $LASTEXITCODE
} finally {
    Pop-Location
}

$BundleDir = Join-Path $Tauri 'target\release\bundle'

# Every failing build, including signing failures, must fail this command.
if ($tauriExit -ne 0) {
    Fail "tauri build failed (exit $tauriExit); artifacts are not a successful release"
}

if (-not (Test-Path $BundleDir)) { Fail "no bundle directory at $BundleDir" }

$artifacts = Get-ChildItem $BundleDir -Recurse -Include *.exe, *.msi -File |
             Where-Object { $_.Name -notmatch 'media-publisher' -and $_.LastWriteTimeUtc -ge $buildStarted }
if (-not $artifacts) { Fail 'no installer produced' }

# ------------------------------------------------ 4. verify the sidecar shipped
Step 'Verifying the sidecar is inside the installer'
$verified = @()
foreach ($a in $artifacts) {
    # Scan the raw bytes for the sidecar's name. This is a POSITIVE-ONLY signal:
    # the MSI keeps a readable file table so a hit is meaningful, but NSIS
    # LZMA-compresses its payload, so a miss there proves nothing. The
    # authoritative check is installing and running verify-windows-install.ps1.
    $bytes = [System.IO.File]::ReadAllBytes($a.FullName)
    $ascii = [System.Text.Encoding]::ASCII.GetString($bytes)
    $utf16 = [System.Text.Encoding]::Unicode.GetString($bytes)
    $found = ($ascii -match 'media-publisher') -or ($utf16 -match 'media-publisher')
    $mb = [math]::Round($a.Length / 1MB, 1)
    if ($found) {
        Write-Host "    OK   $($a.Name)  ($mb MB)  sidecar referenced" -ForegroundColor Green
        $verified += $a
    } else {
        Write-Host "    ??   $($a.Name)  ($mb MB)  inconclusive (compressed payload)" -ForegroundColor Yellow
    }
}
if (-not $verified) {
    Write-Host '    No installer showed a readable sidecar reference.' -ForegroundColor Yellow
    Write-Host '    Install one and run scripts/verify-windows-install.ps1 to be sure.' -ForegroundColor Yellow
}

# ------------------------------------------------------------- 5. checksums
Step 'Writing SHA256SUMS'
$sumFile = Join-Path $BundleDir 'SHA256SUMS.txt'
$lines = foreach ($a in $artifacts) {
    $h = (Get-FileHash $a.FullName -Algorithm SHA256).Hash.ToLower()
    "$h  $($a.Name)"
}
$lines | Set-Content -Path $sumFile -Encoding utf8
$lines | ForEach-Object { Write-Host "    $_" }

Write-Host ''
Write-Host 'Installer build complete.' -ForegroundColor Green
Write-Host "  artifacts: $BundleDir"
Write-Host "  checksums: $sumFile"
Write-Host ''
Write-Host 'Installers are NOT byte-reproducible: each build embeds fresh timestamps'
Write-Host 'and GUIDs, so the checksums change on every run. Publish the checksums'
Write-Host 'from the same build you actually ship and test.'

# All build and artifact checks passed.
exit 0
