import fs from 'fs'
import path from 'path'
import { isDeepStrictEqual } from 'util'
import { record } from './codexObservation'
import { writeWholeBeforeVisible } from './jsonDrops'
import { KOLOFT_SKILL, keepKoloftSkillIn } from './agentPlugin'
import { playwrightMcpEnv, runsPlaywrightMcp } from './browserControlEnv'

const MUSE_HOMES = 'muse-homes'

// MUSE§13
const MUSE_FILE_CREDENTIALS = { TBH_CREDENTIAL_BACKEND: 'file' }

export function museHomeOf(userData: string, name: string): string {
  return path.join(userData, MUSE_HOMES, name)
}

// MUSE§21
export const MUSE_PASSES_TO_PLAYWRIGHT = Object.keys(playwrightMcpEnv(''))
const SET_THOUGH_THERE_IS_NO_WORKBENCH_BROWSER = Object.fromEntries(
  MUSE_PASSES_TO_PLAYWRIGHT.map((key) => [key, ''])
)

// MUSE§2 MUSE§13 MUSE§21
export function museAccountEnv(home: string): Record<string, string> {
  return {
    XDG_CONFIG_HOME: home,
    ...MUSE_FILE_CREDENTIALS,
    ...SET_THOUGH_THERE_IS_NO_WORKBENCH_BROWSER
  }
}

const SHARED_WITH_THE_OWNER = ['trust.json', 'AGENTS.md']
// MUSE§13
export const MUSE_STOPS_WHEN_THIS_LINK_DANGLES = 'AGENTS.md'

export function readJson(file: string): Record<string, unknown> {
  try {
    return record(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return {}
  }
}

// MUSE§10
function keepTrustOf(own: string, owners: string): void {
  const mine = readJson(own)
  const theirs = readJson(owners)
  const projects = { ...record(mine.projects), ...record(theirs.projects) }
  fs.mkdirSync(path.dirname(owners), { recursive: true })
  writeWholeBeforeVisible(
    owners,
    JSON.stringify({ schema_version: 1, ...theirs, projects }, null, 2)
  )
}

function linkBack(own: string, owners: string): void {
  const there = fs.lstatSync(own, { throwIfNoEntry: false })
  const mustExist = path.basename(own) === MUSE_STOPS_WHEN_THIS_LINK_DANGLES
  if (there?.isSymbolicLink()) {
    if (mustExist && !fs.existsSync(owners)) fs.unlinkSync(own)
    return
  }
  if (there) {
    if (path.basename(own) === 'trust.json') keepTrustOf(own, owners)
    else if (!fs.existsSync(owners)) {
      fs.mkdirSync(path.dirname(owners), { recursive: true })
      fs.renameSync(own, owners)
    }
    fs.rmSync(own, { force: true })
  }
  if (!mustExist || fs.existsSync(owners)) fs.symlinkSync(owners, own)
}

// MUSE§16
function linkOwnersSkills(own: string, owners: string): void {
  fs.mkdirSync(own, { recursive: true })
  let skills: string[] = []
  try {
    skills = fs.readdirSync(owners)
  } catch {}
  for (const skill of skills) {
    const mine = path.join(own, skill)
    if (skill === KOLOFT_SKILL || fs.lstatSync(mine, { throwIfNoEntry: false })) continue
    fs.symlinkSync(path.join(owners, skill), mine)
  }
}

// MUSE§16
export function placeKoloftSkill(home: string, on: boolean): void {
  keepKoloftSkillIn(path.join(home, 'muse', 'skills'), on)
}

// MUSE§13
const MUSE_SETTINGS_VERSION = { schema_version: 1 }
// MUSE§21
const MUSE_APPROVAL_POLICY_VERSION = { schema_version: 2 }

// MUSE§21
const PLAYWRIGHT_TOOLS_MUSE_ASKS_BEFORE = [
  'browser_click',
  'browser_close',
  'browser_drag',
  'browser_drop',
  'browser_emulate_media',
  'browser_evaluate',
  'browser_file_upload',
  'browser_fill_form',
  'browser_handle_dialog',
  'browser_hover',
  'browser_mouse_click_xy',
  'browser_mouse_down',
  'browser_mouse_drag_xy',
  'browser_mouse_move_xy',
  'browser_mouse_up',
  'browser_mouse_wheel',
  'browser_navigate',
  'browser_navigate_back',
  'browser_press_key',
  'browser_resize',
  'browser_resume',
  'browser_run_code_unsafe',
  'browser_select_option',
  'browser_tabs',
  'browser_type'
]

// MUSE§21
const KOLOFTS_RULE = 'koloft'

const fromMusesOwnEnv = (name: string): string => `\${${name}}`

const runsPlaywright = (raw: unknown): boolean => {
  const entry = record(raw)
  return runsPlaywrightMcp(entry.command, entry.args)
}

const KOLOFTS_BASE_OF_THE_COPY = 'koloft-muse-settings-base.json'

const isObject = (value: unknown): value is Record<string, unknown> => record(value) === value

const withServers = (
  settings: Record<string, unknown>,
  change: (name: string, entry: Record<string, unknown>) => Record<string, unknown>
): Record<string, unknown> => {
  if (!isObject(settings.mcpServers)) return settings
  const servers = Object.fromEntries(
    Object.entries(record(settings.mcpServers)).map(([name, raw]) => [
      name,
      runsPlaywright(raw) ? change(name, record(raw)) : raw
    ])
  )
  return { ...settings, mcpServers: servers }
}

// ADR-0048 MUSE§13 MUSE§18 MUSE§21
const koloftsCopy = (base: Record<string, unknown>): Record<string, unknown> =>
  withServers(base, (_, entry) => ({
    ...entry,
    env: {
      ...Object.fromEntries(MUSE_PASSES_TO_PLAYWRIGHT.map((key) => [key, fromMusesOwnEnv(key)])),
      ...record(entry.env)
    }
  }))

function withoutKoloftsLines(
  copy: Record<string, unknown>,
  base: Record<string, unknown>
): Record<string, unknown> {
  const baseServers = record(base.mcpServers)
  return withServers(copy, (name, { env, ...entry }) => {
    const ownersEntry = record(baseServers[name])
    const ownersEnv = record(ownersEntry.env)
    const kept = Object.fromEntries(
      Object.entries(record(env)).filter(
        ([key]) => !MUSE_PASSES_TO_PLAYWRIGHT.includes(key) || key in ownersEnv
      )
    )
    return Object.keys(kept).length || 'env' in ownersEntry ? { ...entry, env: kept } : entry
  })
}

const allowTool = (toolName: string): Record<string, unknown> => ({
  effect: 'allow',
  durability: 'local_persistent',
  rule: { kind: 'tool_action', tool_name: toolName },
  reason: KOLOFTS_RULE
})

const toolNameOf = (raw: unknown): unknown => record(record(raw).rule).tool_name

// MUSE§21
const toolNameIn = (server: string, tool: string): string =>
  `mcp__${server.replaceAll('-', '_')}__${tool}`

// ADR-0048 MUSE§21
function withKoloftsRules(
  policy: Record<string, unknown>,
  settings: Record<string, unknown>
): { schema_version: number; rules: unknown[] } {
  const rules = (Array.isArray(policy.rules) ? policy.rules : []).filter(
    (r) => record(r).reason !== KOLOFTS_RULE
  )
  const named = new Set(rules.map(toolNameOf))
  const added = Object.entries(record(settings.mcpServers))
    .filter(([, raw]) => runsPlaywright(raw))
    .flatMap(([server]) => PLAYWRIGHT_TOOLS_MUSE_ASKS_BEFORE.map((t) => toolNameIn(server, t)))
    .filter((name) => !named.has(name))
  return { ...MUSE_APPROVAL_POLICY_VERSION, ...policy, rules: [...rules, ...added.map(allowTool)] }
}

function writeMuseJson(file: string, value: unknown): void {
  const text = JSON.stringify(value, null, 2)
  try {
    if (!fs.lstatSync(file).isSymbolicLink() && fs.readFileSync(file, 'utf8') === text) return
  } catch {}
  writeWholeBeforeVisible(file, text)
  fs.chmodSync(file, 0o600)
}

function parsedOrMissing(file: string): Record<string, unknown> | undefined {
  if (!fs.lstatSync(file, { throwIfNoEntry: false })) return {}
  try {
    return record(JSON.parse(fs.readFileSync(file, 'utf8')))
  } catch {
    return undefined
  }
}

function withMusesChanges(
  owners: Record<string, unknown>,
  base: Record<string, unknown>,
  muses: Record<string, unknown>
): Record<string, unknown> {
  const merged = { ...owners }
  for (const key of new Set([...Object.keys(muses), ...Object.keys(base)])) {
    if (isDeepStrictEqual(muses[key], base[key])) continue
    if (isObject(muses[key]) && isObject(base[key]) && isObject(owners[key]))
      merged[key] = withMusesChanges(owners[key], base[key], muses[key])
    else if (key in muses) merged[key] = muses[key]
    else delete merged[key]
  }
  return merged
}

function musesCopy(copyFile: string): Record<string, unknown> | undefined {
  if (!fs.lstatSync(copyFile, { throwIfNoEntry: false })?.isFile()) return undefined
  return parsedOrMissing(copyFile)
}

function wroteOwnersFile(file: string, value: Record<string, unknown>): boolean {
  try {
    const target = fs.lstatSync(file, { throwIfNoEntry: false }) ? fs.realpathSync(file) : file
    const mode = fs.statSync(target, { throwIfNoEntry: false })?.mode ?? 0o600
    writeWholeBeforeVisible(target, JSON.stringify(value, null, 2))
    fs.chmodSync(target, mode)
    return true
  } catch {
    return false
  }
}

// ADR-0048 MUSE§13 MUSE§21
export function mergeMuseSettings(
  home: string,
  ownersConfig: string,
  workbenchBrowser?: boolean
): void {
  fs.mkdirSync(path.join(home, 'muse'), { recursive: true, mode: 0o700 })
  const ownersFile = path.join(ownersConfig, 'muse', 'settings.json')
  const copyFile = path.join(home, 'muse', 'settings.json')
  const baseFile = path.join(home, KOLOFTS_BASE_OF_THE_COPY)
  let owners = parsedOrMissing(ownersFile)
  if (!owners) return
  const base = parsedOrMissing(baseFile)
  const copy = base && Object.keys(base).length ? musesCopy(copyFile) : undefined
  const merged =
    base && copy ? withMusesChanges(owners, base, withoutKoloftsLines(copy, base)) : undefined
  const unsaved =
    merged &&
    !isDeepStrictEqual(merged, owners) &&
    !wroteOwnersFile(ownersFile, { ...MUSE_SETTINGS_VERSION, ...merged })
  if (merged && !unsaved) owners = merged
  if (!unsaved) {
    const nextBase = { ...MUSE_SETTINGS_VERSION, ...owners }
    writeMuseJson(copyFile, koloftsCopy(nextBase))
    writeMuseJson(baseFile, nextBase)
  }
  if (workbenchBrowser === undefined) return
  const policyFile = path.join(home, 'muse', 'approval-policy.json')
  const policy = parsedOrMissing(policyFile)
  if (!policy) return
  const next = withKoloftsRules(policy, workbenchBrowser ? owners : {})
  if (Object.keys(policy).length || next.rules.length) writeMuseJson(policyFile, next)
}

// MUSE§2 MUSE§13
export function prepareMuseHome(home: string, ownersConfig: string): void {
  const own = path.join(home, 'muse')
  fs.mkdirSync(own, { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(ownersConfig, 'muse'), { recursive: true })
  for (const name of SHARED_WITH_THE_OWNER)
    linkBack(path.join(own, name), path.join(ownersConfig, 'muse', name))
  mergeMuseSettings(home, ownersConfig)
  linkOwnersSkills(path.join(own, 'skills'), path.join(ownersConfig, 'muse', 'skills'))
  let entries: string[] = []
  try {
    entries = fs.readdirSync(ownersConfig)
  } catch {}
  for (const entry of entries) {
    const mine = path.join(home, entry)
    if (entry === 'muse' || fs.lstatSync(mine, { throwIfNoEntry: false })) continue
    fs.symlinkSync(path.join(ownersConfig, entry), mine)
  }
}
