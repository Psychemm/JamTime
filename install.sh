#!/bin/sh
# Installs the JamTime extension into Spicetify (macOS / Linux).
# Works from a clone of the repo, or straight from the web:
#   curl -fsSL https://raw.githubusercontent.com/Psychemm/JamTime/main/install.sh | sh
set -e
RAW_URL="https://raw.githubusercontent.com/Psychemm/JamTime/main/extension/jamtime.js"

if ! command -v spicetify >/dev/null 2>&1; then
  echo "Spicetify is not installed. Install it first:"
  echo "  curl -fsSL https://raw.githubusercontent.com/spicetify/cli/main/install.sh | sh"
  exit 1
fi

DEST="$(spicetify path userdata)/Extensions"
mkdir -p "$DEST"

LOCAL="$(dirname "$0")/extension/jamtime.js"
if [ -f "$LOCAL" ]; then
  cp "$LOCAL" "$DEST/jamtime.js"
else
  curl -fsSL "$RAW_URL" -o "$DEST/jamtime.js"
fi
echo "Installed jamtime.js to $DEST"

spicetify config extensions jamtime.js
spicetify apply
echo "Done! Look for the JamTime button in the top bar of Spotify."
