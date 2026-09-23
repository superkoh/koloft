export function pickAppBundle(entries: readonly string[]): string | null {
  const apps = entries.filter((n) => n.endsWith('.app')).sort()
  if (apps.includes('Koloft.app')) return 'Koloft.app'
  return apps[0] ?? null
}

// ADR-0006
export const INSTALL_SCRIPT = `#!/bin/bash
set -e
PID="$1"; SRC="$2"; DEST="$3"; WORK="$4"; OLD="\${5:-}"
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
