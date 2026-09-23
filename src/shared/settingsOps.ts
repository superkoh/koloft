import {
  DEFAULT_SETTINGS,
  HINT_IDS,
  WORLD_CLOCK_MAX,
  sanitizeAccountList,
  type Settings
} from './types'
import { normalizeSessionMethods } from './sessionBackend'

export function buildResetPatch(): Partial<Settings> {
  const { accounts, multiAccount, skipPermissions, fablePriority, sessionMethods, ...rest } =
    DEFAULT_SETTINGS
  void accounts
  void multiAccount
  void skipPermissions
  void fablePriority
  void sessionMethods
  return rest
}

export function sanitizeSettingsPatch(patch: Partial<Settings>): Partial<Settings> {
  const { accounts, ...rest } = patch
  void accounts
  return rest
}

export function sanitizeLoadedSettings(raw: unknown): Settings {
  const doc: Partial<Settings> = raw && typeof raw === 'object' ? (raw as Partial<Settings>) : {}
  const merged = { ...DEFAULT_SETTINGS, ...doc }
  merged.sessionMethods = normalizeSessionMethods(merged.sessionMethods)
  merged.accounts = sanitizeAccountList(merged.accounts)
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
