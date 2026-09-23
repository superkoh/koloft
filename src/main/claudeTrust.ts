import path from 'path'

/**
 * Has Claude Code been trusted with this folder yet?
 *
 * The first launch in a folder it has never seen asks "Quick safety check: is this a
 * project you created or one you trust?" — `--dangerously-skip-permissions` does not
 * skip it, and the question comes BEFORE SessionStart (docs/claude-code-contract.md §9).
 * A scheduled run there therefore never binds: it sits on the question until the start
 * deadline kills it, every single time. That is worth saying in the form and in the
 * history line, so this reads the one place Claude writes the answer down:
 * `~/.claude.json`, as `projects[<absolute path>].hasTrustDialogAccepted: true`.
 *
 * Koloft only ever READS that file. Answering the question is the person's to do, in a
 * real session, and writing `true` on their behalf would hand a scheduled job a folder
 * they never agreed to.
 *
 * Ancestors count: claude walks up from the folder, so a worktree inside an already
 * trusted repo inherits its trust and asks nothing.
 */
export function isTrustedByClaude(readClaudeJson: () => unknown, dir: string): boolean {
  let doc: unknown
  try {
    doc = readClaudeJson()
  } catch {
    // no file yet, or a half-written one — either way nothing has been trusted here
    return false
  }
  const projects = (doc as { projects?: unknown } | null | undefined)?.projects
  if (typeof projects !== 'object' || projects === null) return false
  const byPath = projects as Record<string, { hasTrustDialogAccepted?: unknown } | undefined>
  let p = dir
  for (;;) {
    if (byPath[p]?.hasTrustDialogAccepted === true) return true
    const up = path.dirname(p)
    if (up === p) return false
    p = up
  }
}
