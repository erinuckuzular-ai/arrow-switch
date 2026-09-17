#!/bin/bash
#
# Installs the working copy into Premiere for testing, for the current user only.
# Signed with the local self-signed certificate (no CEP debug mode needed) and keeps
# extension/.debug so the panel can be driven at http://localhost:8088.
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.arrow.switch"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
export COPYFILE_DISABLE=1

rsync -a --exclude '.DS_Store' "$ROOT/extension/" "$WORK/stage/"
mkdir -p "$WORK/stage/licenses" && cp "$ROOT/licenses/"* "$WORK/stage/licenses/"
"$ROOT/.cache/ZXPSignCmd" -sign "$WORK/stage" "$WORK/dev.zxp" "$ROOT/certs/arrow-switch.p12" "$(cat "$ROOT/certs/password.txt")" >/dev/null
rm -rf "$DEST"
mkdir -p "$DEST"
unzip -q "$WORK/dev.zxp" -d "$DEST"
chmod +x "$DEST/bin/ffmpeg"
echo "Installed $(sed -n 's/.*ExtensionBundleVersion="\([^"]*\)".*/\1/p' "$DEST/CSXS/manifest.xml") to $DEST"
