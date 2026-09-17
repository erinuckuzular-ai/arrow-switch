#!/bin/bash
#
# Builds "Install Arrow Switch.app" — the branded installer — from installer/app.
# Usage: build-installer-app.sh <zxp> <out-dir> [version]
#
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ZXP="$1"; OUT="$2"; VERSION="${3:-1.0.0}"
NAME="Install Arrow Switch"
APP="$OUT/$NAME.app"
SRC="$ROOT/installer/app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

BUILD="$(mktemp -d)"; trap 'rm -rf "$BUILD"' EXIT
for arch in arm64 x86_64; do
  swiftc -O -target "$arch-apple-macos13.0" -parse-as-library \
    "$SRC/main.swift" "$SRC/Mascot.swift" "$SRC/UI.swift" \
    -o "$BUILD/installer-$arch"
done
lipo -create "$BUILD/installer-arm64" "$BUILD/installer-x86_64" \
  -output "$APP/Contents/MacOS/ArrowSwitchInstaller"

cp "$ZXP" "$APP/Contents/Resources/ArrowSwitch.zxp"
[ -f "$SRC/AppIcon.icns" ] && cp "$SRC/AppIcon.icns" "$APP/Contents/Resources/"

cat > "$APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleExecutable</key><string>ArrowSwitchInstaller</string>
  <key>CFBundleIdentifier</key><string>com.arrow.switch.installer</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSPrincipalClass</key><string>NSApplication</string>
</dict></plist>
PLIST

if [ -n "${APP_SIGN_ID:-}" ]; then
  codesign --force --deep --options runtime --timestamp --sign "$APP_SIGN_ID" "$APP"
else
  codesign --force --deep --sign - "$APP"
fi
codesign -v "$APP"
echo "$APP"
