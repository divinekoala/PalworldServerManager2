#!/usr/bin/env bash
# Container entrypoint: install/update the Palworld dedicated server, make sure
# the REST API is enabled, then hand off to the manager. The manager itself is
# what starts/stops the game on demand.
set -euo pipefail

log() { echo "[entrypoint] $*"; }

# If a command was passed (e.g. `docker compose run --rm palworld-manager
# npm run hash-password -- "pw"`), run it directly and skip the server setup.
if [ "$#" -gt 0 ]; then
  exec "$@"
fi

STEAMCMD=/home/steam/steamcmd/steamcmd.sh
INSTALL_DIR="${PAL_SERVER_CWD:-/palworld}"
APPID=2394010 # Palworld Dedicated Server
REST_PORT="${REST_API_PORT:-8212}"
SERVER_NAME="${SERVER_NAME:-Palworld Server}"
: "${REST_API_PASSWORD:?REST_API_PASSWORD must be set (it becomes the server AdminPassword)}"

run_steamcmd() {
  "$STEAMCMD" +force_install_dir "$INSTALL_DIR" +login anonymous +app_update "$APPID" validate +quit
}

# 1. Install / update the dedicated server.
if [ ! -f "$INSTALL_DIR/PalServer.sh" ] || [ "${UPDATE_ON_BOOT:-true}" = "true" ]; then
  log "Installing/updating Palworld dedicated server (appid $APPID) into $INSTALL_DIR ..."
  if ! run_steamcmd; then
    # steamcmd wedges in two ways that both look like "state is 0x6" / "Missing
    # configuration": a stale HTTP/app cache baked into the image, and an
    # appmanifest left describing a half-finished update. Clear both and retry
    # once — the retry re-downloads, but it beats an unbootable container.
    log "steamcmd failed; clearing its caches and the stale appmanifest, then retrying once."
    rm -rf "$HOME/Steam/appcache"/* \
           "$INSTALL_DIR/steamapps/appmanifest_$APPID.acf" \
           "$INSTALL_DIR/steamapps/downloading/$APPID" \
           "$INSTALL_DIR/steamapps/temp/$APPID" 2>/dev/null || true
    if ! run_steamcmd; then
      # Don't crash-loop: if a playable install is already on disk, boot the
      # manager anyway so the UI stays reachable and the update can be retried.
      if [ -f "$INSTALL_DIR/PalServer.sh" ]; then
        log "WARNING: update failed twice. Starting with the existing install — the game may be out of date."
      else
        log "ERROR: could not install the Palworld server and none is present on disk."
        exit 1
      fi
    fi
  fi
else
  log "Palworld server already installed; skipping update (UPDATE_ON_BOOT=false)."
fi

# Steam runtime expects the client library at this path.
mkdir -p "$HOME/.steam/sdk64"
ln -sf /home/steam/steamcmd/linux64/steamclient.so "$HOME/.steam/sdk64/steamclient.so" 2>/dev/null || true

# 2. Ensure the REST API is enabled in PalWorldSettings.ini.
log "Ensuring the REST API is enabled in PalWorldSettings.ini."
SETTINGS_FILE="$INSTALL_DIR/Pal/Saved/Config/LinuxServer/PalWorldSettings.ini" \
  REST_API_PORT="$REST_PORT" SERVER_NAME="$SERVER_NAME" \
  /usr/local/bin/configure-settings.sh

# 3. Hand off to the manager. `exec` so Node becomes the container's main process
#    and receives SIGTERM (graceful save+shutdown) on `docker stop`.
log "Starting the Palworld Server Manager."
cd /app
exec node src/index.js
