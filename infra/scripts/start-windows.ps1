[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
Set-Location $projectRoot

try {
    Write-Host 'FAFA ONE - Windows local demo' -ForegroundColor Cyan
    $dockerCommand = Get-Command docker.exe -ErrorAction SilentlyContinue
    $dockerExe = if ($dockerCommand) { $dockerCommand.Source } else {
        Join-Path $env:ProgramFiles 'Docker\Docker\resources\bin\docker.exe'
    }
    if (-not (Test-Path -LiteralPath $dockerExe)) {
        throw 'Install Docker Desktop first: https://www.docker.com/products/docker-desktop/'
    }
    & $dockerExe compose version
    if ($LASTEXITCODE -ne 0) { throw 'Docker Compose is unavailable. Update Docker Desktop.' }
    $engineType = & $dockerExe info --format '{{.OSType}}'
    if ($LASTEXITCODE -ne 0) {
        throw 'Open Docker Desktop and wait for Engine running. If requested, update WSL or restart Windows.'
    }
    if ($engineType -ne 'linux') { throw 'Switch Docker Desktop to Linux containers, then try again.' }

    $envPath = Join-Path $projectRoot '.env'
    if (-not (Test-Path -LiteralPath $envPath)) {
        $template = [IO.File]::ReadAllText((Join-Path $projectRoot '.env.example'))
        if ($template -notmatch '(?m)^ENCRYPTION_KEY=\r?$') {
            throw 'The environment template is invalid. Download the project again.'
        }
        $keyBytes = New-Object byte[] 32
        $random = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $random.GetBytes($keyBytes) } finally { $random.Dispose() }
        $template = [regex]::Replace($template, '(?m)^ENCRYPTION_KEY=\r?$', ('ENCRYPTION_KEY=' + [Convert]::ToBase64String($keyBytes)))
        # CreateNew preserves an existing configuration, including during simultaneous launches.
        $stream = [IO.File]::Open($envPath, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try {
            $encoding = New-Object Text.UTF8Encoding($false)
            $bytes = $encoding.GetBytes($template)
            $stream.Write($bytes, 0, $bytes.Length)
        } finally { $stream.Dispose() }
        Write-Host 'Created local configuration with a random encryption key. The key is never printed.'
    } else { Write-Host 'Keeping your existing .env configuration.' }

    $configuration = [IO.File]::ReadAllText($envPath)
    foreach ($required in @('NODE_ENV=development', 'DEMO_MODE=true', 'DEV_MOCK_LOGIN=true')) {
        if ($configuration -notmatch ('(?m)^' + [regex]::Escape($required) + '\r?$')) {
            throw 'This launcher is for local demo mode only. Your configuration was preserved. See README.md for real-service setup.'
        }
    }

    Write-Host 'Starting services. The first launch downloads and builds containers; please wait.' -ForegroundColor Cyan
    & $dockerExe compose -f infra/docker/compose.dev.yaml up --build -d --wait --wait-timeout 180
    if ($LASTEXITCODE -ne 0) { throw 'Container startup failed. Keep the error above for troubleshooting. No database was deleted.' }

    $pageReady = $false
    for ($attempt = 0; $attempt -lt 30; $attempt++) {
        try {
            $response = Invoke-WebRequest -UseBasicParsing -Uri 'http://localhost:5173' -TimeoutSec 5
            if ($response.StatusCode -eq 200) { $pageReady = $true; break }
        } catch { Start-Sleep -Seconds 2 }
    }
    if (-not $pageReady) { throw 'Services started, but the web page did not respond. Check Docker Desktop container status.' }
    Write-Host 'User panel: http://localhost:5173' -ForegroundColor Green
    Write-Host 'Admin panel: http://localhost:5174' -ForegroundColor Green
    Write-Host 'Choose a demo account on the login page. Docker Desktop must remain running.'
    Start-Process 'http://localhost:5173'
    exit 0
} catch {
    Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
    exit 1
}
