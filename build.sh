#!/bin/bash
#
# Builds dist/Arrow-Switch-<version>.dmg containing:
#   Install Arrow Switch.pkg      (macOS installer)
#   Arrow Switch.zxp              (for ZXP installers / Windows)
#   Uninstall Arrow Switch.command
#   Read Me.txt
#
# Optional environment variables:
#   INSTALLER_SIGN_ID   "Developer ID Installer: Name (TEAMID)" — signs the .pkg
#   APP_SIGN_ID         "Developer ID Application: Name (TEAMID)" — signs ffmpeg
#   NOTARY_PROFILE      keychain profile from `xcrun notarytool store-credentials`
#   ZXP_CERT_PASSWORD   password for the self-signed ZXP certificate (default: generated per machine)
#   SKIP_ZXP_SIGN=1     build an unsigned extension (installer turns on CEP debug mode instead)
#
set -euo pipefail
export COPYFILE_DISABLE=1   # keep macOS "._" metadata files out of the package

ROOT="$(cd "$(dirname "$0")" && pwd)"
NAME="Arrow Switch"
BUNDLE_ID="com.arrow.switch"
VERSION="$(sed -n 's/.*ExtensionBundleVersion="\([^"]*\)".*/\1/p' "$ROOT/extension/CSXS/manifest.xml")"
BUILD="$ROOT/build"
DIST="$ROOT/dist"
CACHE="$ROOT/.cache"
EXT_INSTALL_DIR="Library/Application Support/Adobe/CEP/extensions/$BUNDLE_ID"

step() { printf '\n\033[1;35m▸ %s\033[0m\n' "$1"; }

rm -rf "$BUILD"
mkdir -p "$BUILD" "$DIST" "$CACHE"

# ------------------------------------------------------------------ tests
step "Running tests"
node --test "$ROOT"/test/*.test.js

# ------------------------------------------------------------------ ffmpeg
step "Preparing universal ffmpeg"
if [ ! -x "$CACHE/ffmpeg" ]; then
  for arch in arm64 amd64; do
    curl -fsSL "https://ffmpeg.martin-riedl.de/redirect/latest/macos/$arch/release/ffmpeg.zip" -o "$CACHE/ffmpeg-$arch.zip"
    rm -rf "$CACHE/$arch" && mkdir -p "$CACHE/$arch"
    unzip -q -o "$CACHE/ffmpeg-$arch.zip" -d "$CACHE/$arch"
  done
  lipo -create "$CACHE/arm64/ffmpeg" "$CACHE/amd64/ffmpeg" -output "$CACHE/ffmpeg"
  chmod +x "$CACHE/ffmpeg"
fi
if otool -L "$CACHE/ffmpeg" | grep -E '^\s' | grep -qvE '/usr/lib/|/System/Library/'; then
  echo "ffmpeg links against non-system libraries; it would not run on other Macs." >&2
  exit 1
fi

# ------------------------------------------------------------------ ffmpeg source (GPL)
# ffmpeg is GPLv3: every release must ship its corresponding source. These land in dist/
# next to the DMG and get attached to the GitHub release (see licenses/FFMPEG-NOTICE.txt).
step "Collecting ffmpeg source for the release"
FFMPEG_VERSION="9.0.1"
[ -f "$CACHE/ffmpeg-$FFMPEG_VERSION.tar.xz" ] || curl -fsSL "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" -o "$CACHE/ffmpeg-$FFMPEG_VERSION.tar.xz"
[ -f "$CACHE/ffmpeg-build-script.tar.gz" ] || curl -fsSL "https://git.martin-riedl.de/ffmpeg/build-script/archive/main.tar.gz" -o "$CACHE/ffmpeg-build-script.tar.gz"
cp "$CACHE/ffmpeg-$FFMPEG_VERSION.tar.xz" "$CACHE/ffmpeg-build-script.tar.gz" "$DIST/"

# ------------------------------------------------------------------ stage extension
step "Staging extension $VERSION"
STAGE="$BUILD/stage/$BUNDLE_ID"
mkdir -p "$STAGE"
rsync -a --exclude '.debug' --exclude '.DS_Store' --exclude 'bin/*' "$ROOT/extension/" "$STAGE/"
mkdir -p "$STAGE/bin" "$STAGE/licenses"
cp "$ROOT/licenses/"* "$STAGE/licenses/"
cp "$CACHE/ffmpeg" "$STAGE/bin/ffmpeg"
if [ -n "${APP_SIGN_ID:-}" ]; then
  codesign --force --options runtime --timestamp --sign "$APP_SIGN_ID" "$STAGE/bin/ffmpeg"
elif ! codesign -v "$STAGE/bin/ffmpeg" 2>/dev/null; then
  codesign --force --sign - "$STAGE/bin/ffmpeg"   # ad-hoc; Apple Silicon refuses unsigned binaries
fi

# ------------------------------------------------------------------ ZXP signing
ZXP="$BUILD/$NAME.zxp"
PAYLOAD="$BUILD/payload/$EXT_INSTALL_DIR"
mkdir -p "$PAYLOAD"
if [ "${SKIP_ZXP_SIGN:-0}" != "1" ]; then
  step "Signing ZXP"
  SIGNER="$CACHE/ZXPSignCmd"
  if [ ! -x "$SIGNER" ]; then
    curl -fsSL "https://raw.githubusercontent.com/Adobe-CEP/CEP-Resources/master/ZXPSignCMD/4.1.3/macOS/ZXPSignCmd" -o "$SIGNER"
    chmod +x "$SIGNER"
    xattr -d com.apple.quarantine "$SIGNER" 2>/dev/null || true
  fi
  CERT="$ROOT/certs/arrow-switch.p12"
  PASS_FILE="$ROOT/certs/password.txt"
  if [ ! -f "$CERT" ]; then
    mkdir -p "$ROOT/certs"
    PASS="${ZXP_CERT_PASSWORD:-$(openssl rand -hex 16)}"
    printf '%s' "$PASS" > "$PASS_FILE"
    chmod 600 "$PASS_FILE"
    "$SIGNER" -selfSignedCert US CA "Arrow" "$NAME" "$PASS" "$CERT" -validityDays 3650
  fi
  PASS="${ZXP_CERT_PASSWORD:-$(cat "$PASS_FILE")}"
  "$SIGNER" -sign "$STAGE" "$ZXP" "$CERT" "$PASS" -tsa http://timestamp.digicert.com \
    || "$SIGNER" -sign "$STAGE" "$ZXP" "$CERT" "$PASS"
  "$SIGNER" -verify "$ZXP"
  unzip -q "$ZXP" -d "$PAYLOAD"
else
  step "Skipping ZXP signing (installer will enable CEP debug mode)"
  rsync -a "$STAGE/" "$PAYLOAD/"
fi

# ------------------------------------------------------------------ pkg
step "Building installer package"
xattr -cr "$BUILD/payload"
pkgbuild \
  --root "$BUILD/payload" \
  --identifier "$BUNDLE_ID.pkg" \
  --version "$VERSION" \
  --install-location / \
  --scripts "$ROOT/installer/scripts" \
  "$BUILD/component.pkg"

cat > "$BUILD/distribution.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>$NAME</title>
  <welcome file="welcome.html" mime-type="text/html"/>
  <conclusion file="conclusion.html" mime-type="text/html"/>
  <options customize="never" require-scripts="false" hostArchitectures="arm64,x86_64"/>
  <domains enable_localSystem="true"/>
  <choices-outline><line choice="default"/></choices-outline>
  <choice id="default" visible="false"><pkg-ref id="$BUNDLE_ID.pkg"/></choice>
  <pkg-ref id="$BUNDLE_ID.pkg" version="$VERSION" onConclusion="none">component.pkg</pkg-ref>
</installer-gui-script>
EOF

PKG="$BUILD/Install $NAME.pkg"
SIGN_ARGS=()
[ -n "${INSTALLER_SIGN_ID:-}" ] && SIGN_ARGS=(--sign "$INSTALLER_SIGN_ID")
productbuild \
  --distribution "$BUILD/distribution.xml" \
  --resources "$ROOT/installer/resources" \
  --package-path "$BUILD" \
  ${SIGN_ARGS[@]+"${SIGN_ARGS[@]}"} \
  "$PKG"

if [ -n "${NOTARY_PROFILE:-}" ] && [ -n "${INSTALLER_SIGN_ID:-}" ]; then
  step "Notarizing installer"
  xcrun notarytool submit "$PKG" --keychain-profile "$NOTARY_PROFILE" --wait
  xcrun stapler staple "$PKG"
fi

# ------------------------------------------------------------------ dmg
step "Building disk image"
DMG_SRC="$BUILD/dmg"
mkdir -p "$DMG_SRC"
cp "$PKG" "$DMG_SRC/"
[ -f "$ZXP" ] && cp "$ZXP" "$DMG_SRC/"
cp "$ROOT/installer/uninstall.command" "$DMG_SRC/Uninstall $NAME.command"
cp "$ROOT/installer/Read Me.txt" "$DMG_SRC/"
mkdir -p "$DMG_SRC/Licenses" && cp "$ROOT/licenses/"* "$DMG_SRC/Licenses/"

DMG="$DIST/Arrow-Switch-$VERSION.dmg"
rm -f "$DMG"
hdiutil create -volname "$NAME" -srcfolder "$DMG_SRC" -fs HFS+ -format UDZO -ov "$DMG" >/dev/null

if [ -n "${APP_SIGN_ID:-}" ]; then
  codesign --sign "$APP_SIGN_ID" --timestamp "$DMG"
  if [ -n "${NOTARY_PROFILE:-}" ]; then
    xcrun notarytool submit "$DMG" --keychain-profile "$NOTARY_PROFILE" --wait
    xcrun stapler staple "$DMG"
  fi
fi

step "Done"
echo "$DMG"
