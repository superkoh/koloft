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
const SHARED_FOLDERS = [
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
const SHARED_FILES = [
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
const onboardingFile = (dir: string): string =>
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
  const onboarded = record(readJson(onboardingFile(home)))
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

// AGY§4
function writeAgyJson(file: string, value: Record<string, unknown>): void {
  const text = `${JSON.stringify(sortedDeep(value), null, 2)}\n`
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
  const own = readJson(settingsFile(home))
  const owners = readJson(settingsFile(ownersGemini))
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
  writeAgyJson(settingsFile(home), merged)
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
      const reset = typeof bucket.reset_time === 'string' ? Date.parse(bucket.reset_time) : NaN
      const label = [group.name, bucket.name].filter((n) => typeof n === 'string' && n).join(' · ')
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
  const command = record(readJson(settingsFile(ownersGemini)).title).command
  return typeof command === 'string' && command ? command : undefined
}

export const KOLOFT_HOOK_ENTRY = 'koloft'

// AGY§12
export function mergeAgyHooks(
  home: string,
  ownersGemini: string,
  koloft: Record<string, unknown>
): void {
  const owners = readJson(hooksFile(ownersGemini))
  delete owners[KOLOFT_HOOK_ENTRY]
  writeAgyJson(hooksFile(home), { ...owners, [KOLOFT_HOOK_ENTRY]: koloft })
}

// AGY§5
export function trustAgyFolder(home: string, dirs: string[]): void {
  const own = readJson(settingsFile(home))
  const list = Array.isArray(own.trustedWorkspaces)
    ? own.trustedWorkspaces.filter((p): p is string => typeof p === 'string')
    : []
  if (dirs.every((d) => list.includes(d))) return
  writeAgyJson(settingsFile(home), { ...own, trustedWorkspaces: [...new Set([...list, ...dirs])] })
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
        if (after && after !== before) writeWholeBeforeVisible(token, after)
      } catch {}
      fs.rm(dir, { recursive: true, force: true }, () => {})
    }
  }
}

export function agyTrustsFolder(home: string, dir: string): boolean {
  const list = readJson(settingsFile(home)).trustedWorkspaces
  return Array.isArray(list) && list.includes(dir)
}
