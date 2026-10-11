#!/usr/bin/env bash
# The release build: package Koloft.app signed with the Developer ID identity in the login
# keychain and notarized by Apple, then wrap it in a drag-to-install DMG that is signed,
# notarized and stapled too. Run it through `npm run dist:dmg`, after `npm run build`.
set -euo pipefail
cd "$(dirname "$0")/.."

export APPLE_KEYCHAIN_PROFILE=koloft
APP="release/mac-arm64/Koloft.app"
VER="$(node -p "require('./package.json').version")"
OUT="release/Koloft-${VER}-arm64.dmg"

npx electron-builder --mac --arm64 --dir -c.forceCodeSigning=true

# Refuse to ship an app bundled from a pre-fix @xterm/addon-webgl (the garbled-screen
# regression class).
bash scripts/assert-webgl-atlas.sh "$APP/Contents/Resources/app.asar"

# Gatekeeper's own verdict: passes only for a Developer ID signature with a notarization
# ticket.
spctl --assess --type execute --verbose=2 "$APP"

STAGING="$(mktemp -d)"
ditto "$APP" "$STAGING/Koloft.app"
ln -s /Applications "$STAGING/Applications"

# PLATFORM§3
rm -f "$OUT"
hdiutil create -volname "Koloft" -srcfolder "$STAGING" -fs HFS+ -format UDZO "$OUT" >/dev/null
rm -rf "$STAGING"

IDENTITY="$(codesign -dvv "$APP" 2>&1 | sed -n 's/^Authority=\(Developer ID Application: .*\)$/\1/p')"
codesign --sign "$IDENTITY" --timestamp "$OUT"
xcrun notarytool submit "$OUT" --keychain-profile "$APPLE_KEYCHAIN_PROFILE" --wait
xcrun stapler staple "$OUT"
spctl --assess --type open --context context:primary-signature --verbose=2 "$OUT"

echo "Created $OUT"
