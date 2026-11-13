function Initialize-FafaProxyEnvironment {
    [CmdletBinding()]
    param([string]$RegistryPath = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings')

    $settings = Get-ItemProperty -LiteralPath $RegistryPath -ErrorAction SilentlyContinue
    $proxyMap = @{}
    if ($settings) {
        $enabled = $settings.PSObject.Properties['ProxyEnable']
        $server = $settings.PSObject.Properties['ProxyServer']
        if ($enabled -and $enabled.Value -eq 1 -and $server -and $server.Value) {
            foreach ($entry in ([string]$server.Value).Split(';')) {
                if ($entry -match '^(http|https)=(.+)$') {
                    $proxyMap[$Matches[1].ToLowerInvariant()] = $Matches[2].Trim()
                } elseif ($entry -notmatch '=' -and $entry.Trim()) {
                    $proxyMap['default'] = $entry.Trim()
                }
            }
        }
    }

    foreach ($protocol in @('http', 'https')) {
        $variableName = $protocol.ToUpperInvariant() + '_PROXY'
        if ([Environment]::GetEnvironmentVariable($variableName, 'Process')) { continue }
        $candidate = if ($proxyMap.ContainsKey($protocol)) { $proxyMap[$protocol] } else { $proxyMap['default'] }
        if (-not $candidate) { continue }
        if ($candidate -notmatch '^[a-zA-Z][a-zA-Z0-9+.-]*://') { $candidate = 'http://' + $candidate }
        $proxyUri = $null
        if (-not [Uri]::TryCreate($candidate, [UriKind]::Absolute, [ref]$proxyUri) -or
            $proxyUri.Scheme -notin @('http', 'https') -or -not $proxyUri.Host) {
            throw 'The Windows system proxy address is invalid. Check the HTTP proxy settings.'
        }
        # Docker CLI token requests use process proxy variables, independently of Desktop settings.
        [Environment]::SetEnvironmentVariable($variableName, $candidate, 'Process')
    }

    if ([Environment]::GetEnvironmentVariable('HTTP_PROXY', 'Process') -or
        [Environment]::GetEnvironmentVariable('HTTPS_PROXY', 'Process')) {
        $bypass = @('localhost', '127.0.0.1', '::1', 'api', 'postgres', 'web', 'admin')
        $existingBypass = [Environment]::GetEnvironmentVariable('NO_PROXY', 'Process')
        if ($existingBypass) { $bypass += $existingBypass.Split(',') }
        $bypass = @($bypass | ForEach-Object { $_.Trim() } | Where-Object { $_ } | Select-Object -Unique)
        [Environment]::SetEnvironmentVariable('NO_PROXY', ($bypass -join ','), 'Process')
        return $true
    }
    return $false
}
