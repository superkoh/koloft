/**
 * The pure half of the self-updater's install step (no Electron import, so it is unit-tested
 * by actually running the script). updater.ts owns the download/mount flow around it.
 */

/** The bundle to install out of a mounted dmg: the one `.app` entry (a dmg also carries the
 *  `Applications` symlink and a `.background`/`.DS_Store`). Prefers `Koloft.app` should a dmg
 *  ever carry two; null when there is none. */
export function pickAppBundle(entries: readonly string[]): string | null {
  const apps = entries.filter((n) => n.endsWith('.app')).sort()
  if (apps.includes('Koloft.app')) return 'Koloft.app'
  return apps[0] ?? null
}

// Detached helper that runs AFTER the app quits: waits for our PID to die, copies the
// staged bundle over the running one, strips quarantine, relaunches. Built so the live
// bundle is only touched once a complete copy exists (cp to .new, then rename-swap), so a
// failed copy never leaves the app missing. Paths are passed as argv (not interpolated)
// so a path can never break the script.
//   $1 PID   the app process to wait for
//   $2 SRC   the staged copy of the new bundle
//   $3 DEST  where it goes — the running bundle for a same-name update
//   $4 WORK  the temp dir holding SRC and the dmg; removed on every exit
//   $5 OLD   the running bundle when the update changes the bundle's name: DEST is
//            then a new path beside it, and OLD is removed only after DEST is complete.
//            Empty (or equal to DEST) for a same-name update.
export const INSTALL_SCRIPT = `#!/bin/bash
# Koloft self-update helper — runs detached, swaps the app bundle, relaunches.
set -e
PID="$1"; SRC="$2"; DEST="$3"; WORK="$4"; OLD="\${5:-}"
# Runs on EVERY exit (success or failure): if we died after moving the old bundle aside but
# before the new one landed, put the old one back so the app is never left missing; then
# remove the .old/.new scratch and the work dir — on failure the app has already quit and
# can't clean up, so the leftover ~150MB dmg would otherwise orphan forever.
cleanup() {
  [ -e "$DEST" ] || mv "\${DEST}.old" "$DEST" 2>/dev/null || true
  rm -rf "\${DEST}.old" "\${DEST}.new" "$WORK" 2>/dev/null || true
}
trap cleanup EXIT
for _ in $(seq 1 150); do kill -0 "$PID" 2>/dev/null || break; sleep 0.2; done
sleep 0.3
NEW="\${DEST}.new"
rm -rf "$NEW"
cp -R "$SRC" "$NEW"
xattr -dr com.apple.quarantine "$NEW" 2>/dev/null || true
rm -rf "\${DEST}.old"
if [ -e "$DEST" ]; then mv "$DEST" "\${DEST}.old"; fi
mv "$NEW" "$DEST"
if [ -n "$OLD" ] && [ "$OLD" != "$DEST" ]; then rm -rf "$OLD"; fi
open "$DEST"
`
