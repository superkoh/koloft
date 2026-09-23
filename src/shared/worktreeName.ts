/** §5: the name becomes the branch `worktree-<name>`, so it must survive
 *  `git check-ref-format --branch`. The charset already excludes everything git
 *  refuses except a trailing dot, `..`, and a `.lock` suffix (probed against real
 *  git); the leading dot is refused by the spec's own rule. Shared since D11 — main
 *  refuses the same names the dialog does instead of dropping the flag. */
export function isValidWorktreeName(name: string): boolean {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(name)) return false
  if (name.startsWith('.') || name.endsWith('.')) return false
  if (name.includes('..') || name.endsWith('.lock')) return false
  // a dash-leading name reaches the launch line as `-w --force` — a flag-shaped token
  // where a value belongs (review find #4; implementation-period tightening 08-16)
  if (name.startsWith('-')) return false
  return true
}
