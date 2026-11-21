import {
  APP_DEFAULT_SETTINGS,
  WORLD_CLOCK_MAX,
  sanitizeAccountList,
  type AppSettings,
  type Settings
} from './types'
import { sanitizeGitAccounts, sanitizeGitMachines, sanitizeGitPicks } from './gitAccountOps'
import { assistOnMethodsThatAreOn, sanitizeAssist } from './assistPicks'
import { backendIdOf, normalizeSessionMethods } from './sessionBackend'
import { sanitizeSessionDefaults } from './sessionDefaults'
import { stringsIn, textsIn } from './workbenchState'
import { registerSettings } from '@core/settings'
import { cleanVersions } from '@core/ownerInstructions'
import { cleanSwitches } from '@core/switches'
import { HINT_IDS } from '@core/hints'
import { PLUGINS } from '@plugins/list'
import { PLUGIN_SETTINGS, type PluginSettingValues } from '@plugins/settings'

const PLUGIN_KEYS = registerSettings(PLUGINS, PLUGIN_SETTINGS)

export const DEFAULT_SETTINGS: Settings = {
  ...APP_DEFAULT_SETTINGS,
  ...(PLUGIN_KEYS.defaults as PluginSettingValues)
}

const APP_KEPT_ON_RESET: readonly (keyof AppSettings)[] = [
  'accounts',
  'skipPermissions',
  'skipPermissionsAgreed',
  'fablePriority',
  'sessionMethods',
  'assist',
  'newProjectFolders',
  'gitAccounts',
  'gitPicks',
  'gitSuggestionsDismissed',
  'gitMachines',
  'sessionDefaults',
  'everyWorkspaceInstructions'
]

const APP_WRITTEN_BY_MAIN_ONLY: readonly (keyof AppSettings)[] = [
  'accounts',
  'gitAccounts',
  'gitPicks',
  'gitSuggestionsDismissed',
  'gitMachines',
  'sessionDefaults',
  'everyWorkspaceInstructions'
]

const KEPT_ON_RESET = [...APP_KEPT_ON_RESET, ...PLUGIN_KEYS.keptOnReset]
const WRITTEN_BY_MAIN_ONLY = [...APP_WRITTEN_BY_MAIN_ONLY, ...PLUGIN_KEYS.writtenByMainOnly]
const RETIRED_KEYS = ['lastSeenVersion', 'showUsage', ...PLUGIN_KEYS.retired]

const without = <T extends object>(from: T, keys: readonly string[]): Partial<T> =>
  Object.fromEntries(Object.entries(from).filter(([key]) => !keys.includes(key))) as Partial<T>

export function buildResetPatch(): Partial<Settings> {
  return without(DEFAULT_SETTINGS, KEPT_ON_RESET)
}

export function sanitizeSettingsPatch(patch: Partial<Settings>): Partial<Settings> {
  return without(patch, WRITTEN_BY_MAIN_ONLY)
}

export function sanitizeLoadedSettings(raw: unknown): Settings {
  const doc: Record<string, unknown> =
    raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const merged = { ...DEFAULT_SETTINGS, ...without(doc, RETIRED_KEYS) } as Settings
  merged.sessionMethods = normalizeSessionMethods(merged.sessionMethods)
  merged.accounts = sanitizeAccountList(merged.accounts)
  merged.gitAccounts = sanitizeGitAccounts(merged.gitAccounts)
  merged.gitPicks = sanitizeGitPicks(merged.gitPicks, merged.gitAccounts)
  merged.gitSuggestionsDismissed = stringsIn(merged.gitSuggestionsDismissed)
  merged.gitMachines = sanitizeGitMachines(merged.gitMachines)
  merged.pluginsOn = cleanSwitches(PLUGINS, merged.pluginsOn)
  Object.assign(merged, PLUGIN_KEYS.clean(doc))
  const pickedAssistBefore = backendIdOf((doc.assist as { backend?: unknown } | null)?.backend)
  merged.assist = assistOnMethodsThatAreOn(sanitizeAssist(merged.assist), merged.sessionMethods)
  merged.newProjectFolders = textsIn(merged.newProjectFolders)
  merged.sessionDefaults = sanitizeSessionDefaults(merged.sessionDefaults)
  merged.everyWorkspaceInstructions = cleanVersions(merged.everyWorkspaceInstructions)
  merged.workbenchWidth = sanitizeWorkbenchWidth(
    'workbenchWidth' in doc
      ? merged.workbenchWidth
      : Math.max(merged.filePaneWidth, merged.browserPaneWidth)
  )
  merged.notesHeight = sanitizeNotesHeight(merged.notesHeight)
  merged.notesFolded =
    typeof merged.notesFolded === 'boolean' ? merged.notesFolded : DEFAULT_SETTINGS.notesFolded
  merged.worldClocks = Array.isArray(merged.worldClocks)
    ? [...new Set(merged.worldClocks.filter(isZoneId))].slice(0, WORLD_CLOCK_MAX)
    : []
  merged.skipPermissionsAgreed =
    'skipPermissionsAgreed' in doc
      ? merged.skipPermissionsAgreed === true
      : pickedAssistBefore !== undefined && merged.skipPermissions === true
  const upgrade = !('onboardingSeen' in doc) && Object.keys(doc).length > 0
  if (upgrade) merged.onboardingSeen = true
  merged.hintsSeen = upgrade
    ? [...HINT_IDS]
    : Array.isArray(merged.hintsSeen)
      ? merged.hintsSeen
      : []
  return merged
}

function isZoneId(z: unknown): z is string {
  if (typeof z !== 'string') return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z })
    return true
  } catch {
    return false
  }
}

export const WORKBENCH_WIDTH_FLOOR = 440

export function sanitizeWorkbenchWidth(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_SETTINGS.workbenchWidth
  return Math.max(WORKBENCH_WIDTH_FLOOR, n)
}

export const NOTES_HEIGHT_FLOOR = 120

export function sanitizeNotesHeight(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_SETTINGS.notesHeight
  return Math.max(NOTES_HEIGHT_FLOOR, n)
}

export function clampFontSize(raw: string | number): number {
  const n = Number(raw)
  if (!n) return DEFAULT_SETTINGS.fontSize
  return Math.min(32, Math.max(8, n))
}
