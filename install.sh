#!/bin/bash
#
# Installs the latest Arrow Switch release for the current Mac user, no admin password.
#
#   curl -fsSL https://raw.githubusercontent.com/erinuckuzular-ai/arrow-switch/main/install.sh | bash
#
# Downloading with curl (instead of a browser) means macOS doesn't quarantine the files,
# so the extension loads straight away.
#
set -euo pipefail

REPO="erinuckuzular-ai/arrow-switch"
BUNDLE_ID="com.arrow.switch"
USER_EXT="$HOME/Library/Application Support/Adobe/CEP/extensions"
DEST="$USER_EXT/$BUNDLE_ID"
SYSTEM_EXT="/Library/Application Support/Adobe/CEP/extensions"

say() { printf '\033[1;35m▸\033[0m %s\n' "$1"; }
fail() { printf '\033[1;31m✗\033[0m %s\n' "$1" >&2; exit 1; }

[ "$(uname)" = "Darwin" ] || fail "This installer is for macOS. On Windows, use Arrow Switch.zxp with a ZXP installer."

WORK="$(mktemp -d)"
MOUNT=""
cleanup() {
  [ -n "$MOUNT" ] && hdiutil detach "$MOUNT" -quiet 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

say "Finding the latest release"
RELEASE_JSON="$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest")" || fail "Couldn't reach GitHub."
DMG_URL="$(printf '%s' "$RELEASE_JSON" | grep -o '"browser_download_url": *"[^"]*\.dmg"' | head -1 | sed 's/.*"\(https[^"]*\)"/\1/')"
VERSION="$(printf '%s' "$RELEASE_JSON" | grep -o '"tag_name": *"[^"]*"' | head -1 | sed 's/.*"\([^"]*\)"$/\1/')"
[ -n "$DMG_URL" ] || fail "The latest release has no DMG attached."

say "Downloading Arrow Switch $VERSION"
curl -fL --progress-bar "$DMG_URL" -o "$WORK/arrow-switch.dmg" || fail "Download failed."

MOUNT="$(hdiutil attach -nobrowse -readonly -noautoopen "$WORK/arrow-switch.dmg" | tail -1 | sed 's/.*\(\/Volumes\/.*\)/\1/')"
ZXP="$MOUNT/Arrow Switch.zxp"
[ -f "$ZXP" ] || fail "The DMG doesn't contain Arrow Switch.zxp."

say "Installing for $(id -un)"
mkdir -p "$USER_EXT"
rm -rf "$DEST.new"
mkdir -p "$DEST.new"
unzip -q "$ZXP" -d "$DEST.new" || fail "Couldn't unpack the extension."
[ -f "$DEST.new/CSXS/manifest.xml" ] || fail "The extension package looks incomplete."
chmod +x "$DEST.new/bin/ffmpeg" 2>/dev/null || true
xattr -dr com.apple.quarantine "$DEST.new" 2>/dev/null || true
rm -rf "$DEST"
mv "$DEST.new" "$DEST"
# The old name, if it was ever installed for this user.
rm -rf "$USER_EXT/com.arrow.autocut"

# Copies installed with the .pkg live in the shared folder and would load as a second panel.
for old in "$SYSTEM_EXT/$BUNDLE_ID" "$SYSTEM_EXT/com.arrow.autocut"; do
  if [ -d "$old" ]; then
    say "Removing the older copy installed with the .pkg (needs your Mac password)"
    sudo rm -rf "$old" || fail "Couldn't remove $old. Run 'Uninstall Arrow Switch.command' from the DMG, then install again."
    sudo pkgutil --forget "$BUNDLE_ID.pkg" >/dev/null 2>&1 || true
    sudo pkgutil --forget com.arrow.autocut.pkg >/dev/null 2>&1 || true
  fi
done

printf '\n\033[1;32m✓\033[0m Arrow Switch %s installed.\n' "$VERSION"
echo "  Restart Premiere Pro, then open Window → Extensions → Arrow Switch."
echo "  To uninstall: rm -rf \"$DEST\""
