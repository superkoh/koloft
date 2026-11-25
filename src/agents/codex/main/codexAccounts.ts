import fs from 'fs'
import path from 'path'
import { AUTO_PROBE_MS, launchLine } from '@shared/accountUsage'
import type {
  AccountKind,
  AccountView,
  CodexLimits,
  CodexLimitWindow,
  CodexResetOutcome
} from '@shared/types'
import { HomeAccountPicker } from '../../kit/main/homeAccountPicker'
import {
  addHomeKey,
  answerOfTerminalPick,
  terminalPickOf,
  type HomeAccountsDeps
} from '../../kit/main/homeAccounts'
import { readJson } from '../../../main/jsonDrops'
import { joinProjectTables } from './codexTrust'
import type { CodexSessions } from './codexSessions'

const CODEX_HOMES = 'codex-homes'

function codexHomesRoot(userData: string): string {
  return path.join(userData, CODEX_HOMES)
}

export function codexHomeOf(userData: string, name: string): string {
  return path.join(codexHomesRoot(userData), name)
}

// CODEX§15
export const codexKeyOnDisk = (userData: string, name: string): boolean =>
  readJson(path.join(codexHomeOf(userData, name), 'auth.json')).auth_mode === 'apikey'

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

const FOLDERS_EVERY_HOME_SHARES = [
  'sessions',
  'archived_sessions',
  'skills',
  'rules',
  'generated_images'
]
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

export interface CodexHomeAccountsDeps extends HomeAccountsDeps {
  codexSharedConfig(): string
  codexSessions(): CodexSessions | null
}

export function codexHomeAccounts(deps: CodexHomeAccountsDeps) {
  const {
    app,
    accountViews,
    allLimitedNotice,
    codexSharedConfig,
    findAccount,
    foldHomeSignIn,
    listAccounts,
    pushHomeAccount,
    savedHomeUsageOf,
    usageViews,
    viewKey
  } = deps
  const codexPicker = new HomeAccountPicker('codex-home', savedHomeUsageOf)

  // CODEX§15
  function pickCodexHome(
    resumeSessionId?: string
  ): { account: string; home: string; banner: string; notice?: string } | undefined {
    const codexSessions = deps.codexSessions()
    const sessionAccounts = deps.sessionAccounts()
    const views = accountViews()
    const picked = codexPicker.pick(
      views,
      sessionAccounts?.of('codex', resumeSessionId),
      codexSessions?.launchedSessions()
    )
    if (!picked) return undefined
    const stale = (a: AccountView): boolean =>
      a.apiKey ? !!a.probeError : !a.limits || Date.now() - a.limits.at > AUTO_PROBE_MS
    if (views.some((a) => a.kind === 'codex-home' && a.enabled && stale(a)))
      void probeCodexAccounts()
    const home = codexHomeOf(app.getPath('userData'), picked.name)
    prepareCodexHome(home, codexSharedConfig())
    return {
      account: picked.name,
      home,
      banner: launchLine(picked, Date.now()),
      notice: allLimitedNotice(picked, 'codex')
    }
  }

  async function probeCodexAccount(name: string): Promise<void> {
    const codexSessions = deps.codexSessions()
    const acct = findAccount(name, 'codex-home')
    if (!acct || !codexSessions) return
    const key = viewKey(name, 'codex-home')
    try {
      const r = await codexSessions.readAccount(codexHomeOf(app.getPath('userData'), name))
      foldHomeSignIn(name, 'codex-home', r.signedIn)
      usageViews.set(
        key,
        r.apiKey
          ? { apiKey: true }
          : {
              limits:
                (r.signedIn && limitsFrom(r.limits, Date.now())) || usageViews.get(key)?.limits
            }
      )
    } catch {
      usageViews.set(key, { ...usageViews.get(key), probeError: 'network' })
    }
    pushHomeAccount(name, 'codex-home')
  }

  async function codexUseReset(name: string): Promise<CodexResetOutcome> {
    const codexSessions = deps.codexSessions()
    if (!findAccount(name, 'codex-home') || !codexSessions) return 'failed'
    const outcome = await codexSessions
      .useResetCredit(codexHomeOf(app.getPath('userData'), name))
      .catch((): CodexResetOutcome => 'failed')
    await probeCodexAccount(name)
    return outcome
  }

  let codexProbeRound: Promise<void> | null = null

  function probeCodexAccounts(): Promise<void> {
    codexProbeRound ??= Promise.all(
      listAccounts()
        .filter((a) => a.kind === 'codex-home' && a.enabled)
        .map((a) =>
          probeCodexAccount(a.name).catch((err) =>
            console.error(`[koloft] could not probe the Codex account ${a.name}:`, err)
          )
        )
    ).then(() => {
      codexProbeRound = null
    })
    return codexProbeRound
  }

  async function probeHomeAccount(name: string): Promise<void> {
    const codexSessions = deps.codexSessions()
    await codexSessions?.rereadSignIn(codexHomeOf(app.getPath('userData'), name))
    await probeCodexAccount(name)
  }

  // CODEX§15
  async function storeHomeKey(name: string, key: string): Promise<void> {
    const codexSessions = deps.codexSessions()
    if (!codexSessions) throw new Error('Codex is not set up.')
    const home = codexHomeOf(app.getPath('userData'), name)
    prepareCodexHome(home, codexSharedConfig())
    await codexSessions.storeApiKey(home, key)
  }

  return {
    codexPicker,
    pickCodexHome,
    codexUseReset,
    probeCodexAccounts,
    // CODEX§15
    homeLogin: async (name: string) => {
      const codexSessions = deps.codexSessions()
      const available = (await codexSessions?.availability())?.available
      const home = codexHomeOf(app.getPath('userData'), name)
      prepareCodexHome(home, codexSharedConfig())
      return { binary: available ? codexSessions?.cliBinary : undefined, env: { CODEX_HOME: home } }
    },
    probeHomeAccount,
    pickForThisStart: () => answerOfTerminalPick('codex', () => terminalPickOf(pickCodexHome())),
    addSecret: (_kind: AccountKind, name: string, secret: string) =>
      addHomeKey('codex-home', name, secret, { storeHomeKey, probeHomeAccount }, deps),
    folderSaysItRunsOnAKey: (_kind: AccountKind, name: string) =>
      codexKeyOnDisk(app.getPath('userData'), name)
  }
}
