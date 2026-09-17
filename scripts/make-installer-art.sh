#!/bin/bash
#
# Renders the installer background art from installer/art/background.html.
# Run after changing the art:  scripts/make-installer-art.sh
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/installer/resources"
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[ -x "$CHROME" ] || { echo "Google Chrome is needed to render the art" >&2; exit 1; }
SHOT="$(mktemp -d)"; trap 'rm -rf "$SHOT"' EXIT

render() { # <query> <output>
  "$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=2 \
    --window-size=620,418 --screenshot="$SHOT/shot.png" \
    "file://$ROOT/installer/art/background.html?$1" >/dev/null 2>&1
  sips -z 418 620 -s format png "$SHOT/shot.png" --out "$2" >/dev/null
  echo "wrote ${2#$ROOT/}"
}

render light "$OUT/background.png"
render dark "$OUT/background-dark.png"
