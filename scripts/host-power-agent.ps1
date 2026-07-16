<#
.SYNOPSIS
  Host-side power agent for Palworld Server Manager.

  Polls the manager's /api/host-power endpoint and, while the game server is
  running AND the "Keep Host Awake While Running" setting is enabled in the
  web UI, it:
    - prevents Windows from sleeping (SetThreadExecutionState), and
    - disables Windows Energy Saver (sets its battery threshold to 0%).
  Both are restored as soon as the server stops, the setting is turned off,
  or this agent exits.

  The manager runs inside Docker and cannot touch host power settings, which
  is why this small native agent exists. It only ever READS from the manager
  (loopback HTTP), so it needs no credentials.

.USAGE
  Run in a console (for testing):
    powershell -ExecutionPolicy Bypass -File scripts\host-power-agent.ps1

  Install as a hidden background task that starts at logon (elevated prompt):
    powershell -ExecutionPolicy Bypass -File scripts\host-power-agent.ps1 -Install

  Remove the task:
    powershell -ExecutionPolicy Bypass -File scripts\host-power-agent.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  # Where the manager's web API is reachable from the host. docker-compose.yml
  # publishes it on loopback only: 127.0.0.1:8080.
  [string]$ManagerUrl = 'http://127.0.0.1:8080',
  [int]$PollSeconds = 15,
  [switch]$Install,
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$TaskName = 'PalworldHostPowerAgent'
# Original Energy Saver thresholds are stashed here so an agent that died while
# "applied" can still restore them on its next start.
$StateFile = Join-Path $env:LOCALAPPDATA 'PalworldServerManager\host-power-agent-state.json'

function Log([string]$msg) {
  Write-Host "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] $msg"
}

# ── Install / uninstall as a logon scheduled task ─────────────────────────────
if ($Install) {
  $scriptPath = $MyInvocation.MyCommand.Path
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument (
    "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$scriptPath`" -ManagerUrl `"$ManagerUrl`" -PollSeconds $PollSeconds"
  )
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Force | Out-Null
  Start-ScheduledTask -TaskName $TaskName
  Log "Installed and started scheduled task '$TaskName' (runs hidden at every logon)."
  return
}

if ($Uninstall) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
  Log "Removed scheduled task '$TaskName'."
  return
}

# ── Keep-awake via SetThreadExecutionState ────────────────────────────────────
Add-Type -Namespace PalPower -Name Native -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError = true)]
public static extern uint SetThreadExecutionState(uint esFlags);
'@
$ES_CONTINUOUS = [uint32]'0x80000000'
$ES_SYSTEM_REQUIRED = [uint32]'0x00000001'

# ── Energy Saver threshold via powercfg ──────────────────────────────────────
# ESBATTTHRESHOLD is the "turn energy saver on automatically at X% battery"
# value; 0 disables automatic Energy Saver entirely.
function Get-EnergySaverThresholds {
  $out = powercfg /q SCHEME_CURRENT SUB_ENERGYSAVER ESBATTTHRESHOLD
  if ($LASTEXITCODE -ne 0) { return $null } # no Energy Saver support (e.g. some desktops)
  $ac = [regex]::Match(($out -join "`n"), 'Current AC Power Setting Index:\s*0x([0-9a-fA-F]+)')
  $dc = [regex]::Match(($out -join "`n"), 'Current DC Power Setting Index:\s*0x([0-9a-fA-F]+)')
  if (-not ($ac.Success -and $dc.Success)) { return $null }
  return @{
    ac = [Convert]::ToInt32($ac.Groups[1].Value, 16)
    dc = [Convert]::ToInt32($dc.Groups[1].Value, 16)
  }
}

function Set-EnergySaverThresholds([int]$ac, [int]$dc) {
  powercfg /setacvalueindex SCHEME_CURRENT SUB_ENERGYSAVER ESBATTTHRESHOLD $ac | Out-Null
  powercfg /setdcvalueindex SCHEME_CURRENT SUB_ENERGYSAVER ESBATTTHRESHOLD $dc | Out-Null
  powercfg /setactive SCHEME_CURRENT | Out-Null
}

$applied = $false
$savedThresholds = $null

function Apply-KeepAwake {
  [PalPower.Native]::SetThreadExecutionState($ES_CONTINUOUS -bor $ES_SYSTEM_REQUIRED) | Out-Null
  $script:savedThresholds = Get-EnergySaverThresholds
  if ($script:savedThresholds) {
    New-Item -ItemType Directory -Force (Split-Path $StateFile) | Out-Null
    $script:savedThresholds | ConvertTo-Json | Set-Content -Encoding utf8 $StateFile
    Set-EnergySaverThresholds 0 0
    Log "Applied: sleep blocked, Energy Saver auto-threshold set to 0 (was AC=$($savedThresholds.ac)% DC=$($savedThresholds.dc)%)."
  } else {
    Log 'Applied: sleep blocked. (Energy Saver thresholds not adjustable on this machine - skipped.)'
  }
  $script:applied = $true
}

function Restore-Power {
  [PalPower.Native]::SetThreadExecutionState($ES_CONTINUOUS) | Out-Null
  if ($script:savedThresholds) {
    Set-EnergySaverThresholds $script:savedThresholds.ac $script:savedThresholds.dc
    Log "Restored Energy Saver thresholds (AC=$($savedThresholds.ac)% DC=$($savedThresholds.dc)%)."
    $script:savedThresholds = $null
  }
  Remove-Item $StateFile -Force -ErrorAction SilentlyContinue
  $script:applied = $false
}

# If a previous agent run died while applied, restore from its stashed state.
if (Test-Path $StateFile) {
  try {
    $stale = Get-Content $StateFile -Raw | ConvertFrom-Json
    Set-EnergySaverThresholds $stale.ac $stale.dc
    Log "Recovered: restored Energy Saver thresholds left behind by a previous run (AC=$($stale.ac)% DC=$($stale.dc)%)."
  } catch {
    Log "Warning: could not restore stale state from ${StateFile}: $($_.Exception.Message)"
  }
  Remove-Item $StateFile -Force -ErrorAction SilentlyContinue
}

Log "Watching $ManagerUrl/api/host-power every ${PollSeconds}s. Ctrl+C to stop."
try {
  while ($true) {
    $keepAwake = $false
    try {
      $resp = Invoke-RestMethod -Uri "$ManagerUrl/api/host-power" -TimeoutSec 10
      $keepAwake = [bool]$resp.keepAwake
    } catch {
      # Manager unreachable (container down, host booting): treat as "not
      # running" so power settings return to normal rather than sticking.
      if ($applied) { Log "Manager unreachable ($($_.Exception.Message)) - releasing keep-awake." }
    }

    if ($keepAwake -and -not $applied) {
      Apply-KeepAwake
    } elseif (-not $keepAwake -and $applied) {
      Restore-Power
      Log 'Released: server stopped or setting disabled.'
    }

    Start-Sleep -Seconds $PollSeconds
  }
} finally {
  if ($applied) { Restore-Power; Log 'Agent exiting - power settings restored.' }
}
