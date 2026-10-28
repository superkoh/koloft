import fs from 'fs'
import path from 'path'
import { RESUME_KEEPS_ACCOUNT_UP_TO, homeRoom, usableAccounts } from '@shared/accountUsage'
import type { AccountView, CodexLimits, CodexLimitWindow, SignInFolderKind } from '@shared/types'
import { joinProjectTables } from './codexTrust'
import {
  SCORE_PER_LIVE_SESSION,
  liveSessionsPerAccount,
  type LaunchedSession
} from './accountPicker'
import { EPS } from './usageProbe'

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

const FOLDERS_EVERY_HOME_SHARES = ['sessions', 'archived_sessions', 'skills', 'rules']
const OWNER_FILES_EVERY_HOME_READS = ['AGENTS.md']
const SPLIT_CONFIG_KEPT_AS = 'config.toml.before-shared'

function newerThan(a: string, b: string): boolean {
  const there = fs.statSync(b, { throwIfNoEntry: false })
  return !there || fs.statSync(a).mtimeMs > there.mtimeMs
}

function moveFilesKeepingTheNewer(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name)
    const target = path.join(to, entry.name)
    if (entry.isDirectory()) moveFilesKeepingTheNewer(source, target)
    else if (newerThan(source, target)) fs.renameSync(source, target)
  }
}

function shareFolder(own: string, shared: string): void {
  fs.mkdirSync(shared, { recursive: true, mode: 0o700 })
  const existing = fs.lstatSync(own, { throwIfNoEntry: false })
  if (existing?.isSymbolicLink()) return
  if (existing) {
    moveFilesKeepingTheNewer(own, shared)
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
  for (const file of OWNER_FILES_EVERY_HOME_READS) {
    const theirs = path.join(sharedHome, file)
    const own = path.join(home, file)
    if (fs.existsSync(theirs) && !fs.lstatSync(own, { throwIfNoEntry: false }))
      fs.symlinkSync(theirs, own)
  }
  const config = path.join(home, 'config.toml')
  const existing = fs.lstatSync(config, { throwIfNoEntry: false })
  if (existing?.isSymbolicLink()) return
  if (existing) {
    joinProjectTables(sharedConfig, fs.readFileSync(config, 'utf8'))
    fs.renameSync(config, path.join(home, SPLIT_CONFIG_KEPT_AS))
  }
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
  const r = reply as {
    rateLimits?: Record<string, unknown>
    rateLimitResetCredits?: unknown
  } | null
  const limits = r?.rateLimits
  if (!limits) return undefined
  const windows = [limitWindow(limits.primary), limitWindow(limits.secondary)].filter(
    (w): w is CodexLimitWindow => !!w
  )
  const credits = creditsFrom(limits.credits)
  const resets = resetsFrom(r.rateLimitResetCredits)
  return {
    windows: windows.sort((a, b) => a.minutes - b.minutes),
    at,
    ...(limits.rateLimitReachedType != null && { reached: true }),
    ...(credits && { credits }),
    ...(resets && { resets })
  }
}

function creditsFrom(value: unknown): CodexLimits['credits'] {
  if (!value || typeof value !== 'object') return undefined
  const c = value as Record<string, unknown>
  const balance = typeof c.balance === 'string' ? Number(c.balance) : NaN
  if (c.unlimited === true) return { unlimited: true }
  return Number.isFinite(balance) ? { unlimited: false, balance } : undefined
}

function resetsFrom(value: unknown): CodexLimits['resets'] {
  if (!value || typeof value !== 'object') return undefined
  const s = value as { availableCount?: unknown; credits?: unknown }
  if (typeof s.availableCount !== 'number') return undefined
  const expiries = (Array.isArray(s.credits) ? s.credits : [])
    .filter((c) => c?.status === 'available' && typeof c.expiresAt === 'number')
    .map((c) => c.expiresAt as number)
  return {
    available: s.availableCount,
    ...(expiries.length > 0 && { firstExpiresAt: Math.min(...expiries) })
  }
}

export class HomeAccountPicker {
  private turn = 0

  constructor(private kind: SignInFolderKind) {}

  pick(
    accounts: AccountView[],
    resumedOn?: string,
    launched: LaunchedSession[] = []
  ): AccountView | undefined {
    const pool = usableAccounts(accounts, [this.kind])
    if (pool.length === 0) return undefined
    const nowSec = Math.floor(Date.now() / 1000)
    const rooms = pool.map((a) => ({ a, room: homeRoom(a, nowSec) }))
    const same = rooms.find(({ a }) => a.name === resumedOn)
    if (same && (!same.room || (!same.room.walled && same.room.used <= RESUME_KEEPS_ACCOUNT_UP_TO)))
      return same.a
    const live = liveSessionsPerAccount(launched, undefined)
    const open = rooms.filter(({ room }) => room && !room.walled)
    const ranked = (open.length > 0 ? open : rooms.filter(({ room }) => !room)).map(
      ({ a, room }) => ({
        a,
        score: (room?.used ?? 0) + (live.get(a.name.toLowerCase()) ?? 0) * SCORE_PER_LIVE_SESSION
      })
    )
    if (ranked.length > 0) {
      const least = Math.min(...ranked.map((r) => r.score))
      const finalists = ranked.filter((r) => r.score <= least + EPS)
      return finalists[finalists.length > 1 ? this.turn++ % finalists.length : 0].a
    }
    const backAt = ({ room }: (typeof rooms)[number]): number => room?.backAt || Infinity
    return rooms.reduce((best, r) => (backAt(r) < backAt(best) ? r : best)).a
  }

  peek(accounts: AccountView[]): AccountView | undefined {
    const turn = this.turn
    const picked = this.pick(accounts)
    this.turn = turn
    return picked
  }
}
