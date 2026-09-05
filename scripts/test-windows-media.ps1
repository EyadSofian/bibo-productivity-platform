<# Tests native H.264 transport on a Windows host using synthetic pixels only. #>
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$baseTemp = if ($env:RUNNER_TEMP) { $env:RUNNER_TEMP } else { [IO.Path]::GetTempPath() }
$tempRoot = Join-Path $baseTemp 'livekit-smoke'
New-Item -ItemType Directory -Force $tempRoot | Out-Null
$archive = Join-Path $tempRoot 'livekit.zip'
Invoke-WebRequest 'https://github.com/livekit/livekit/releases/download/v1.13.6/livekit_1.13.6_windows_amd64.zip' -OutFile $archive
if ((Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne '9df299b6c6c32f1be88d3d106a9a63f8f921b424b353cc59f57d6b84532a4475') {
    throw 'LiveKit test server checksum mismatch'
}
Expand-Archive $archive -DestinationPath $tempRoot -Force
$serverPath = (Get-ChildItem $tempRoot -Filter 'livekit-server.exe' -Recurse | Select-Object -First 1).FullName
$server = Start-Process $serverPath -ArgumentList '--dev', '--bind', '127.0.0.1' -PassThru -RedirectStandardOutput (Join-Path $tempRoot 'server.out') -RedirectStandardError (Join-Path $tempRoot 'server.err')
try {
    $ready = $false
    for ($attempt=0; $attempt -lt 30; $attempt++) {
        if ($server.HasExited) { throw 'Local SFU exited before test' }
        try {
            $response = Invoke-WebRequest 'http://127.0.0.1:7880/' -TimeoutSec 1
            if ($response.StatusCode -eq 200) { $ready = $true; break }
        } catch { Start-Sleep -Milliseconds 500 }
    }
    if (-not $ready) { throw 'Local SFU did not become ready' }
    $env:LIVEKIT_TEST_URL = 'ws://127.0.0.1:7880'
    $env:LIVEKIT_TEST_KEY = 'devkey'
    $env:LIVEKIT_TEST_SECRET = 'secret'
    cargo test --manifest-path apps/desktop/native/media-publisher/Cargo.toml --config apps/desktop/native/media-publisher/.cargo/config.toml --locked --test publish_integration publishes_synthetic_frames_and_decodes_them_through_sfu -- --ignored --nocapture
    if ($LASTEXITCODE -ne 0) { throw 'Native H.264 transport smoke test failed' }
} finally {
    Stop-Process -Id $server.Id -Force -ErrorAction SilentlyContinue
    Remove-Item Env:LIVEKIT_TEST_URL, Env:LIVEKIT_TEST_KEY, Env:LIVEKIT_TEST_SECRET -ErrorAction SilentlyContinue
}
