// CC§16 CODEX§7
export const MIN_CLAUDE_VERSION = '2.1.259'
export const MIN_CODEX_VERSION = '0.153.4'

export const ENSURE_CLAUDE_MINIMUM_FN = `claude_meets_minimum() {
  kmin_v="$("$1" --version 2>/dev/null | sed -n '1s/^\\([0-9][0-9]*\\.[0-9][0-9]*\\.[0-9][0-9]*\\).*/\\1/p')"
  [ -z "$kmin_v" ] && return 0
  awk -v a="$kmin_v" -v b="${MIN_CLAUDE_VERSION}" 'BEGIN { split(a, x, "."); split(b, y, "."); for (i = 1; i <= 3; i++) if (x[i] + 0 != y[i] + 0) exit (x[i] + 0 < y[i] + 0); exit 0 }'
}
ensure_claude_minimum() {
  claude_meets_minimum "$1" && return 0
  printf '[Koloft] Claude Code %s is older than %s, the oldest this Koloft supports. Updating it now...\\n' "$kmin_v" "${MIN_CLAUDE_VERSION}" >&2
  "$1" update
  claude_meets_minimum "$1" && return 0
  printf '[Koloft] Claude Code is still older than %s. Run "claude update" yourself, then start the session again.\\n' "${MIN_CLAUDE_VERSION}" >&2
  return 1
}`
