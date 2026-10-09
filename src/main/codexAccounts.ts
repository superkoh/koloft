import fs from 'fs'
import path from 'path'
import type { AccountView, CodexLimits, CodexLimitWindow } from '@shared/types'

const CODEX_HOMES = 'codex-homes'

function codexHomesRoot(userData: string): string {
  return path.join(userData, CODEX_HOMES)
}

export function codexHomeOf(userData: string, name: string): string {
  return path.join(codexHomesRoot(userData), name)
}

export function codexHomes(userData: string): string[] {
  try {
    return fs
      .readdirSync(codexHomesRoot(userData), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => path.join(codexHomesRoot(userData), e.name))
  } catch {
    return []
  }
}

const FOLDERS_EVERY_HOME_SHARES = ['sessions', 'archived_sessions']

function moveFilesNotAlreadyThere(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isDirectory()) moveFilesNotAlreadyThere(source, target)
    else if (!fs.existsSync(target)) fs.renameSync(source, target)
  }
}

function shareFolder(own: string, shared: string): void {
  fs.mkdirSync(shared, { recursive: true, mode: 0o700 })
  const existing = fs.lstatSync(own, { throwIfNoEntry: false })
  if (existing?.isSymbolicLink()) return
  if (existing) {
    moveFilesNotAlreadyThere(own, shared)
    fs.rmSync(own, { recursive: true, force: true })
  }
  fs.symlinkSync(shared, own)
}

// CODEX§15
export function prepareCodexHome(home: string, sharedConfig: string): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 })
  const sharedHome = path.dirname(sharedConfig)
  for (const folder of FOLDERS_EVERY_HOME_SHARES)
    shareFolder(path.join(home, folder), path.join(sharedHome, folder))
  const config = path.join(home, 'config.toml')
  try {
    fs.lstatSync(config)
    return
  } catch {}
  fs.mkdirSync(path.dirname(sharedConfig), { recursive: true, mode: 0o700 })
  fs.writeFileSync(sharedConfig, '', { flag: 'a', mode: 0o600 })
  fs.symlinkSync(sharedConfig, config)
}

function limitWindow(value: unknown): CodexLimitWindow | undefined {
  if (!value || typeof value !== 'object') return undefined
  const w = value as Record<string, unknown>
  if (typeof w.usedPercent !== 'number' || typeof w.windowDurationMins !== 'number')
    return undefined
  return {
    minutes: w.windowDurationMins,
    used: w.usedPercent / 100,
    resetsAt: typeof w.resetsAt === 'number' ? w.resetsAt : 0
  }
}

// CODEX§15
export function limitsFrom(reply: unknown, at: number): CodexLimits | undefined {
  const limits = (reply as { rateLimits?: Record<string, unknown> } | null)?.rateLimits
  if (!limits) return undefined
  const windows = [limitWindow(limits.primary), limitWindow(limits.secondary)].filter(
    (w): w is CodexLimitWindow => !!w
  )
  return { windows: windows.sort((a, b) => a.minutes - b.minutes), at }
}

function heaviest(limits: CodexLimits): number {
  return Math.max(0, ...limits.windows.map((w) => w.used))
}

export class CodexAccountPicker {
  private turn = 0

  pick(accounts: AccountView[]): AccountView | undefined {
    const pool = accounts.filter((a) => a.kind === 'codex-home' && a.enabled && a.status === 'ok')
    if (pool.length === 0) return undefined
    const measured = pool.filter((a) => a.limits && heaviest(a.limits) < 1)
    if (measured.length > 0)
      return measured.reduce((best, a) => (heaviest(a.limits!) < heaviest(best.limits!) ? a : best))
    return pool[this.turn++ % pool.length]
  }
}
