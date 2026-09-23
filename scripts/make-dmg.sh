#!/usr/bin/env bash
# Build a drag-to-install DMG from the packaged Koloft.app using hdiutil makehybrid.
# Unlike `electron-builder`'s dmg target, makehybrid reads the source folder
# directly and never needs a writable disk-image mount, so it also works in
# sandboxed/CI environments where mounting images read-write is blocked.
set -euo pipefail
cd "$(dirname "$0")/.."

APP="release/mac-arm64/Koloft.app"
VER="$(node -p "require('./package.json').version")"
OUT="release/Koloft-${VER}-arm64.dmg"
TMP_RO="$(mktemp -u /tmp/koloft-ro-XXXX.dmg)"
STAGING="$(mktemp -d)"

if [ ! -d "$APP" ]; then
  echo "error: $APP not found — run 'electron-builder --mac --arm64 dir' first" >&2
  exit 1
fi

# Refuse to ship an app bundled from a pre-fix @xterm/addon-webgl (the v0.4.1
# garbled-screen regression class) — also guards the "Koloft.app already exists, just run
# make-dmg.sh" path, where the .app may predate the dependency fix.
bash scripts/assert-webgl-atlas.sh "$APP/Contents/Resources/app.asar"

cp -R "$APP" "$STAGING/Koloft.app"
ln -s /Applications "$STAGING/Applications"

rm -f "$OUT" "$TMP_RO"
hdiutil makehybrid -hfs -hfs-volume-name "Koloft" -o "$TMP_RO" "$STAGING" >/dev/null
hdiutil convert "$TMP_RO" -format UDZO -o "$OUT" >/dev/null

rm -rf "$STAGING" "$TMP_RO"
echo "Created $OUT"
