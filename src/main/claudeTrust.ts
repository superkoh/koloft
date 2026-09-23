import fs from 'fs'
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

// CC§9 ADR-0026
export function acceptClaudeTrust(claudeJson: string, dir: string): void {
  const doc = JSON.parse(fs.readFileSync(claudeJson, 'utf8'))
  const projects = (doc.projects ??= {})
  const key = fs.realpathSync(dir)
  projects[key] = { ...projects[key], hasTrustDialogAccepted: true }
  const tmp = `${claudeJson}.koloft-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), { mode: 0o600 })
  fs.renameSync(tmp, claudeJson)
}
