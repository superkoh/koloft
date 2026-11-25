import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import type { AccountKind, AccountView, QuotaBucket } from '@shared/types'
import type { AgentAccounts } from '@core/agent/agentsMain'
import {
  AUTO_PROBE_MS,
  FIVE_HOUR_MINUTES,
  WEEK_MINUTES,
  launchLine,
  windowLabel
} from '@shared/accountUsage'
import { HomeAccountPicker } from '../../kit/main/homeAccountPicker'
import {
  addHomeKey,
  answerOfTerminalPick,
  terminalPickOf,
  type HomeAccountsDeps
} from '../../kit/main/homeAccounts'
import type { AgyHomePick, AgySessions } from './agySessions'
import { agyListedModels, type ListedModel } from '@shared/sessionPicks'
import { record } from '@core/unknownValue'
import { readJson, writeWholeBeforeVisible } from '../../../main/jsonDrops'
import { AGY_APP_DIR } from './agyStore'
import { runsPlaywrightMcp } from '../../../main/browserControlEnv'

const AGY_HOMES = 'agy-homes'

export function agyHomeOf(userData: string, name: string): string {
  return path.join(userData, AGY_HOMES, name)
}

// AGY§7
export const AGY_FILE_CREDENTIALS: Record<string, string> = { WSL_INTEROP: 'koloft' }

export function agyAccountEnv(apiKey?: string): Record<string, string> {
  return { ...AGY_FILE_CREDENTIALS, ...(apiKey ? { GEMINI_API_KEY: apiKey } : {}) }
}

// AGY§4
export const SHARED_FOLDERS = [
  `${AGY_APP_DIR}/conversations`,
  `${AGY_APP_DIR}/brain`,
  `${AGY_APP_DIR}/annotations`,
  `${AGY_APP_DIR}/presence`,
  'config/projects',
  'config/rules',
  'config/plugins',
  'antigravity'
]

// AGY§4
export const SHARED_FILES = [
  `${AGY_APP_DIR}/conversation_summaries.db`,
  'config/GEMINI.md',
  'config/AGENTS.md',
  'config/config.json',
  'config/mcp_config.json',
  'GEMINI.md'
]

const settingsFile = (dir: string): string => path.join(dir, AGY_APP_DIR, 'settings.json')
const hooksFile = (dir: string): string => path.join(dir, 'config', 'hooks.json')
export const agyTokenFile = (dir: string): string =>
  path.join(dir, AGY_APP_DIR, 'antigravity-oauth-token')
export const agyOnboardingFile = (dir: string): string =>
  path.join(dir, AGY_APP_DIR, 'cache', 'onboarding.json')

function linkTo(own: string, owners: string): void {
  const there = fs.lstatSync(own, { throwIfNoEntry: false })
  if (there?.isSymbolicLink() && fs.readlinkSync(own) === owners) return
  if (there) fs.rmSync(own, { recursive: true, force: true })
  fs.mkdirSync(path.dirname(own), { recursive: true, mode: 0o700 })
  fs.symlinkSync(owners, own)
}

// AGY§4
export function prepareAgyHome(home: string, ownersGemini: string): void {
  for (const dir of [AGY_APP_DIR, 'config'])
    fs.mkdirSync(path.join(home, dir), { recursive: true, mode: 0o700 })
  for (const folder of SHARED_FOLDERS) {
    const owners = path.join(ownersGemini, folder)
    fs.mkdirSync(owners, { recursive: true, mode: 0o700 })
    linkTo(path.join(home, folder), owners)
  }
  for (const file of SHARED_FILES) linkTo(path.join(home, file), path.join(ownersGemini, file))
}

// AGY§5 AGY§6
export function agySignedIn(home: string, apiKey: boolean): boolean {
  const onboarded = readJson(agyOnboardingFile(home))
  const done =
    onboarded.onboardingComplete === true || onboarded.consumerOnboardingComplete === true
  return done && (apiKey || fs.existsSync(agyTokenFile(home)))
}

const sortedDeep = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sortedDeep)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, sortedDeep((value as Record<string, unknown>)[k])])
        )
      : value

export function agyJsonText(value: Record<string, unknown>): string {
  return `${JSON.stringify(sortedDeep(value), null, 2)}\n`
}

// AGY§4
function writeAgyJson(file: string, value: Record<string, unknown>): void {
  const text = agyJsonText(value)
  try {
    if (fs.readFileSync(file, 'utf8') === text) return
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  writeWholeBeforeVisible(file, text)
  fs.chmodSync(file, 0o600)
}

export interface KoloftSettings {
  trust: string[]
  titleCommand: string
  statusLine?: string
  apiKey: boolean
  allowKoloft: boolean
  playwrightServers: string[]
  workbenchBrowser: boolean
}

const KOLOFT_KEYS = ['title', 'statusLine', 'modelProvider'] as const

// AGY§26
const AGY_KOLOFT_ALLOW_RULE = 'command(koloft)'

const strings = (list: unknown): string[] =>
  Array.isArray(list) ? list.filter((s): s is string => typeof s === 'string') : []

// ADR-0048 AGY§26
const allowEveryToolOf = (server: string): string => `mcp(${server}/*)`
const namesServer = (rule: string, server: string): boolean =>
  rule === `mcp(${server})` || rule.startsWith(`mcp(${server}/`)

// AGY§30
export function ownersPlaywrightMcp(ownersGemini: string): string[] {
  const servers = record(readJson(path.join(ownersGemini, 'config', 'mcp_config.json')).mcpServers)
  return Object.keys(servers).filter((name) => {
    const entry = record(servers[name])
    return entry.disabled !== true && runsPlaywrightMcp(entry.command, entry.args)
  })
}

// AGY§27
const NO_FLICKERING_RENDERING = { altScreenMode: 'always' }

// AGY§4 AGY§5 AGY§11
export function mergeAgySettings(home: string, ownersGemini: string, k: KoloftSettings): void {
  writeAgyJson(
    settingsFile(home),
    mergedAgySettings(readJson(settingsFile(home)), readJson(settingsFile(ownersGemini)), k)
  )
}

// AGY§4 AGY§5 AGY§11 AGY§26 AGY§27 ADR-0048
export function mergedAgySettings(
  own: Record<string, unknown>,
  owners: Record<string, unknown>,
  k: KoloftSettings
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...NO_FLICKERING_RENDERING, ...own, ...owners }
  for (const key of KOLOFT_KEYS) delete merged[key]
  merged.trustedWorkspaces = [
    ...new Set([
      ...strings(own.trustedWorkspaces),
      ...strings(owners.trustedWorkspaces),
      ...k.trust
    ])
  ]
  merged.title = { type: 'command', command: k.titleCommand }
  if (k.statusLine)
    merged.statusLine = { type: 'command', command: k.statusLine, stack_with_default: true }
  else if (owners.statusLine) merged.statusLine = owners.statusLine
  if (k.apiKey) merged.modelProvider = 'gemini'
  const permissions = { ...record(merged.permissions) }
  const ownerSetsPermissions = 'permissions' in owners
  const koloftWholeServer = k.playwrightServers.map(allowEveryToolOf)
  const allow = strings(permissions.allow).filter(
    (r) => ownerSetsPermissions || (r !== AGY_KOLOFT_ALLOW_RULE && !koloftWholeServer.includes(r))
  )
  const usersRules = Object.entries(permissions)
    .filter(([list]) => ownerSetsPermissions || list !== 'allow')
    .flatMap(([, rules]) => strings(rules))
  const ours = [
    ...(k.allowKoloft ? [AGY_KOLOFT_ALLOW_RULE] : []),
    ...(k.workbenchBrowser ? k.playwrightServers : [])
      .filter((s) => !usersRules.some((r) => namesServer(r, s)))
      .map(allowEveryToolOf)
  ]
  for (const rule of ours) if (!allow.includes(rule)) allow.push(rule)
  if (allow.length) permissions.allow = allow
  else delete permissions.allow
  if (Object.keys(permissions).length) merged.permissions = permissions
  else delete merged.permissions
  return merged
}

const AGY_USAGE_TIMEOUT_MS = 20_000

// AGY§20 AGY§23
export function readAgyQuota(
  binary: string,
  env: NodeJS.ProcessEnv,
  home: string
): Promise<QuotaBucket[] | undefined> {
  return new Promise((resolve) => {
    execFile(
      binary,
      [`--gemini_dir=${home}`, '-p', '/usage', '--output-format', 'json'],
      { env, cwd: os.homedir(), timeout: AGY_USAGE_TIMEOUT_MS },
      (error, stdout) => resolve(error ? undefined : agyQuotaFrom(stdout))
    ).stdin?.end()
  })
}

// AGY§21
export function readAgyModels(
  binary: string,
  env: NodeJS.ProcessEnv,
  signedInArgs: string[]
): Promise<ListedModel[] | undefined> {
  return new Promise((resolve) => {
    execFile(
      binary,
      [...signedInArgs, 'models'],
      { env, cwd: os.homedir(), timeout: AGY_USAGE_TIMEOUT_MS },
      (error, stdout) => resolve(error ? undefined : agyListedModels(stdout))
    ).stdin?.end()
  })
}

// AGY§23
const WINDOW_MINUTES: Record<string, number> = { weekly: WEEK_MINUTES, '5h': FIVE_HOUR_MINUTES }

// AGY§20 AGY§23
export function agyQuotaFrom(stdout: string): QuotaBucket[] | undefined {
  let groups: unknown
  try {
    groups = record(record(record(JSON.parse(stdout)).command).data).groups
  } catch {
    return undefined
  }
  if (!Array.isArray(groups)) return undefined
  return groups.flatMap((g) => {
    const group = record(g)
    const buckets = Array.isArray(group.buckets) ? group.buckets : []
    return buckets.flatMap((b) => {
      const bucket = record(b)
      const left = bucket.remaining_fraction
      if (typeof left !== 'number') return []
      const reset =
        typeof bucket.reset_time === 'string'
          ? Math.floor(Date.parse(bucket.reset_time) / 1000)
          : NaN
      const minutes = typeof bucket.window === 'string' ? WINDOW_MINUTES[bucket.window] : undefined
      const label = [group.name, minutes ? windowLabel(minutes) : bucket.name]
        .filter((n) => typeof n === 'string' && n)
        .join(' · ')
      return [
        {
          label: label || 'Quota',
          used: Math.max(0, Math.min(1, 1 - left)),
          ...(Number.isFinite(reset) ? { resetsAt: reset } : {}),
          ...(minutes ? { minutes } : {})
        }
      ]
    })
  })
}

// AGY§6
export function agyApiKeyRoute(home: string): boolean {
  return readJson(settingsFile(home)).modelProvider === 'gemini'
}

// AGY§6
export const agyKeyOnDisk = (userData: string, name: string): boolean =>
  agyApiKeyRoute(agyHomeOf(userData, name))

// AGY§6
export function setAgyApiKeyRoute(home: string, on: boolean): void {
  if (on === agyApiKeyRoute(home)) return
  const own = readJson(settingsFile(home))
  if (on) own.modelProvider = 'gemini'
  else delete own.modelProvider
  writeAgyJson(settingsFile(home), own)
}

export function ownersTitleCommand(ownersGemini: string): string | undefined {
  return titleCommandIn(readJson(settingsFile(ownersGemini)))
}

export function titleCommandIn(settings: Record<string, unknown>): string | undefined {
  const command = record(settings.title).command
  return typeof command === 'string' && command ? command : undefined
}

export const KOLOFT_HOOK_ENTRY = 'koloft'

// AGY§12
export function mergeAgyHooks(
  home: string,
  ownersGemini: string,
  koloft: Record<string, unknown>
): void {
  writeAgyJson(hooksFile(home), mergedAgyHooks(readJson(hooksFile(ownersGemini)), koloft))
}

// AGY§12
export function mergedAgyHooks(
  owners: Record<string, unknown>,
  koloft: Record<string, unknown>
): Record<string, unknown> {
  const rest = { ...owners }
  delete rest[KOLOFT_HOOK_ENTRY]
  return { ...rest, [KOLOFT_HOOK_ENTRY]: koloft }
}

// AGY§6 AGY§8 AGY§20
export function oneShotAgyHome(
  home: string,
  tmpRoot: string,
  apiKey: boolean
): { dir: string; done(): void } {
  fs.mkdirSync(tmpRoot, { recursive: true, mode: 0o700 })
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'agy-'))
  const token = agyTokenFile(home)
  const copy = agyTokenFile(dir)
  let before: string | undefined
  try {
    fs.mkdirSync(path.dirname(copy), { recursive: true, mode: 0o700 })
    if (!apiKey && fs.existsSync(token)) {
      before = fs.readFileSync(token, 'utf8')
      fs.writeFileSync(copy, before, { mode: 0o600 })
    }
    if (apiKey) writeAgyJson(settingsFile(dir), { modelProvider: 'gemini' })
  } catch (err) {
    endAgyOneShots(dir)
    throw err
  }
  return {
    dir,
    done: () => {
      try {
        const after = before !== undefined ? fs.readFileSync(copy, 'utf8') : undefined
        if (after && after !== before) {
          writeWholeBeforeVisible(token, after)
          fs.chmodSync(token, 0o600)
        }
      } catch {}
      fs.rm(dir, { recursive: true, force: true }, () => {})
    }
  }
}

// AGY§6
export function endAgyOneShots(tmpRoot: string): void {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  } catch (err) {
    console.error('[koloft] could not remove the Antigravity one-shot folders:', err)
  }
}

export function trustsIn(dir: string, ...settings: Record<string, unknown>[]): boolean {
  return settings.some(
    (s) => Array.isArray(s.trustedWorkspaces) && s.trustedWorkspaces.includes(dir)
  )
}

export function agyTrustsFolder(home: string, dir: string): boolean {
  return trustsIn(dir, readJson(settingsFile(home)))
}

// ADR-0026 AGY§5
export function anyAccountHomeTrusts(home: string, dir: string): boolean {
  const homes = path.dirname(home)
  return fs.readdirSync(homes).some((name) => agyTrustsFolder(path.join(homes, name), dir))
}

export interface AgyHomeAccountsDeps extends HomeAccountsDeps {
  keychainRead(kind: AccountKind, name: string): Promise<string | null>
  keychainWrite(kind: AccountKind, name: string, secret: string): Promise<boolean>
  ownersGemini(): string
  agySessions(): AgySessions | null
}

export function agyHomeAccounts(deps: AgyHomeAccountsDeps) {
  const {
    app,
    accountViews,
    allLimitedNotice,
    findAccount,
    foldHomeSignIn,
    keychainRead,
    keychainWrite,
    listAccounts,
    ownersGemini,
    pushHomeAccount,
    savedHomeUsageOf,
    usageViews,
    viewKey
  } = deps
  const agyPicker = new HomeAccountPicker('agy-home', savedHomeUsageOf)
  const agyProbedAt = new Map<string, number>()
  const preparedAgyHomes = new Set<string>()

  // AGY§4
  function agyHomeFor(name: string): string {
    const home = agyHomeOf(app.getPath('userData'), name)
    if (preparedAgyHomes.has(home)) return home
    prepareAgyHome(home, ownersGemini())
    preparedAgyHomes.add(home)
    return home
  }

  async function agyApiKeyOf(name: string): Promise<string | undefined> {
    return (await keychainRead('agy-home', name)) ?? undefined
  }

  // ADR-0030
  function pickAgyHome(resumeSessionId?: string, onlyAsking?: boolean): AgyHomePick | undefined {
    const agySessions = deps.agySessions()
    const sessionAccounts = deps.sessionAccounts()
    const views = accountViews()
    const picked = onlyAsking
      ? agyPicker.peek(views)
      : agyPicker.pick(
          views,
          sessionAccounts?.of('agy', resumeSessionId),
          agySessions?.launchedSessions()
        )
    const stale = (a: AccountView): boolean =>
      Date.now() - (agyProbedAt.get(a.name) ?? 0) > AUTO_PROBE_MS
    if (!onlyAsking && views.some((a) => a.kind === 'agy-home' && a.enabled && stale(a)))
      void probeAgyAccounts()
    return (
      picked && {
        account: picked.name,
        home: agyHomeFor(picked.name),
        banner: launchLine(picked, Date.now()),
        notice: allLimitedNotice(picked, 'agy')
      }
    )
  }

  // AGY§5 AGY§6
  async function probeAgyAccount(name: string): Promise<void> {
    const acct = findAccount(name, 'agy-home')
    if (!acct) return
    agyProbedAt.set(name, Date.now())
    const home = agyHomeFor(name)
    const apiKey = await agyApiKeyOf(name)
    const signedIn = agySignedIn(home, !!apiKey)
    foldHomeSignIn(name, 'agy-home', signedIn)
    const key = viewKey(name, 'agy-home')
    if (apiKey) usageViews.set(key, { apiKey: true })
    else if (signedIn) {
      const quota = await agyUsage(home)
      usageViews.set(
        key,
        quota ? { quota, quotaAt: Date.now() } : { ...usageViews.get(key), probeError: 'network' }
      )
    }
    pushHomeAccount(name, 'agy-home')
  }

  async function agyBinary(): Promise<string | undefined> {
    const agySessions = deps.agySessions()
    return ((await agySessions?.availability())?.available && agySessions?.cliBinary) || undefined
  }

  async function agyUsage(home: string): Promise<QuotaBucket[] | undefined> {
    const agySessions = deps.agySessions()
    const binary = await agyBinary()
    if (!binary) return undefined
    return readAgyQuota(binary, { ...agySessions?.defaultEnv, ...agyAccountEnv() }, home)
  }

  let agyProbeRound: Promise<void> | null = null

  function probeAgyAccounts(): Promise<void> {
    agyProbeRound ??= Promise.all(
      listAccounts()
        .filter((a) => a.kind === 'agy-home' && a.enabled)
        .map((a) =>
          probeAgyAccount(a.name).catch((err) =>
            console.error(`[koloft] could not probe the Antigravity account ${a.name}:`, err)
          )
        )
    ).then(() => {
      agyProbeRound = null
    })
    return agyProbeRound
  }

  const probeHomeAccount = (name: string): Promise<void> => probeAgyAccount(name)

  // AGY§6
  async function storeHomeKey(name: string, key: string): Promise<void> {
    if (!(await keychainWrite('agy-home', name, key))) throw new Error('Keychain write failed.')
    setAgyApiKeyRoute(agyHomeFor(name), true)
  }

  return {
    agyPicker,
    agyHomeFor,
    agyApiKeyOf,
    pickAgyHome,
    agyBinary,
    probeAgyAccounts,
    // AGY§5 AGY§7
    homeLogin: async (name: string) => {
      const binary = await agyBinary()
      const home = agyHomeFor(name)
      const apiKey = await agyApiKeyOf(name)
      setAgyApiKeyRoute(home, !!apiKey)
      return { binary, env: agyAccountEnv(apiKey), args: [`--gemini_dir=${home}`] }
    },
    probeHomeAccount,
    accounts: {
      pickForThisStart: () =>
        answerOfTerminalPick('agy', () => {
          const picked = terminalPickOf(pickAgyHome())
          return picked && (agyApiKeyRoute(picked.home) ? { ...picked, kind: 'apikey' } : picked)
        }),
      probeAll: probeAgyAccounts,
      addSecret: (_kind, name, secret) =>
        addHomeKey('agy-home', name, secret, { storeHomeKey, probeHomeAccount }, deps),
      forget: () => {},
      folderSaysItRunsOnAKey: (_kind, name) => agyKeyOnDisk(app.getPath('userData'), name)
    } satisfies AgentAccounts
  }
}
