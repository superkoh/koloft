import fs from 'fs'
import path from 'path'

export const SECRET_VERB = 'secret'
export const ASKPASS_NAME = 'koloft-askpass'

// PLATFORM§54
export const SUDO_WRAPPER = `#!/bin/sh
: koloft sudo wrapper
self="$(cd "$(dirname "$0")" >/dev/null 2>&1 && pwd)"
real=""
IFS=:
set -f
for d in $PATH; do
  [ "$d" = "$self" ] && continue
  [ -x "$d/sudo" ] || continue
  head -n 2 "$d/sudo" 2>/dev/null | grep -q "koloft sudo wrapper" && continue
  real="$d/sudo"
  break
done
set +f
unset IFS
if [ -z "$real" ]; then
  echo "sudo: not found" >&2
  exit 127
fi
if [ -n "$SUDO_ASKPASS" ] || (exec </dev/tty) 2>/dev/null; then exec "$real" "$@"; fi
for a in "$@"; do
  case "$a" in
    -S|--stdin|-n|--non-interactive) exec "$real" "$@" ;;
    --) break ;;
    -*) ;;
    *) break ;;
  esac
done
SUDO_ASKPASS="$self/${ASKPASS_NAME}" exec "$real" -A "$@"
`

// PLATFORM§54
export const ASKPASS = `#!/bin/sh
: koloft askpass
exec "$(dirname "$0")/koloft" ${SECRET_VERB} sudo "$1" "$(ps -o args= -p "$PPID" 2>/dev/null)"
`

export const SUDO_SHIM_FILES: Record<string, string> = {
  sudo: SUDO_WRAPPER,
  [ASKPASS_NAME]: ASKPASS
}

export function writeSudoShims(dir: string): void {
  for (const [name, text] of Object.entries(SUDO_SHIM_FILES)) {
    const file = path.join(dir, name)
    fs.writeFileSync(file, text, { mode: 0o755 })
    fs.chmodSync(file, 0o755)
  }
}
