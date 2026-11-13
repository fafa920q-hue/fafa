$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'windows-proxy.ps1')

$testRegistryPath = 'HKCU:\Software\FAFAONE-ProxyTest-' + [Guid]::NewGuid().ToString('N')
$previousEnvironment = @{}
foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY')) {
    $previousEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

try {
    New-Item -Path $testRegistryPath -Force | Out-Null
    New-ItemProperty -LiteralPath $testRegistryPath -Name ProxyEnable -Value 1 -PropertyType DWord | Out-Null
    New-ItemProperty -LiteralPath $testRegistryPath -Name ProxyServer -Value '127.0.0.1:10808' -PropertyType String | Out-Null
    foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY')) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
    $env:NO_PROXY = 'existing.example'
    if (-not (Initialize-FafaProxyEnvironment -RegistryPath $testRegistryPath)) { throw 'System proxy was not imported.' }
    $childProxy = & powershell.exe -NoLogo -NoProfile -Command '$env:HTTPS_PROXY'
    if ($LASTEXITCODE -ne 0 -or $childProxy.Trim() -ne 'http://127.0.0.1:10808') {
        throw 'Child process did not inherit the system proxy.'
    }
    foreach ($hostName in @('localhost', '127.0.0.1', '::1', 'existing.example')) {
        if ($hostName -notin $env:NO_PROXY.Split(',')) { throw 'Local or existing proxy bypass was lost.' }
    }
    if ((Get-ItemProperty -LiteralPath $testRegistryPath).ProxyServer -ne '127.0.0.1:10808') {
        throw 'System proxy configuration was modified.'
    }

    $env:HTTPS_PROXY = 'http://127.0.0.1:18080'
    Set-ItemProperty -LiteralPath $testRegistryPath -Name ProxyServer -Value 'http=127.0.0.1:10809;https=127.0.0.1:10810'
    [Environment]::SetEnvironmentVariable('HTTP_PROXY', $null, 'Process')
    Initialize-FafaProxyEnvironment -RegistryPath $testRegistryPath | Out-Null
    if ($env:HTTP_PROXY -ne 'http://127.0.0.1:10809' -or $env:HTTPS_PROXY -ne 'http://127.0.0.1:18080') {
        throw 'Protocol mapping or explicit process proxy precedence failed.'
    }

    Set-ItemProperty -LiteralPath $testRegistryPath -Name ProxyEnable -Value 0
    foreach ($name in @('HTTP_PROXY', 'HTTPS_PROXY')) { [Environment]::SetEnvironmentVariable($name, $null, 'Process') }
    if (Initialize-FafaProxyEnvironment -RegistryPath $testRegistryPath) { throw 'A disabled system proxy was imported.' }
    Write-Host 'Windows registry and child-process proxy regression passed. No external requests were made.'
} finally {
    foreach ($name in $previousEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previousEnvironment[$name], 'Process')
    }
    Remove-Item -LiteralPath $testRegistryPath -Recurse -Force
}
