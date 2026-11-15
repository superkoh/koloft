import fs from 'fs'
import path from 'path'
import { VIEWABLE_EXTENSIONS } from '@shared/preview'
import { shq } from '@shared/shellQuote'
import { CODEX_TMP_DIR } from './leftovers'

const EXT_GLOBS = VIEWABLE_EXTENSIONS.map((e) => `*${e}`).join('|')

export const NEWID_FN = `newid() {
  u="$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z')"
  if [ -z "$u" ] && [ -r /proc/sys/kernel/random/uuid ]; then u="$(cat /proc/sys/kernel/random/uuid)"; fi
  echo "$u"
}`

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

${NEWID_FN}

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

export const NO_REPLY_ENV = 'KOLOFT_NO_REPLY'

export const REMOTE_OPEN_SHIM = `${OPEN_SHIM_HEAD}
[ -n "$KOLOFT_TAB_ID" ] || passthrough "$@"
${OPEN_SHIM_TARGET}
${NO_REPLY_ENV}=1 "$self_dir/koloft" open "$abs$url" >/dev/null 2>&1 || passthrough "$@"
exit 0
`

const ZSH_DOTFILES = ['.zshenv', '.zprofile', '.zshrc', '.zlogin']
const USER_ZDOTDIR_VAR = 'koloft_user_zdotdir'

// PLATFORM§2 CODEX§12
function zdotFile(
  name: string,
  userZdotdir: string | undefined,
  zdotDir: string,
  shimDir: string
): string {
  const own = `"\${ZDOTDIR:-$HOME}/${name}"`
  return [
    ...(name === '.zshenv' ? [`${USER_ZDOTDIR_VAR}=${userZdotdir ? shq(userZdotdir) : "''"}`] : []),
    `if [ -n "$${USER_ZDOTDIR_VAR}" ]; then ZDOTDIR="$${USER_ZDOTDIR_VAR}"; else unset ZDOTDIR; fi`,
    `[ -f ${own} ] && . ${own}`,
    `${USER_ZDOTDIR_VAR}="\${ZDOTDIR-}"`,
    `export ZDOTDIR=${shq(zdotDir)}`,
    ...(name === '.zprofile' ? [`export PATH=${shq(shimDir)}:"$PATH"`] : []),
    ''
  ].join('\n')
}

// CODEX§12
function bashEnvFile(shimDir: string): string {
  return `export PATH=${shq(shimDir)}:"$PATH"\nunset BASH_ENV\n`
}

export interface OpenShim {
  shimDir: string
  zdotDir: string
  bashEnv: string
  requestDir: string
}

export function writeOpenShim(
  root: string,
  token: string,
  userZdotdir: string | undefined
): OpenShim {
  const shimDir = path.join(root, token)
  const zdotDir = path.join(shimDir, 'zdot')
  const shim = {
    shimDir,
    zdotDir,
    bashEnv: path.join(shimDir, 'bash_env'),
    requestDir: path.join(CODEX_TMP_DIR, `koloft-cx-open-${token}`)
  }
  try {
    fs.mkdirSync(zdotDir, { recursive: true })
    fs.writeFileSync(path.join(shimDir, 'open'), codexOpenShimScript(shim.requestDir), {
      mode: 0o755
    })
    for (const name of ZSH_DOTFILES)
      fs.writeFileSync(path.join(zdotDir, name), zdotFile(name, userZdotdir, zdotDir, shimDir))
    fs.writeFileSync(shim.bashEnv, bashEnvFile(shimDir))
    fs.mkdirSync(shim.requestDir, { mode: 0o700 })
  } catch (error) {
    removeOpenShim(shim)
    throw error
  }
  return shim
}

export function removeOpenShim(shim: OpenShim): void {
  fs.rmSync(shim.shimDir, { recursive: true, force: true })
  fs.rmSync(shim.requestDir, { recursive: true, force: true })
}
