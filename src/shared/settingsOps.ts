import {
  DEFAULT_SETTINGS,
  HINT_IDS,
  WORLD_CLOCK_MAX,
  sanitizeAccountList,
  type ButlerSetting,
  type Settings
} from './types'
import { sanitizeGitAccounts, sanitizeGitMachines, sanitizeGitPicks } from './gitAccountOps'
import { assistOnMethodsThatAreOn, sanitizeAssist } from './assistPicks'
import { backendIdOf, normalizeSessionMethods } from './sessionBackend'
import { butlerName, butlerSetting, sanitizeButlerSession, sanitizeDiscord } from './conductors'
import { isRecord } from './workbenchState'
import { sanitizeSessionDefaults } from './sessionDefaults'

export function buildResetPatch(): Partial<Settings> {
  const {
    accounts,
    skipPermissions,
    skipPermissionsAgreed,
    fablePriority,
    sessionMethods,
    discord,
    assist,
    butler,
    butlerSession,
    newProjectFolders,
    gitAccounts,
    gitPicks,
    gitSuggestionsDismissed,
    gitMachines,
    todoNotes,
    sessionDefaults,
    ...rest
  } = DEFAULT_SETTINGS
  void todoNotes
  void sessionDefaults
  void butler
  void gitAccounts
  void gitPicks
  void gitSuggestionsDismissed
  void gitMachines
  void assist
  void butlerSession
  void newProjectFolders
  void accounts
  void skipPermissions
  void skipPermissionsAgreed
  void fablePriority
  void sessionMethods
  void discord
  return rest
}

export function sanitizeSettingsPatch(patch: Partial<Settings>): Partial<Settings> {
  const {
    accounts,
    discord,
    butlerSession,
    gitAccounts,
    gitPicks,
    gitSuggestionsDismissed,
    gitMachines,
    todoNotes,
    sessionDefaults,
    ...rest
  } = patch
  void todoNotes
  void sessionDefaults
  void gitAccounts
  void gitPicks
  void gitSuggestionsDismissed
  void gitMachines
  void accounts
  void discord
  void butlerSession
  return rest
}

export function sanitizeLoadedSettings(raw: unknown): Settings {
  const doc: Partial<Settings> = raw && typeof raw === 'object' ? (raw as Partial<Settings>) : {}
  const {
    assistSessions,
    lastSeenVersion: _retired,
    showUsage: _retiredShowUsage,
    ...kept
  } = doc as Partial<Settings> & {
    assistSessions?: unknown
    lastSeenVersion?: unknown
    showUsage?: unknown
  }
  const merged: Settings = { ...DEFAULT_SETTINGS, ...kept }
  merged.sessionMethods = normalizeSessionMethods(merged.sessionMethods)
  merged.accounts = sanitizeAccountList(merged.accounts)
  merged.gitAccounts = sanitizeGitAccounts(merged.gitAccounts)
  merged.gitPicks = sanitizeGitPicks(merged.gitPicks, merged.gitAccounts)
  merged.gitSuggestionsDismissed = Array.isArray(merged.gitSuggestionsDismissed)
    ? merged.gitSuggestionsDismissed.filter((r): r is string => typeof r === 'string')
    : []
  merged.gitMachines = sanitizeGitMachines(merged.gitMachines)
  merged.butlerSession = sanitizeButlerSession(doc.butlerSession, assistSessions, merged.discord)
  merged.discord = sanitizeDiscord(merged.discord)
  const pickedAssistBefore = backendIdOf((doc.assist as { backend?: unknown } | null)?.backend)
  merged.assist = assistOnMethodsThatAreOn(sanitizeAssist(merged.assist), merged.sessionMethods)
  merged.butler = sanitizeButler(merged.butler)
  merged.newProjectFolders = sanitizeTextMap(merged.newProjectFolders)
  merged.todoNotes = sanitizeTextMap(merged.todoNotes)
  merged.sessionDefaults = sanitizeSessionDefaults(merged.sessionDefaults)
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

function sanitizeButler(raw: unknown): ButlerSetting {
  const doc = isRecord(raw) ? raw : {}
  const former = Array.isArray(doc.formerNames) ? doc.formerNames : []
  return butlerSetting(
    butlerName(doc.name),
    former.filter((n): n is string => typeof n === 'string').map(butlerName)
  )
}

function sanitizeTextMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {}
  return Object.fromEntries(
    Object.entries(raw).filter(
      (e): e is [string, string] => typeof e[1] === 'string' && e[1].length > 0
    )
  )
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
