import fs from 'fs'
import path from 'path'
import { VIEWABLE_EXTENSIONS } from '@shared/preview'
import { shq } from '@shared/shellQuote'

const EXT_GLOBS = VIEWABLE_EXTENSIONS.map((e) => `*${e}`).join('|')

export const OPEN_SHIM_HEAD = `#!/usr/bin/env bash
: koloft open shim
self_dir="$(cd "$(dirname "$0")" >/dev/null 2>&1 && pwd)"

passthrough() {
  real=""
  old_ifs="$IFS"; IFS=":"
  set -f
  for d in $PATH; do
    [ "$d" = "$self_dir" ] && continue
    [ -x "$d/open" ] || continue
    if head -n 2 "$d/open" 2>/dev/null | grep -q "koloft open shim"; then continue; fi
    real="$d/open"; break
  done
  set +f
  IFS="$old_ifs"
  [ -z "$real" ] && real="/usr/bin/open"
  exec "$real" "$@"
}
`

export const OPEN_SHIM_TARGET = `[ "$#" -eq 1 ] || passthrough "$@"
case "$1" in -*) passthrough "$@" ;; esac

f="$1"
url=""
abs=""
case "$f" in
  http://*|https://*) url="$f" ;;
  file://localhost/*) f="\${f#file://localhost}"; f="$(printf '%b' "\${f//%/\\\\x}")" ;;
  file:///*) f="\${f#file://}"; f="$(printf '%b' "\${f//%/\\\\x}")" ;;
  *://*) passthrough "$@" ;;
esac
if [ -z "$url" ]; then
  low="$(printf '%s' "$f" | tr '[:upper:]' '[:lower:]')"
  case "$low" in
    ${EXT_GLOBS}) ;;
    *) passthrough "$@" ;;
  esac
  [ -f "$f" ] || passthrough "$@"
  case "$f" in /*) abs="$f" ;; *) abs="$PWD/$f" ;; esac
fi
if [ "$(printf '%s' "$abs$url$PWD" | LC_ALL=C tr -d '[:cntrl:]')" != "$abs$url$PWD" ]; then passthrough "$@"; fi

newid() {
  u="$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z')"
  if [ -z "$u" ] && [ -r /proc/sys/kernel/random/uuid ]; then u="$(cat /proc/sys/kernel/random/uuid)"; fi
  echo "$u"
}

esc() { printf '%s' "$1" | sed -e 's/\\\\/\\\\\\\\/g' -e 's/"/\\\\"/g'; }

write_drop() {
  oid="$(newid)"
  [ -n "$oid" ] || oid="$$-$(date +%s)"
  part="$1/$oid.part"
  printf '{"tabId":"%s","openId":"%s","path":"%s","url":"%s","cwd":"%s","ts":%s}\\n' \\
    "$(esc "$2")" "$oid" "$(esc "$abs")" "$(esc "$url")" "$(esc "$PWD")" "$(date +%s)" > "$part" 2>/dev/null \\
    && mv "$part" "$1/$oid.json" 2>/dev/null && return 0
  rm -f "$part" 2>/dev/null
  return 1
}
`

export const CODEX_OPEN_SENT = 'koloft-open:sent'

// CODEX§12
function codexOpenShimScript(requestDir: string): string {
  const dir = shq(requestDir)
  return `${OPEN_SHIM_HEAD}
[ -d ${dir} ] || passthrough "$@"
${OPEN_SHIM_TARGET}
if write_drop ${dir} ""; then echo ${CODEX_OPEN_SENT}; else echo koloft-open:blocked; fi
exit 0
`
}

const ZSH_DOTFILES = ['.zshenv', '.zprofile', '.zshrc', '.zlogin']

// PLATFORM§2
function zdotFile(name: string, userDotDir: string, shimDir: string): string {
  const own = `${userDotDir}/${name}`
  const source = `[ -f ${own} ] && . ${own}\n`
  return name === '.zprofile' ? `${source}export PATH=${shq(shimDir)}:"$PATH"\n` : source
}

export interface CodexOpenShim {
  shimDir: string
  zdotDir: string
  requestDir: string
}

export function writeCodexOpenShim(
  root: string,
  token: string,
  userZdotdir: string | undefined
): CodexOpenShim {
  const shimDir = path.join(root, token)
  const zdotDir = path.join(shimDir, 'zdot')
  const shim = { shimDir, zdotDir, requestDir: `/tmp/koloft-cx-open-${token}` }
  try {
    fs.mkdirSync(zdotDir, { recursive: true })
    fs.writeFileSync(path.join(shimDir, 'open'), codexOpenShimScript(shim.requestDir), {
      mode: 0o755
    })
    const userDotDir = userZdotdir ? shq(userZdotdir) : '"$HOME"'
    for (const name of ZSH_DOTFILES)
      fs.writeFileSync(path.join(zdotDir, name), zdotFile(name, userDotDir, shimDir))
    fs.mkdirSync(shim.requestDir, { mode: 0o700 })
  } catch (error) {
    removeCodexOpenShim(shim)
    throw error
  }
  return shim
}

export function removeCodexOpenShim(shim: CodexOpenShim): void {
  fs.rmSync(shim.shimDir, { recursive: true, force: true })
  fs.rmSync(shim.requestDir, { recursive: true, force: true })
}
