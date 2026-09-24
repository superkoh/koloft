import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import { VIEWABLE_EXTENSIONS } from '@shared/preview'
import { keychainNamespace } from '@shared/types'

export interface ShimPaths {
  shimDir: string
  regDir: string
  openDir: string
  pickDir: string
}

const SHIM_SCRIPT = `#!/usr/bin/env bash
: koloft claude shim
self_dir="$(cd "$(dirname "$0")" >/dev/null 2>&1 && pwd)"
real=""
old_ifs="$IFS"; IFS=":"
set -f
for d in $PATH; do
  [ "$d" = "$self_dir" ] && continue
  [ -x "$d/claude" ] || continue
  if head -n 2 "$d/claude" 2>/dev/null | grep -q "koloft claude shim"; then continue; fi
  real="$d/claude"; break
done
set +f
IFS="$old_ifs"
if [ -z "$real" ]; then echo "koloft-shim: real 'claude' not found on PATH" >&2; exit 127; fi

skip=0
resume=0
sid=""
prev=""
valflag=0
for a in "$@"; do
  if [ "$valflag" = "1" ]; then
    valflag=0
    case "$a" in
      -*) ;;                                   # not a value after all (optional-value flags like -w / -r)
      *) case "$prev" in -r|--resume|--session-id) sid="$a" ;; esac
         prev="$a"; continue ;;
    esac
  fi
  case "$a" in
    -p|--print|--version|-v|-h|--help|--help-all|mcp|config|doctor|update|install) skip=1 ;;
    -r|--resume|-c|--continue) resume=1 ;;
  esac
  case "$a" in
    -w|--worktree|--name|-n|--model|--permission-mode|--settings|--session-id|-r|--resume|--agent|--effort) valflag=1 ;;
  esac
  prev="$a"
done
case "$1" in ""|-*) ;; *) skip=1 ;; esac

if [ "$KOLOFT_UTIL" = "1" ]; then
  utilok=0
  valflag=0
  for a in "$@"; do
    if [ "$valflag" = "1" ]; then
      valflag=0
      case "$a" in -*) ;; *) continue ;; esac   # a flag's value, not a keyword (\`-w update\`)
    fi
    case "$a" in
      -p|--print|-h|--help|--help-all|-v|--version|doctor|mcp|config|auth|setup-token|agents|project|update|install|plugin|import) utilok=1 ;;
    esac
    case "$a" in
      -w|--worktree|--name|-n|--model|--permission-mode|--settings|--session-id|-r|--resume|--agent|--effort) valflag=1 ;;
    esac
  done
  if [ "$utilok" = "0" ]; then
    printf '⛔ Koloft — this is a Koloft terminal, not an agent surface.\\n' >&2
    printf '   %s\\n' "Start interactive Claude from the sidebar's ＋ (⌘N)." >&2
    printf '   %s\\n' 'Non-interactive use is fine: claude -p · --help · doctor · mcp · …' >&2
    exit 1
  fi
fi

# CC§6
pre=()
[ -n "$KOLOFT_HOOK_SETTINGS" ] && pre=(--settings "$KOLOFT_HOOK_SETTINGS")

newid() {
  u="$(uuidgen 2>/dev/null | tr 'A-Z' 'a-z')"
  if [ -z "$u" ] && [ -r /proc/sys/kernel/random/uuid ]; then u="$(cat /proc/sys/kernel/random/uuid)"; fi
  echo "$u"
}

register() {
  [ "$KOLOFT_UTIL" = "1" ] && return 0
  reg_dir="$KOLOFT_SESSION_DIR"
  if [ -z "$reg_dir" ]; then reg_dir="$HOME/.koloft/sessions"; fi
  mkdir -p "$reg_dir"
  printf '{"tabId":"%s","regId":"%s","sessionId":"%s","cwd":"%s","ts":%s,"mode":"%s"}\\n' \\
    "$KOLOFT_TAB_ID" "$1" "$2" "$PWD" "$(date +%s)" "$3" > "$reg_dir/$1.json"
}

# PLATFORM§17
if [ -n "$KOLOFT_CDP_DIR" ] && [ -n "$KOLOFT_TAB_ID" ] && [ "$KOLOFT_UTIL" != "1" ]; then
  export PLAYWRIGHT_CLI_SESSION="koloft-$KOLOFT_TAB_ID"
  kcdp="$(cat "$KOLOFT_CDP_DIR/$KOLOFT_TAB_ID" 2>/dev/null)"
  if [ -n "$kcdp" ]; then
    export PLAYWRIGHT_MCP_CDP_ENDPOINT="$kcdp"
    export KOLOFT_BROWSER_CDP="$kcdp"
  fi
  kcdp=""
fi

inj=()
noinj=0
hasperm=0
hasp=0
valflag=0
for a in "$@"; do
  if [ "$valflag" = "1" ]; then
    valflag=0
    case "$a" in -*) ;; *) continue ;; esac   # a flag's value, not a keyword (\`-w update\`)
  fi
  case "$a" in
    --version|-v|-h|--help|--help-all|mcp|config|doctor|update|install|setup-token) noinj=1 ;;
    --dangerously-skip-permissions|--permission-mode|--permission-mode=*) hasperm=1 ;;
    -p|--print) hasp=1 ;;
  esac
  case "$a" in
    -w|--worktree|--name|-n|--model|--permission-mode|--settings|--session-id|-r|--resume|--agent|--effort) valflag=1 ;;
  esac
done
if [ "$noinj" = "0" ]; then
  if [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] || [ -n "$ANTHROPIC_API_KEY" ] || [ -n "$ANTHROPIC_AUTH_TOKEN" ]; then
    [ -n "$KOLOFT_MULTI_ACCOUNT" ] && echo "koloft: auth token already in env, skipping balancing" >&2
  elif [ -n "$KOLOFT_PICK_DIR" ] && [ -n "$KOLOFT_TAB_ID" ] && [ -n "$KOLOFT_PID" ] && kill -0 "$KOLOFT_PID" 2>/dev/null; then
    pickid="$(newid)"
    [ -n "$pickid" ] || pickid="$$-$(date +%s)"
    preq="$KOLOFT_PICK_DIR/req-$pickid.json"
    pres="$KOLOFT_PICK_DIR/res-$pickid.json"
    printf '{"tabId":"%s","ts":%s}\\n' "$KOLOFT_TAB_ID" "$(date +%s)" > "$preq" 2>/dev/null
    pwaits=0
    while [ ! -f "$pres" ] && [ "$pwaits" -lt 60 ]; do sleep 0.05; pwaits=$((pwaits+1)); done
    pacct=""
    preason="timeout"
    if [ -f "$pres" ]; then
      pacct="$(sed -n 's/.*"account":"\\([^"]*\\)".*/\\1/p' "$pres" 2>/dev/null)"
      pkind="$(sed -n 's/.*"kind":"\\([^"]*\\)".*/\\1/p' "$pres" 2>/dev/null)"
      pbanner="$(sed -n 's/.*"banner":"\\([^"]*\\)".*/\\1/p' "$pres" 2>/dev/null)"
      pwarn="$(sed -n 's/.*"warning":"\\([^"]*\\)".*/\\1/p' "$pres" 2>/dev/null)"
      pbase="$(sed -n 's/.*"baseUrl":"\\([^"]*\\)".*/\\1/p' "$pres" 2>/dev/null)"
      pmodel="$(sed -n 's/.*"model":"\\([^"]*\\)".*/\\1/p' "$pres" 2>/dev/null)"
      preason="$(sed -n 's/.*"reason":"\\([^"]*\\)".*/\\1/p' "$pres" 2>/dev/null)"
      pflag="$(sed -n 's/.*"skipFlag":true.*/1/p' "$pres" 2>/dev/null)"
    fi
    rm -f "$preq" "$pres" 2>/dev/null
    if [ -n "$pacct" ]; then
      psvc="__KOLOFT_KEYCHAIN_NS__-claude-oauth"
      [ "$pkind" = "apikey" ] && psvc="__KOLOFT_KEYCHAIN_NS__-anthropic-api"
      [ "$pkind" = "custom" ] && psvc="__KOLOFT_KEYCHAIN_NS__-custom-endpoint"
      # PLATFORM§3 PLATFORM§2
      ptokf="$KOLOFT_PICK_DIR/tok-$pickid"
      ( umask 077; exec security find-generic-password -s "$psvc" -a "$pacct" -w > "$ptokf" 2>/dev/null ) &
      psec=$!
      pswait=0
      while kill -0 "$psec" 2>/dev/null && [ "$pswait" -lt 100 ]; do sleep 0.05; pswait=$((pswait+1)); done
      kill "$psec" 2>/dev/null
      wait "$psec" 2>/dev/null
      ptok="$(cat "$ptokf" 2>/dev/null)"
      rm -f "$ptokf" 2>/dev/null
      if [ -n "$ptok" ]; then
        if [ "$pkind" = "apikey" ]; then
          export ANTHROPIC_API_KEY="$ptok"
          unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_AUTH_TOKEN
        elif [ "$pkind" = "custom" ]; then
          # CC§7
          export ANTHROPIC_AUTH_TOKEN="$ptok"
          export ANTHROPIC_BASE_URL="$pbase"
          unset CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_API_KEY
          if [ -n "$pmodel" ]; then
            export ANTHROPIC_MODEL="$pmodel"
            export ANTHROPIC_DEFAULT_OPUS_MODEL="$pmodel"
            export ANTHROPIC_DEFAULT_SONNET_MODEL="$pmodel"
            export ANTHROPIC_DEFAULT_HAIKU_MODEL="$pmodel"
            export ANTHROPIC_DEFAULT_FABLE_MODEL="$pmodel"
            export CLAUDE_CODE_SUBAGENT_MODEL="$pmodel"
            export CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1
          fi
        else
          export CLAUDE_CODE_OAUTH_TOKEN="$ptok"
          unset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN
        fi
        ptok=""
        export ANT_ACCOUNT="$pacct"
        [ -n "$pbanner" ] && printf '%s\\n' "$pbanner" >&2
        [ -n "$pwarn" ] && printf '%s\\n' "$pwarn" >&2
        if [ "$pflag" = "1" ] && [ "$hasperm" = "0" ] && [ "$hasp" = "0" ]; then
          inj+=(--dangerously-skip-permissions)
        fi
      else
        echo "koloft: no credential for $pacct, launching as-is" >&2
      fi
    else
      case "$preason" in
        no-accounts) echo "koloft: no usable account, using default login" >&2 ;;
        timeout) echo "koloft: account pick timed out, launching as-is" >&2 ;;
      esac
    fi
  fi
fi

# CC§7 CC§9
kfp="$KOLOFT_FIRST_PROMPT"
ksn="$KOLOFT_SESSION_NAME"
unset KOLOFT_FIRST_PROMPT KOLOFT_SESSION_NAME

if [ "$skip" = "1" ]; then
  exec "$real" "\${inj[@]}" "$@"
fi

if [ -n "$sid" ]; then
  register "$(newid)" "$sid" "exact"
  exec "$real" "\${pre[@]}" "\${inj[@]}" "$@"
fi

if [ "$resume" = "1" ]; then
  register "$(newid)" "" "resume"
  exec "$real" "\${pre[@]}" "\${inj[@]}" "$@"
fi

nid="$(newid)"
if [ -n "$nid" ]; then
  register "$nid" "$nid" "new"
  extra=()
  [ -n "$ksn" ] && extra+=(--name "$ksn")
  [ -n "$kfp" ] && extra+=(-- "$kfp")
  exec "$real" "\${pre[@]}" "\${inj[@]}" --session-id "$nid" "$@" "\${extra[@]}"
fi
exec "$real" "\${inj[@]}" "$@"
`

const EXT_GLOBS = VIEWABLE_EXTENSIONS.map((e) => `*${e}`).join('|')

// CC§12
const OPEN_SHIM_SCRIPT = `#!/usr/bin/env bash
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

[ -n "$KOLOFT_TAB_ID" ] && [ -n "$KOLOFT_OPEN_DIR" ] || passthrough "$@"
[ -n "$KOLOFT_PID" ] && kill -0 "$KOLOFT_PID" 2>/dev/null || passthrough "$@"
[ "$#" -eq 1 ] || passthrough "$@"
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

mkdir -p "$KOLOFT_OPEN_DIR" 2>/dev/null || passthrough "$@"
oid="$(newid)"
[ -n "$oid" ] || oid="$$-$(date +%s)"
out="$KOLOFT_OPEN_DIR/$oid.json"
printf '{"tabId":"%s","openId":"%s","path":"%s","url":"%s","cwd":"%s","ts":%s}\\n' \\
  "$(esc "$KOLOFT_TAB_ID")" "$oid" "$(esc "$abs")" "$(esc "$url")" "$(esc "$PWD")" "$(date +%s)" > "$out" 2>/dev/null \\
  || { rm -f "$out" 2>/dev/null; passthrough "$@"; }
exit 0
`

const STALE_REGISTRATION_AGE_MS = 12 * 60 * 60 * 1000
const STALE_PICK_AGE_MS = 60 * 60 * 1000

// ADR-0004
function pruneStale(dir: string, maxAgeMs = STALE_REGISTRATION_AGE_MS): void {
  let names: string[]
  try {
    names = fs.readdirSync(dir)
  } catch {
    return
  }
  const now = Date.now()
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const full = path.join(dir, name)
    try {
      if (now - fs.statSync(full).mtimeMs > maxAgeMs) fs.rmSync(full, { force: true })
    } catch {}
  }
}

export function setupShim(): ShimPaths {
  const base = app.getPath('userData')
  const shimDir = path.join(base, 'shim')
  const regDir = path.join(base, 'sessions')
  const openDir = path.join(base, 'opens')
  const pickDir = path.join(base, 'picks')

  fs.mkdirSync(shimDir, { recursive: true })
  fs.mkdirSync(regDir, { recursive: true })
  fs.mkdirSync(openDir, { recursive: true })
  fs.mkdirSync(pickDir, { recursive: true })
  pruneStale(regDir)
  pruneStale(openDir)
  pruneStale(pickDir, STALE_PICK_AGE_MS)

  const ns = keychainNamespace(app.getName())
  if (!/^[a-z0-9-]+$/.test(ns)) throw new Error(`unsafe keychain namespace: ${ns}`)

  const shimPath = path.join(shimDir, 'claude')
  fs.writeFileSync(shimPath, SHIM_SCRIPT.replaceAll('__KOLOFT_KEYCHAIN_NS__', ns), { mode: 0o755 })
  fs.chmodSync(shimPath, 0o755)

  const openShimPath = path.join(shimDir, 'open')
  fs.writeFileSync(openShimPath, OPEN_SHIM_SCRIPT, { mode: 0o755 })
  fs.chmodSync(openShimPath, 0o755)

  return { shimDir, regDir, openDir, pickDir }
}
