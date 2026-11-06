import fs from 'fs'
import path from 'path'

export const SECRET_VERB = 'secret'
export const ASKPASS_NAME = 'koloft-askpass'

const A_TERMINAL_OPENS = '(exec </dev/tty) 2>/dev/null'
const A_TERMINAL_OPENS_IN_A_KOLOFT_SHELL_TAB = `{ [ "$KOLOFT_UTIL" = 1 ] && ${A_TERMINAL_OPENS}; }`

// PLATFORM§58
function sudoWrapper(theOwnersTerminal: string): string {
  return `#!/bin/sh
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
if [ -n "$SUDO_ASKPASS" ] || ${theOwnersTerminal}; then exec "$real" "$@"; fi
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
}

// PLATFORM§58
export const ASKPASS = `#!/bin/sh
: koloft askpass
exec "$(dirname "$0")/koloft" ${SECRET_VERB} sudo "$1" "$(ps -o args= -p "$PPID" 2>/dev/null)"
`

const sudoFiles = (theOwnersTerminal: string): Record<string, string> => ({
  sudo: sudoWrapper(theOwnersTerminal),
  [ASKPASS_NAME]: ASKPASS
})

export const SUDO_FILES_WHERE_ANY_TERMINAL_IS_THE_OWNERS = sudoFiles(A_TERMINAL_OPENS)

// CODEX§12 MUSE§8 AGY§25
export const SUDO_SHIM_FILES = sudoFiles(A_TERMINAL_OPENS_IN_A_KOLOFT_SHELL_TAB)

export function writeSudoShims(dir: string, files: Record<string, string>): void {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, name)
    fs.writeFileSync(file, text, { mode: 0o755 })
    fs.chmodSync(file, 0o755)
  }
}
