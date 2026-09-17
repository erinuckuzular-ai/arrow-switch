#!/bin/bash
# Dev-only: installs the real panel as a hidden extension that starts with Premiere and exposes
# it over the CEP debug port 8089, so tests can drive it (scripts/harness/es.js) without the UI.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.arrow.switch.harness"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT
export COPYFILE_DISABLE=1
mkdir -p "$WORK/stage"
cp -R "$ROOT/scripts/harness/CSXS" "$ROOT/scripts/harness/.debug" "$WORK/stage/"
# The real panel, loaded hidden, so tests exercise exactly what users run.
rsync -a --exclude '.DS_Store' --exclude 'CSXS' --exclude '.debug' "$ROOT/extension/" "$WORK/stage/panel/"
"$ROOT/.cache/ZXPSignCmd" -sign "$WORK/stage" "$WORK/h.zxp" "$ROOT/certs/arrow-switch.p12" "$(cat "$ROOT/certs/password.txt")" >/dev/null
rm -rf "$DEST"; mkdir -p "$DEST"; unzip -q "$WORK/h.zxp" -d "$DEST"
echo "Harness installed"
