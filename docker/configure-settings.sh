#!/usr/bin/env bash
# Ensure Palworld's PalWorldSettings.ini exists and has the REST API enabled.
# It only *adds* missing keys to an existing OptionSettings line, so a world the
# user brought along keeps its own settings.
#
# Env: SETTINGS_FILE (required), REST_API_PASSWORD (required),
#      REST_API_PORT (default 8212), SERVER_NAME (default "Palworld Server")
set -euo pipefail

SETTINGS="${SETTINGS_FILE:?SETTINGS_FILE required}"
REST_PORT="${REST_API_PORT:-8212}"
SERVER_NAME="${SERVER_NAME:-Palworld Server}"
: "${REST_API_PASSWORD:?REST_API_PASSWORD required}"

mkdir -p "$(dirname "$SETTINGS")"

if [ ! -f "$SETTINGS" ]; then
  cat > "$SETTINGS" <<EOF
[/Script/Pal.PalGameWorldSettings]
OptionSettings=(ServerName="$SERVER_NAME",AdminPassword="$REST_API_PASSWORD",RESTAPIEnabled=True,RESTAPIPort=$REST_PORT)
EOF
elif grep -q 'OptionSettings=(' "$SETTINGS"; then
  # Insert any missing key right after "OptionSettings=(" (existing values win).
  grep -q 'RESTAPIEnabled=' "$SETTINGS" || sed -i 's/OptionSettings=(/OptionSettings=(RESTAPIEnabled=True,/' "$SETTINGS"
  grep -q 'RESTAPIPort='    "$SETTINGS" || sed -i "s/OptionSettings=(/OptionSettings=(RESTAPIPort=$REST_PORT,/" "$SETTINGS"
  grep -q 'AdminPassword='  "$SETTINGS" || sed -i "s/OptionSettings=(/OptionSettings=(AdminPassword=\"$REST_API_PASSWORD\",/" "$SETTINGS"
else
  cat >> "$SETTINGS" <<EOF

[/Script/Pal.PalGameWorldSettings]
OptionSettings=(ServerName="$SERVER_NAME",AdminPassword="$REST_API_PASSWORD",RESTAPIEnabled=True,RESTAPIPort=$REST_PORT)
EOF
fi
