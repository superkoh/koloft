import fs from 'fs'
import path from 'path'
import { shq } from '@shared/shellQuote'
import { NEWID_FN } from './openShimScript'

const TEN_SECONDS_OF_50MS_TICKS = 200

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

const BODY = `
${NEWID_FN}
id="$(newid)"
[ -n "$id" ] || id="$$-$(date +%s)"
args=""
for a in "$@"; do args="$args\${args:+,}\\"$(jstr "$a")\\""; done
part="$dir/req-$id.part"
req="$dir/req-$id.json"
res="$dir/res-$id.json"
if ! printf '{%s"argv":[%s],"cwd":"%s"}\\n' "$tabfield" "$args" "$(jstr "$PWD")" > "$part" 2>/dev/null || ! mv "$part" "$req" 2>/dev/null; then
  rm -f "$part" 2>/dev/null
  echo "$unwritable" >&2
  exit 1
fi
waits=0
while [ ! -f "$res" ] && [ "$waits" -lt ${TEN_SECONDS_OF_50MS_TICKS} ]; do sleep 0.05; waits=$((waits+1)); done
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
${BODY}`

// CODEX§12 CODEX§17
function codexAgentShim(requestDir: string): string {
  return `${HEAD}
dir=${shq(requestDir)}
if [ ! -d "$dir" ]; then
  echo "koloft: this Codex session is no longer linked to Koloft." >&2
  exit 1
fi
tabfield=""
unwritable="koloft: this sandbox is read-only, so koloft cannot run here."
${BODY}`
}

export function writeCodexAgentShim(shimDir: string, requestDir: string): void {
  fs.writeFileSync(path.join(shimDir, 'koloft'), codexAgentShim(requestDir), { mode: 0o755 })
}
