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

# The installer app's icon: one 1024px render, sized down into an .icns.
"$CHROME" --headless --disable-gpu --hide-scrollbars --default-background-color=00000000 \
  --window-size=1024,1024 --screenshot="$SHOT/icon.png" \
  "file://$ROOT/installer/art/icon.html" >/dev/null 2>&1
ICONSET="$SHOT/AppIcon.iconset"; mkdir -p "$ICONSET"
for size in 16 32 64 128 256 512 1024; do
  sips -z $size $size "$SHOT/icon.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
done
# Retina variants are the doubled sizes under the @2x name.
for pair in "16 32" "32 64" "128 256" "256 512" "512 1024"; do
  set -- $pair
  cp "$ICONSET/icon_${2}x${2}.png" "$ICONSET/icon_${1}x${1}@2x.png"
done
rm -f "$ICONSET/icon_64x64.png" "$ICONSET/icon_1024x1024.png"
iconutil -c icns "$ICONSET" -o "$ROOT/installer/app/AppIcon.icns"
echo "wrote installer/app/AppIcon.icns"
