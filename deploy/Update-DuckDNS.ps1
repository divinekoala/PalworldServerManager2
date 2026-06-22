<#
.SYNOPSIS
    Updates a DuckDNS domain with this machine's current public IP.

.DESCRIPTION
    DuckDNS auto-detects the caller's public IP when the `ip` parameter is left
    empty. Run this on a schedule (e.g. every 5 minutes) via Task Scheduler so
    your DuckDNS record keeps pointing at your home IP as it changes.

.PARAMETER Domain
    Your DuckDNS subdomain WITHOUT the ".duckdns.org" suffix (e.g. "mypals").

.PARAMETER Token
    Your DuckDNS account token.

.EXAMPLE
    .\Update-DuckDNS.ps1 -Domain mypals -Token 00000000-0000-0000-0000-000000000000
#>
param(
    [Parameter(Mandatory = $true)][string]$Domain,
    [Parameter(Mandatory = $true)][string]$Token
)

$ErrorActionPreference = 'Stop'
$logFile = Join-Path $PSScriptRoot 'duckdns.log'
$timestamp = Get-Date -Format 's'

try {
    $url = "https://www.duckdns.org/update?domains=$Domain&token=$Token&ip="
    $response = (Invoke-WebRequest -Uri $url -UseBasicParsing).Content.Trim()
    $line = "$timestamp  domain=$Domain  response=$response"
    Add-Content -Path $logFile -Value $line
    if ($response -ne 'OK') {
        Write-Error "DuckDNS update did not return OK (got: $response)"
        exit 1
    }
    Write-Output $line
}
catch {
    Add-Content -Path $logFile -Value "$timestamp  ERROR  $($_.Exception.Message)"
    throw
}
