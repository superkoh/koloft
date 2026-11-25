export function ensureMinimumFn(s: {
  tool: string
  product: string
  min: string
  update: string
  byHand: string
}): string {
  return `${s.tool}_meets_minimum() {
  kmin_v="$("$1" --version 2>/dev/null | sed -n '1s/^[^0-9]*\\([0-9][0-9]*\\.[0-9][0-9]*\\.[0-9][0-9]*\\).*/\\1/p')"
  [ -z "$kmin_v" ] && return 0
  awk -v a="$kmin_v" -v b="${s.min}" 'BEGIN { split(a, x, "."); split(b, y, "."); for (i = 1; i <= 3; i++) if (x[i] + 0 != y[i] + 0) exit (x[i] + 0 < y[i] + 0); exit 0 }'
}
ensure_${s.tool}_minimum() {
  ${s.tool}_meets_minimum "$1" && return 0
  printf '[Koloft] ${s.product} %s is older than %s, the oldest this Koloft supports. Updating it now...\\n' "$kmin_v" "${s.min}" >&2
  ${s.update}
  ${s.tool}_meets_minimum "$1" && return 0
  printf '[Koloft] ${s.product} is still older than %s. ${s.byHand}, then start the session again.\\n' "${s.min}" >&2
  return 1
}`
}
