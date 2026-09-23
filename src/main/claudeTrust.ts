import path from 'path'

// CC§9
export function isTrustedByClaude(readClaudeJson: () => unknown, dir: string): boolean {
  let doc: unknown
  try {
    doc = readClaudeJson()
  } catch {
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
