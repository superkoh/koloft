import path from 'path'
import type { ListeningPort } from '@shared/types'
import { AGENT_PROGRAM } from './machineTrees'
import { makeExec } from './taskProcs'

const SCAN_DEADLINE_MS = 5000
const SCAN_FINISHED = 'scanned'

// PLATFORM§59 PLATFORM§67
export const SESSION_PORTS_SH = String.raw`tags() {
  if [ -r /proc/self/environ ]; then
    grep -a -o -s -E 'KOLOFT_(TAB_ID|HOLD_TAB)=[^[:cntrl:]]+' /proc/[0-9]*/environ | sed 's#^/proc/\([0-9]*\)/environ:[^=]*=#\1 #'
  else
    ps -A -E -ww -o pid= -o command= | awk '{ s = $0; while (match(s, /KOLOFT_(TAB_ID|HOLD_TAB)=[^ ]+/)) { t = substr(s, RSTART, RLENGTH); sub(/^[^=]*=/, "", t); print $1, t; s = substr(s, RSTART + RLENGTH) } }'
  fi
}
panes=" "
[ -n "$2" ] && panes=" $(tmux -L koloft list-panes -s -t "=$2:" -F '#{pane_pid}' 2>/dev/null | tr '\n' ' ')"
table=$(ps -A -ww -o pid= -o ppid= -o args=) || exit 1
members=$({ tags; echo -; printf '%s\n' "$table"; } | awk -v ids="$1" -v panes="$panes" '
!table && $0 == "-" { table = 1; next }
!table { tagged[++t] = $1; tag[t] = $2; next }
{ pid = $1; up[pid] = $2; a = $0; sub(/^ *[0-9]+ +[0-9]+ */, "", a); args[pid] = a; order[++m] = pid }
END {
  n = split(ids, asked, " "); for (i = 1; i <= n; i++) own[asked[i]] = 1
  for (j = 1; j <= t; j++) for (p = tagged[j]; p > 1; p = up[p]) if (index(panes, " " p " ")) { own[tag[j]] = 1; break }
  for (j = 1; j <= t; j++) if (tag[j] in own) mine[tagged[j]] = 1; else other[tagged[j]] = 1
  for (grew = 1; grew; ) {
    grew = 0
    for (i = 1; i <= m; i++) {
      p = order[i]
      if (p in in_) continue
      if ((p in mine) || ((up[p] in in_) && !(p in other))) { in_[p] = 1; grew = 1 }
    }
  }
  for (i = 1; i <= m; i++) if (order[i] in in_) print "P", order[i], args[order[i]]
}')
if [ -n "$members" ]; then
  printf '%s\n' "$members"
  pids=$(printf '%s\n' "$members" | awk '{ print $2 }')
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -a -p "$(printf '%s\n' "$pids" | paste -s -d, -)" -iTCP -sTCP:LISTEN -Fpn 2>/dev/null
  else
    { for p in $pids; do ls -l "/proc/$p/fd" 2>/dev/null | sed -n "s/.*socket:\[\([0-9]*\)\]\$/$p \1/p"; done; echo -; cat /proc/net/tcp /proc/net/tcp6 2>/dev/null; } | awk '
function hex(s,  i, v) { v = 0; for (i = 1; i <= length(s); i++) v = v * 16 + index("0123456789ABCDEF", toupper(substr(s, i, 1))) - 1; return v }
!table && $0 == "-" { table = 1; next }
!table { owner[$2] = $1; next }
$4 == "0A" && ($10 in owner) { k = split($2, a, ":"); print "p" owner[$10]; print "n*:" hex(a[k]) }'
  fi
fi
echo ${SCAN_FINISHED}
`

const programName = (command: string): string => path.basename(command.split(' ')[0])

export function parseSessionPorts(stdout: string): ListeningPort[] | null {
  const lines = stdout.trimEnd().split('\n')
  if (lines.at(-1) !== SCAN_FINISHED) return null
  const commandOf = new Map<number, string>()
  const found = new Map<number, ListeningPort>()
  let pid = 0
  for (const line of lines) {
    const member = /^P (\d+) (.*)$/.exec(line)
    if (member) commandOf.set(Number(member[1]), member[2])
    else if (line.startsWith('p')) pid = Number(line.slice(1))
    else if (line.startsWith('n')) {
      const port = Number(/:(\d+)$/.exec(line)?.[1])
      const command = commandOf.get(pid) ?? ''
      if (!port || found.has(port) || AGENT_PROGRAM.test(command)) continue
      found.set(port, { port, pid, process: programName(command) })
    }
  }
  return [...found.values()].sort((a, b) => a.port - b.port)
}

const runHere = makeExec(SCAN_DEADLINE_MS)

export function scanPortsHere(tags: string[]): Promise<string> {
  return runHere('/bin/sh', ['-c', SESSION_PORTS_SH, 'ports', tags.join(' ')])
}
