#!/bin/sh
# One-step JamTime installer for macOS / Linux. Installs Spicetify first if needed.
#   curl -fsSL https://raw.githubusercontent.com/Psychemm/JamTime/main/install.sh | sh
set -e
RAW_URL="https://raw.githubusercontent.com/Psychemm/JamTime/main/dist/jamtime.js"

find_spicetify() {
  if command -v spicetify >/dev/null 2>&1; then command -v spicetify
  elif [ -x "$HOME/.spicetify/spicetify" ]; then echo "$HOME/.spicetify/spicetify"
  fi
}

echo ""
echo "  JamTime installer"
echo ""

SPICETIFY="$(find_spicetify)"
if [ -z "$SPICETIFY" ]; then
  echo "Installing Spicetify (lets Spotify run extensions)..."
  curl -fsSL https://raw.githubusercontent.com/spicetify/cli/main/install.sh | sh
  SPICETIFY="$(find_spicetify)"
  if [ -z "$SPICETIFY" ]; then
    echo "Spicetify did not install. See https://spicetify.app/docs/getting-started"
    exit 1
  fi
fi

DEST="$("$SPICETIFY" path userdata)/Extensions"
mkdir -p "$DEST"

LOCAL="$(dirname "$0")/dist/jamtime.js"
if [ -f "$LOCAL" ]; then
  cp "$LOCAL" "$DEST/jamtime.js"
else
  echo "Downloading JamTime..."
  curl -fsSL "$RAW_URL" -o "$DEST/jamtime.js"
fi

"$SPICETIFY" config extensions jamtime.js >/dev/null
echo "Applying to Spotify (it will restart)..."
"$SPICETIFY" apply || "$SPICETIFY" backup apply

echo ""
echo "  Done! Click the JamTime button at the top of Spotify."
echo ""
