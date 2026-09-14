<#
.SYNOPSIS
  Updates the Palworld dedicated server inside the palworld-manager container.

.DESCRIPTION
  The container's entrypoint runs `steamcmd +app_update 2394010 validate` on every
  boot (UPDATE_ON_BOOT=true in .env), so "updating the game" == restarting the
  container. This script does that safely:

    1. Reports the installed build id and the live build id on Steam.
    2. Refuses to bounce the container while the game process is running,
       unless you pass -Force (a graceful stop still saves the world first).
    3. Stops the container (SIGTERM -> manager saves + shuts the game down),
       starts it again, and follows the entrypoint log until SteamCMD is done.
    4. Reports the new build id and whether it actually changed.

  The manager does not auto-start the game; start it from the web UI when the
  update finishes.

.PARAMETER Check
  Only compare installed vs. latest build id. Changes nothing.

.PARAMETER Force
  Skip the confirmation prompt when the game process is currently running.

.PARAMETER TimeoutMinutes
  How long to wait for SteamCMD to finish before giving up. Default 30.

.EXAMPLE
  .\scripts\update-palworld-server.ps1 -Check
.EXAMPLE
  .\scripts\update-palworld-server.ps1
#>
[CmdletBinding()]
param(
    [switch]$Check,
    [switch]$Force,
    [int]$TimeoutMinutes = 30
)

$ErrorActionPreference = 'Stop'

$Container = 'palworld-manager'
$AppId     = '2394010'
$RepoRoot  = Split-Path -Parent $PSScriptRoot
$Compose   = Join-Path $RepoRoot 'docker-compose.yml'

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Warn($msg) { Write-Host "!!  $msg" -ForegroundColor Yellow }
function Write-Fail($msg) { Write-Host "!!  $msg" -ForegroundColor Red }

# Takes the args as ONE array. Do not switch this to ValueFromRemainingArguments:
# PowerShell's parameter binder eats leading-dash args like "-d" before they ever
# reach docker, which silently turns `up -d` into an attached `up`.
function Invoke-Compose {
    param([Parameter(Mandatory = $true, Position = 0)][string[]]$ComposeArgs)
    & docker compose --project-directory $RepoRoot -f $Compose @ComposeArgs
    if ($LASTEXITCODE -ne 0) { throw "docker compose $($ComposeArgs -join ' ') failed (exit $LASTEXITCODE)" }
}

# --- Pre-flight -------------------------------------------------------------

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Write-Fail "docker not found on PATH. Start Docker Desktop and try again."
    exit 1
}
if (-not (Test-Path $Compose)) {
    Write-Fail "docker-compose.yml not found at $Compose"
    exit 1
}

$running = (& docker ps --filter "name=^/$Container$" --format '{{.Names}}')
if ($running -ne $Container) {
    Write-Warn "Container '$Container' is not running. Starting it will also run the update."
    if (-not $Check) {
        Write-Step "Starting $Container ..."
        Invoke-Compose @('up', '-d', 'palworld-manager')
    }
}

# --- Build id helpers -------------------------------------------------------

function Get-InstalledBuildId {
    $acf = "/palworld/steamapps/appmanifest_$AppId.acf"
    $out = & docker exec $Container bash -c "grep -E '\""buildid\""' $acf 2>/dev/null"
    if ($LASTEXITCODE -ne 0 -or -not $out) { return $null }
    if ($out -match '"buildid"\s+"(\d+)"') { return $Matches[1] }
    return $null
}

function Get-LatestBuildId {
    # Ask Steam directly (app_info_update 1 forces a fresh fetch, ignoring cache).
    $cmd = "/home/steam/steamcmd/steamcmd.sh +login anonymous +app_info_update 1 +app_info_print $AppId +quit"
    $out = & docker exec $Container bash -c $cmd
    if (-not $out) { return $null }
    # The build id we want lives under depots -> branches -> public.
    $text  = $out -join "`n"
    $anchor = $text.IndexOf('"branches"')
    if ($anchor -lt 0) { return $null }
    $tail = $text.Substring($anchor)
    if ($tail -match '"buildid"\s+"(\d+)"') { return $Matches[1] }
    return $null
}

# `docker logs` writes the container's stderr to OUR stderr, and SteamCMD is
# chatty on stderr. Merging it with 2>&1 while $ErrorActionPreference is 'Stop'
# makes PowerShell throw NativeCommandError on the first such line, so the merge
# has to happen in a child scope where errors are non-terminating.
function Get-ContainerLog {
    param([string]$Since)
    $records = & {
        $ErrorActionPreference = 'Continue'
        & docker logs --since $Since $Container 2>&1
    }
    return @($records | ForEach-Object { $_.ToString() })
}

function Test-GameRunning {
    # '[P]alServer' so pgrep doesn't match the cmdline of the shell running it.
    & docker exec $Container bash -c "pgrep -f '[P]alServer' >/dev/null 2>&1"
    return ($LASTEXITCODE -eq 0)
}

Write-Step "Reading installed build id ..."
$before = Get-InstalledBuildId
if ($before) { Write-Host "    installed: $before" } else { Write-Warn "no install found on the volume yet" }

Write-Step "Asking Steam for the current build id (takes ~20s) ..."
$latest = Get-LatestBuildId
if ($latest) { Write-Host "    on Steam:  $latest" } else { Write-Warn "could not read the live build id" }

if ($before -and $latest -and $before -eq $latest) {
    Write-Host "The dedicated server is already up to date (build $before)." -ForegroundColor Green
    if ($Check) { exit 0 }
    Write-Host "Continuing anyway - the restart will re-validate the install."
} elseif ($Check) {
    if ($before -and $latest) { Write-Warn "Update available: $before -> $latest" }
    exit 0
}

# --- Safety check -----------------------------------------------------------

if (Test-GameRunning) {
    Write-Warn "The game server process is RUNNING. Stopping it will disconnect players."
    Write-Warn "The manager saves the world and shuts down gracefully first."
    if (-not $Force) {
        $answer = Read-Host "Continue? (y/N)"
        if ($answer -notmatch '^(y|yes)$') {
            Write-Host "Aborted. Nothing was changed."
            exit 0
        }
    }
}

# --- Do the update ----------------------------------------------------------

Write-Step "Stopping $Container (graceful save + shutdown, up to 3 minutes) ..."
Invoke-Compose @('stop', 'palworld-manager')

Write-Step "Starting $Container - the entrypoint runs SteamCMD app_update ..."
$startedAt = (Get-Date).ToUniversalTime().AddSeconds(-5).ToString('yyyy-MM-ddTHH:mm:ss') + 'Z'
Invoke-Compose @('up', '-d', 'palworld-manager')

Write-Step "Following the update log (Ctrl+C is safe - the update keeps going) ..."
$deadline  = (Get-Date).AddMinutes($TimeoutMinutes)
$seen      = 0
$done      = $false
$failed    = $false

while ((Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 5

    $lines = Get-ContainerLog -Since $startedAt
    if ($lines.Count -gt $seen) {
        $lines[$seen..($lines.Count - 1)] | ForEach-Object { Write-Host "    $_" }
        $seen = $lines.Count
    }

    $text = $lines -join "`n"
    if ($text -match 'Starting the Palworld Server Manager') { $done = $true; break }
    if ($text -match 'ERROR: could not install the Palworld server') { $failed = $true; break }

    # Container died mid-update - surface it instead of spinning until timeout.
    $alive = (& docker ps --filter "name=^/$Container$" --format '{{.Names}}')
    if ($alive -ne $Container) { $failed = $true; break }
}

if ($failed) {
    Write-Fail "The update failed. Full log:  docker logs $Container"
    Write-Fail "If SteamCMD reports 'state is 0x6' / 'Missing configuration', clear the download cache:"
    Write-Fail "  docker exec $Container bash -c 'rm -rf /palworld/steamapps/downloading /palworld/steamapps/temp'"
    Write-Fail "then run this script again."
    exit 1
}
if (-not $done) {
    Write-Fail "Timed out after $TimeoutMinutes minutes. Check:  docker logs -f $Container"
    exit 1
}

# --- Report -----------------------------------------------------------------

$after = Get-InstalledBuildId
Write-Host ""
if ($after -and $before -and $after -ne $before) {
    Write-Host "Updated: build $before -> $after" -ForegroundColor Green
} elseif ($after) {
    Write-Host "Install validated. Build $after (unchanged)." -ForegroundColor Green
} else {
    Write-Warn "Update finished but the build id could not be read back."
}
Write-Host "The manager is up. Start the game server from the web UI when you're ready."
