import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import type { QuotaBucket } from '@shared/types'
import { record } from './codexObservation'
import { readJson } from './museAccounts'
import { writeWholeBeforeVisible } from './jsonDrops'
import { AGY_APP_DIR } from './agyStore'

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
}

const KOLOFT_KEYS = ['title', 'statusLine', 'modelProvider'] as const

// AGY§4 AGY§5 AGY§11
export function mergeAgySettings(home: string, ownersGemini: string, k: KoloftSettings): void {
  writeAgyJson(
    settingsFile(home),
    mergedAgySettings(readJson(settingsFile(home)), readJson(settingsFile(ownersGemini)), k)
  )
}

// AGY§4 AGY§5 AGY§11
export function mergedAgySettings(
  own: Record<string, unknown>,
  owners: Record<string, unknown>,
  k: KoloftSettings
): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...own, ...owners }
  for (const key of KOLOFT_KEYS) delete merged[key]
  const trusted = [own.trustedWorkspaces, owners.trustedWorkspaces].flatMap((list) =>
    Array.isArray(list) ? list.filter((p): p is string => typeof p === 'string') : []
  )
  merged.trustedWorkspaces = [...new Set([...trusted, ...k.trust])]
  merged.title = { type: 'command', command: k.titleCommand }
  if (k.statusLine)
    merged.statusLine = { type: 'command', command: k.statusLine, stack_with_default: true }
  else if (owners.statusLine) merged.statusLine = owners.statusLine
  if (k.apiKey) merged.modelProvider = 'gemini'
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

// AGY§23
const WINDOW_LABEL: Record<string, string> = { weekly: '7d', '5h': '5h' }

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
      const window = typeof bucket.window === 'string' ? WINDOW_LABEL[bucket.window] : undefined
      const label = [group.name, window ?? bucket.name]
        .filter((n) => typeof n === 'string' && n)
        .join(' · ')
      return [
        {
          label: label || 'Quota',
          used: Math.max(0, Math.min(1, 1 - left)),
          ...(Number.isFinite(reset) ? { resetsAt: reset } : {})
        }
      ]
    })
  })
}

// AGY§6
export function setAgyApiKeyRoute(home: string, on: boolean): void {
  const own = readJson(settingsFile(home))
  if (on === (own.modelProvider === 'gemini')) return
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
  fs.mkdirSync(path.dirname(copy), { recursive: true, mode: 0o700 })
  let before: string | undefined
  if (!apiKey && fs.existsSync(token)) {
    before = fs.readFileSync(token, 'utf8')
    fs.writeFileSync(copy, before, { mode: 0o600 })
  }
  if (apiKey) writeAgyJson(settingsFile(dir), { modelProvider: 'gemini' })
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

export function agyTrustsFolder(home: string, dir: string): boolean {
  const list = readJson(settingsFile(home)).trustedWorkspaces
  return Array.isArray(list) && list.includes(dir)
}
