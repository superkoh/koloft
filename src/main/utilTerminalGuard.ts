const GUARD_MARK_LINE = ': koloft util guard'
const LINE_2_OF_A_GUARD_WITHOUT_THE_MARK = 'if [ "$KOLOFT_UTIL" = "1" ]; then'

export const isAUtilTerminalGuard = (file: string): string =>
  `head -n 2 ${file} 2>/dev/null | grep -q -F -x -e '${GUARD_MARK_LINE}' -e '${LINE_2_OF_A_GUARD_WITHOUT_THE_MARK}'`

export function utilTerminalGuard(bin: string, refusal: string, accountPick = ''): string {
  return `#!/bin/sh
${GUARD_MARK_LINE}
${refusal}
${accountPick}self=$(cd "$(dirname "$0")" && pwd)
IFS=:
set -f
for d in $PATH; do
  [ "$d" = "$self" ] && continue
  [ -f "$d/${bin}" ] && [ -x "$d/${bin}" ] || continue
  if ${isAUtilTerminalGuard(`"$d/${bin}"`)}; then continue; fi
  exec "$d/${bin}" "$@"
done
echo "${bin}: not found" >&2
exit 127
`
}
