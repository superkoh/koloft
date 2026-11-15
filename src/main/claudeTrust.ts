import fs from 'fs'
import os from 'os'
import path from 'path'
import { realpathSafe } from './projectInfo'
import { writePrivateAtomically } from './privateFile'

export function claudeJsonPath(): string {
  return path.join(os.homedir(), '.claude.json')
}

// CC§9
export function isTrustedByClaude(
  readClaudeJson: () => unknown,
  dir: string,
  repoTop: string | null
): boolean {
  let doc: unknown
  try {
    doc = readClaudeJson()
  } catch {
    return false
  }
  const projects = (doc as { projects?: unknown } | null | undefined)?.projects
  if (typeof projects !== 'object' || projects === null) return false
  const byPath = projects as Record<string, { hasTrustDialogAccepted?: unknown } | undefined>
  const trusted = (p: string): boolean => byPath[p]?.hasTrustDialogAccepted === true
  const inside = (top: string): boolean =>
    dir === top || dir.startsWith(top.endsWith(path.sep) ? top : top + path.sep)
  if (repoTop !== null && !inside(repoTop)) return trusted(dir)
  for (let p = dir; ; p = path.dirname(p)) {
    if (trusted(p)) return true
    if (p === repoTop || path.dirname(p) === p) return false
  }
}

// CC§9
function mainRepoTop(worktree: string): string {
  try {
    const line = fs
      .readFileSync(path.join(worktree, '.git'), 'utf8')
      .split('\n')
      .find((l) => l.startsWith('gitdir:'))
    if (!line) return worktree
    const gitDir = path.resolve(worktree, line.slice('gitdir:'.length).trim())
    const commonDir = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()
    return realpathSafe(path.dirname(path.resolve(gitDir, commonDir)))
  } catch {
    return worktree
  }
}

// CC§9
function claudeTrustRepoTop(realDir: string): string | null {
  for (let x = realDir; ; x = path.dirname(x)) {
    let dotGit: fs.Stats | undefined
    try {
      dotGit = fs.lstatSync(path.join(x, '.git'))
    } catch {
      dotGit = undefined
    }
    if (dotGit?.isDirectory()) return x
    if (dotGit?.isFile()) return mainRepoTop(x)
    if (path.dirname(x) === x) return null
  }
}

// CC§9 CC§22
export function claudeProjectKey(dir: string): string {
  const real = realpathSafe(dir)
  return claudeTrustRepoTop(real) ?? real
}

// CC§9
export function claudeTrustsFolder(claudeJson: string, dir: string): boolean {
  const key = realpathSafe(dir)
  return isTrustedByClaude(
    () => JSON.parse(fs.readFileSync(claudeJson, 'utf8')),
    key,
    claudeTrustRepoTop(key)
  )
}

function jsonObjectIn(file: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(file)) return {}
  try {
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'))
    return doc && typeof doc === 'object' && !Array.isArray(doc) ? doc : undefined
  } catch {
    return undefined
  }
}

// CC§10
export function markClaudeOnboarded(claudeJson: string): void {
  const doc = jsonObjectIn(claudeJson)
  if (!doc || doc.hasCompletedOnboarding === true) return
  writePrivateAtomically(
    claudeJson,
    JSON.stringify({ ...doc, hasCompletedOnboarding: true }, null, 2)
  )
}

// CC§9 ADR-0026
export function acceptClaudeTrust(claudeJson: string, dir: string): void {
  const doc = jsonObjectIn(claudeJson)
  if (!doc) throw new Error(`${claudeJson} is not a JSON object`)
  const key = fs.realpathSync(dir)
  if (isTrustedByClaude(() => doc, key, claudeTrustRepoTop(key))) return
  const projects = (doc.projects ??= {}) as Record<string, object | undefined>
  projects[key] = { ...projects[key], hasTrustDialogAccepted: true }
  writePrivateAtomically(claudeJson, JSON.stringify(doc, null, 2))
}
