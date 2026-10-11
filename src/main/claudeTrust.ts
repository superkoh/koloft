import fs from 'fs'
import os from 'os'
import path from 'path'
import { realpathSafe } from './projectInfo'
import { writePrivateAtomically } from './privateFile'

export function claudeJsonPath(): string {
  return path.join(os.homedir(), '.claude.json')
}

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

// CC§9
export function claudeTrustsFolder(claudeJson: string, dir: string): boolean {
  return isTrustedByClaude(() => JSON.parse(fs.readFileSync(claudeJson, 'utf8')), realpathSafe(dir))
}

export function claudeSettingsPath(): string {
  return path.join(os.homedir(), '.claude', 'settings.json')
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

// CC§9
export function bypassWarningAccepted(claudeJson: string, claudeSettings: string): boolean {
  return (
    jsonObjectIn(claudeSettings)?.skipDangerousModePermissionPrompt === true ||
    jsonObjectIn(claudeJson)?.bypassPermissionsModeAccepted === true
  )
}

// CC§9
export function acceptBypassWarning(claudeSettings: string): boolean {
  const doc = jsonObjectIn(claudeSettings)
  if (!doc) return false
  fs.mkdirSync(path.dirname(claudeSettings), { recursive: true })
  writePrivateAtomically(
    claudeSettings,
    JSON.stringify({ ...doc, skipDangerousModePermissionPrompt: true }, null, 2)
  )
  return true
}

// CC§9 ADR-0026
export function acceptClaudeTrust(claudeJson: string, dir: string): void {
  const doc = JSON.parse(fs.readFileSync(claudeJson, 'utf8'))
  const key = fs.realpathSync(dir)
  if (isTrustedByClaude(() => doc, key)) return
  const projects = (doc.projects ??= {})
  projects[key] = { ...projects[key], hasTrustDialogAccepted: true }
  writePrivateAtomically(claudeJson, JSON.stringify(doc, null, 2))
}
