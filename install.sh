#!/usr/bin/env bash
# One-line installer for Koloft (macOS arm64, unsigned build):
#
#   curl -fsSL https://raw.githubusercontent.com/superkoh/koloft-releases/main/install.sh | bash
#
# Why this exists: Koloft's .dmg is unsigned and un-notarized, so a *browser*
# download gets the com.apple.quarantine attribute and Gatekeeper refuses to
# launch it ("damaged" / "unidentified developer"). Files fetched with curl
# carry no quarantine, so downloading the dmg here and copying the app out
# yields an /Applications/Koloft.app that opens with a normal double-click, with
# no paid Apple Developer ID and no Gatekeeper prompt.
#
# Kept strictly ASCII on purpose: this runs under whatever locale the user has,
# and a multibyte char (e.g. an ellipsis) next to an unbraced $var can get
# glued onto the variable name in single-byte locales and break `set -u`.
set -euo pipefail

# Binaries live in their own repo, apart from the source in superkoh/koloft, so the
# release list stays nothing but installers.
REPO="superkoh/koloft-releases"
APP_DIR="/Applications"

if [ "$(uname -s)" != "Darwin" ]; then
  echo "Koloft is macOS-only." >&2; exit 1
fi
if [ "$(uname -m)" != "arm64" ]; then
  echo "Koloft ships arm64-only; this Mac reports $(uname -m)." >&2; exit 1
fi

echo "Finding the latest Koloft release..."
DMG_URL=$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep -o 'https://[^"]*-arm64\.dmg' | head -1) || true
if [ -z "${DMG_URL:-}" ]; then
  echo "Could not find an arm64 .dmg in the latest release of ${REPO}." >&2; exit 1
fi

TMP="$(mktemp -d)"
MNT="$(mktemp -d)"
cleanup() { hdiutil detach "$MNT" -quiet 2>/dev/null || true; rm -rf "$TMP" "$MNT"; }
trap cleanup EXIT

echo "Downloading ${DMG_URL##*/} ..."
curl -fL --progress-bar -o "${TMP}/Koloft.dmg" "$DMG_URL"

echo "Mounting..."
hdiutil attach "${TMP}/Koloft.dmg" -nobrowse -quiet -mountpoint "$MNT"

# The bundle's name is read off the dmg rather than assumed.
# `|| true`: under `set -e` a dmg with no .app would otherwise abort right here, before
# the message below ever prints.
APP_NAME="$(cd "$MNT" && (ls -d ./*.app 2>/dev/null || true) | head -1 | sed 's#^\./##')"
if [ -z "${APP_NAME:-}" ]; then
  echo "The downloaded dmg contains no .app bundle." >&2; exit 1
fi
APP="${APP_DIR}/${APP_NAME}"
BIN="${APP_NAME%.app}"

# /Applications is group-writable by admins; fall back to sudo only if not.
SUDO=""; [ -w "$APP_DIR" ] || SUDO="sudo"
echo "Installing to ${APP} ..."
$SUDO rm -rf "$APP"
$SUDO cp -R "${MNT}/${APP_NAME}" "$APP"
# Belt and suspenders: nothing above applies quarantine, but if an earlier
# browser download left the flag on a previous copy, clear it too.
$SUDO xattr -dr com.apple.quarantine "$APP" 2>/dev/null || true
if pgrep -x "$BIN" >/dev/null 2>&1; then
  echo "Installed. The previous version is still running;"
  echo "quit it (Cmd-Q) and open ${BIN} from /Applications to use this one."
else
  echo "Installed. Launch from /Applications, or run: open -a ${BIN}"
fi
