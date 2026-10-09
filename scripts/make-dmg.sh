#!/usr/bin/env bash
# Build a drag-to-install DMG from the signed, notarized Koloft.app, then sign,
# notarize and staple the DMG itself.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="release/mac-arm64/Koloft.app"
VER="$(node -p "require('./package.json').version")"
OUT="release/Koloft-${VER}-arm64.dmg"
STAGING="$(mktemp -d)"

if [ ! -d "$APP" ]; then
  echo "error: $APP not found — run 'electron-builder --mac --arm64 dir' first" >&2
  exit 1
fi
if [ -z "${APPLE_KEYCHAIN_PROFILE:-}" ]; then
  echo "error: APPLE_KEYCHAIN_PROFILE is not set — run this through 'npm run dist:dmg'" >&2
  exit 1
fi

# Refuse to ship an app bundled from a pre-fix @xterm/addon-webgl (the garbled-screen
# regression class) — also guards the "Koloft.app already exists, just run
# make-dmg.sh" path, where the .app may predate the dependency fix.
bash scripts/assert-webgl-atlas.sh "$APP/Contents/Resources/app.asar"

# Gatekeeper's own verdict: passes only for a Developer ID signature with a notarization
# ticket, so an unsigned or stale .app never reaches a dmg.
spctl --assess --type execute --verbose=2 "$APP"

# The build paths were stripped before signing (scripts/strip-native-build-paths.cjs).
if grep -rqa "$HOME" "$APP/Contents/Resources"; then
  echo "error: the app still contains $HOME" >&2
  exit 1
fi

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
