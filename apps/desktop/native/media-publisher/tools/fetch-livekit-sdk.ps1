# Fetches the pinned LiveKit C++ SDK binary release into third_party/.
#
# The SDK ships prebuilt per-platform archives, so nothing is compiled from
# source here and vcpkg is not involved. The archive is pinned by SHA256: a
# release asset that is re-uploaded under the same tag would change the hash and
# this script would refuse it rather than silently building against different
# binaries.
#
# Usage (from anywhere):
#   pwsh -File apps/desktop/native/media-publisher/tools/fetch-livekit-sdk.ps1
#
# The extracted tree is gitignored. It is ~26 MB of binaries and must not be
# committed.

[CmdletBinding()]
param(
    # Re-download and re-extract even if the tree is already present.
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$Version = '1.10.0'
$Asset = "livekit-sdk-windows-x64-$Version"
$Url = "https://github.com/livekit/client-sdk-cpp/releases/download/v$Version/$Asset.zip"
$Sha256 = '6808B44E8EF8FDB31194AC084049F416EAE144A34C51A6233F43A5106A54B6D2'

$ThirdParty = Join-Path (Split-Path -Parent $PSScriptRoot) 'third_party'
$Zip = Join-Path $ThirdParty "$Asset.zip"
$Root = Join-Path $ThirdParty $Asset

if ((Test-Path (Join-Path $Root 'lib\cmake\LiveKit\LiveKitConfig.cmake')) -and -not $Force) {
    Write-Host "LiveKit SDK $Version already present at $Root"
    exit 0
}

New-Item -ItemType Directory -Force -Path $ThirdParty | Out-Null

if ((Test-Path $Zip) -and -not $Force) {
    Write-Host "Using cached archive $Zip"
} else {
    Write-Host "Downloading $Url"
    Invoke-WebRequest -Uri $Url -OutFile $Zip -UseBasicParsing -TimeoutSec 600
}

$actual = (Get-FileHash $Zip -Algorithm SHA256).Hash
if ($actual -ne $Sha256) {
    Remove-Item $Zip -Force
    throw "SHA256 mismatch for $Asset.zip`n  expected $Sha256`n  actual   $actual`nThe cached archive has been deleted. Re-run to download again."
}
Write-Host "SHA256 verified: $actual"

if (Test-Path $Root) { Remove-Item $Root -Recurse -Force }
Expand-Archive -Path $Zip -DestinationPath $ThirdParty -Force

# The archive may expand either as <asset>/ or with its contents at the top
# level; normalise so CMake sees one stable path.
if (-not (Test-Path (Join-Path $Root 'lib\cmake\LiveKit\LiveKitConfig.cmake'))) {
    $nested = Get-ChildItem -Path $ThirdParty -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName 'lib\cmake\LiveKit\LiveKitConfig.cmake') } |
        Select-Object -First 1
    if (-not $nested) { throw "Extracted archive does not contain lib/cmake/LiveKit/LiveKitConfig.cmake" }
    if ($nested.FullName -ne $Root) { Move-Item $nested.FullName $Root }
}

$info = Get-Content (Join-Path $Root 'share\livekit\build-info.json') -Raw | ConvertFrom-Json
Write-Host "LiveKit SDK ready at $Root"
Write-Host ("  sdk_version {0}  ffi {1}  built {2}" -f $info.sdk_version, $info.livekit_ffi_version, $info.build_date)
