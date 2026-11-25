const GUARD_MARK_LINE = ': koloft util guard'
const LINE_2_OF_A_GUARD_WITHOUT_THE_MARK = 'if [ "$KOLOFT_UTIL" = "1" ]; then'

export function utilTerminalGuard(bin: string, refusal: string, accountPick = ''): string {
  return `#!/bin/sh
${GUARD_MARK_LINE}
${refusal}
${accountPick}self=$(cd "$(dirname "$0")" && pwd)
IFS=:
set -f
for d in $PATH; do
  [ "$d" = "$self" ] && continue
  [ -x "$d/${bin}" ] || continue
  if head -n 2 "$d/${bin}" 2>/dev/null | grep -q -F -x -e '${GUARD_MARK_LINE}' -e '${LINE_2_OF_A_GUARD_WITHOUT_THE_MARK}'; then continue; fi
  exec "$d/${bin}" "$@"
done
echo "${bin}: not found" >&2
exit 127
`
}
