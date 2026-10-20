import fs from 'fs'
import path from 'path'
import { shq } from '@shared/shellQuote'
import { AGENT_GUIDE } from '@shared/agentGuide'
import { NEWID_FN } from './openShimScript'
import { REMOTE_HOOK_DIR } from './remote/paths'
import { SECRET_VERB, writeSudoShims } from './sudoShim'

export const AGENT_SHIM_WAITS_MS = 10_000
const SHIM_POLL_MS = 50

const HEAD = `#!/usr/bin/env bash
: koloft agent shim
jstr() {
  local s=$1
  s=\${s//\\\\/'\\\\'}
  s=\${s//\\"/'\\"'}
  s=\${s//$'\\n'/'\\n'}
  s=\${s//$'\\r'/'\\r'}
  s=\${s//$'\\t'/'\\t'}
  printf '%s' "$s" | LC_ALL=C tr -d '\\001-\\037'
}
`

const REMOTE_AGENT_SHIM_WAITS_MS = 30_000
const REMOTE_POLL_WELL_UNDER_ONE_MIRROR_PULL_MS = 250

export const OWNER_TYPES_A_SECRET_WITHIN_MS = 9 * 60_000
const SECRET_REPLY_OUTLIVES_THE_ASK_MS = 60_000
const PAGE_PICTURES_REACH_DISCORD_WITHIN_MS = 10 * 60_000

const body = (waitsMs: number, pollMs = SHIM_POLL_MS): string => `
${NEWID_FN}
id="$(newid)"
[ -n "$id" ] || id="$$-$(date +%s)"
args=""
for a in "$@"; do args="$args\${args:+,}\\"$(jstr "$a")\\""; done
part="$dir/req-$id.part"
req="$dir/req-$id.json"
res="$dir/res-$id.json"
trap 'rm -f "$req" "$part" 2>/dev/null' EXIT
trap 'exit 143' TERM HUP INT
if ! printf '{%s"argv":[%s],"cwd":"%s","pid":%s}\\n' "$tabfield" "$args" "$(jstr "$PWD")" "$$" > "$part" 2>/dev/null || ! mv "$part" "$req" 2>/dev/null; then
  rm -f "$part" 2>/dev/null
  echo "$unwritable" >&2
  exit 1
fi
waits=0
limit=${waitsMs / pollMs}
[ "$1" = ${SECRET_VERB} ] && limit=${(OWNER_TYPES_A_SECRET_WITHIN_MS + SECRET_REPLY_OUTLIVES_THE_ASK_MS) / pollMs}
[ "$1" = discord ] && [ "$2" = shot ] && limit=${PAGE_PICTURES_REACH_DISCORD_WITHIN_MS / pollMs}
while [ ! -f "$res" ] && [ "$waits" -lt "$limit" ]; do sleep ${pollMs / 1000}; waits=$((waits+1)); done
if [ ! -f "$res" ]; then
  rm -f "$req" 2>/dev/null
  echo "koloft: Koloft did not answer." >&2
  exit 1
fi
reply="$(cat "$res" 2>/dev/null)"
rm -f "$res" 2>/dev/null
code="$(printf '%s' "$reply" | LC_ALL=C sed -n 's/^{"exit":\\([0-9]*\\),.*/\\1/p')"
code="\${code:-1}"
text="$(printf '%s' "$reply" | LC_ALL=C sed -e 's/^{"exit":[0-9]*,"text":"//' -e 's/"}$//' -e 's/\\\\"/"/g')"
if [ -n "$text" ]; then
  if [ "$code" = 0 ]; then printf '%b\\n' "$text"; else printf '%b\\n' "$text" >&2; fi
fi
exit "$code"
`

export const CLAUDE_AGENT_SHIM = `${HEAD}
if [ -z "$KOLOFT_AGENT_DIR" ] || [ -z "$KOLOFT_TAB_ID" ] || [ -z "$KOLOFT_PID" ] || ! kill -0 "$KOLOFT_PID" 2>/dev/null; then
  echo "koloft: this works only in a Koloft session with agent tools turned on (Koloft Settings)." >&2
  exit 1
fi
dir="$KOLOFT_AGENT_DIR"
tabfield="\\"tabId\\":\\"$(jstr "$KOLOFT_TAB_ID")\\","
unwritable="koloft: could not reach Koloft."
${body(AGENT_SHIM_WAITS_MS)}`

export const REMOTE_AGENT_SHIM = `${HEAD}
if [ -z "$KOLOFT_TAB_ID" ]; then
  echo "koloft: this works only in a Koloft session." >&2
  exit 1
fi
dir="${REMOTE_HOOK_DIR}"
mkdir -p "$dir" 2>/dev/null
tm=""
[ -n "$TMUX" ] && tm="$(tmux display-message -p -t "$TMUX_PANE" '#S' 2>/dev/null)"
tabfield="\\"tabId\\":\\"$(jstr "$KOLOFT_TAB_ID")\\",\\"tmux\\":\\"$(jstr "$tm")\\","
unwritable="koloft: could not reach Koloft."
${body(REMOTE_AGENT_SHIM_WAITS_MS, REMOTE_POLL_WELL_UNDER_ONE_MIRROR_PULL_MS)}`

// CODEX§12 CODEX§17
function codexAgentShim(requestDir: string, guide: string): string {
  return `${HEAD}
case "\${1:-help}" in help|--help) cat ${shq(guide)}; exit 0 ;; esac
dir=${shq(requestDir)}
if [ ! -d "$dir" ]; then
  echo "koloft: this Codex session is no longer linked to Koloft." >&2
  exit 1
fi
tabfield=""
unwritable="koloft: this sandbox is read-only, so koloft cannot run here."
${body(AGENT_SHIM_WAITS_MS)}`
}

export function writeAgentShim(shimDir: string, requestDir: string): void {
  const guide = path.join(shimDir, 'koloft-guide.txt')
  fs.writeFileSync(guide, AGENT_GUIDE + '\n')
  fs.writeFileSync(path.join(shimDir, 'koloft'), codexAgentShim(requestDir, guide), {
    mode: 0o755
  })
  writeSudoShims(shimDir)
}
