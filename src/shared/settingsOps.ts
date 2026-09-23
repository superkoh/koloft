import {
  DEFAULT_SETTINGS,
  HINT_IDS,
  WORLD_CLOCK_MAX,
  sanitizeAccountList,
  type Settings
} from './types'
import { normalizeSessionMethods } from './sessionBackend'

/** FR-12: the reset patch — DEFAULT_SETTINGS minus the account domain
 *  (accounts / multiAccount / skipPermissions / fablePriority). Excluding only
 *  `accounts` is not enough: multiAccount would silently reset to false and disable
 *  the whole pool, and fablePriority defaults ON — a reset would put every launch
 *  back on the fable host the user turned it off to get away from (D20). */
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

/** FR-13: the settings:set IPC boundary never accepts the account registry —
 *  accounts persist only via the accounts:* channels (main calls saveSettings
 *  directly). Everything else in the patch passes through untouched. */
export function sanitizeSettingsPatch(patch: Partial<Settings>): Partial<Settings> {
  const { accounts, ...rest } = patch
  void accounts
  return rest
}

/** settings.json is a plain file the user can hand-edit, so what comes off
 *  disk is repaired once, here, before anything reads it. Values that turn into layout
 *  arithmetic are the ones that matter: a height or width that is NaN, Infinity, a
 *  string, or absurdly small would spread through the CSS instead of being rejected, and
 *  a fold flag that is not true/false would make the island open on a string. The patch
 *  side is deliberately NOT guarded — its only caller is our own renderer sending its own
 *  numbers and booleans, and anything odd it saved is repaired on the next load anyway. */
export function sanitizeLoadedSettings(raw: unknown): Settings {
  const doc: Partial<Settings> = raw && typeof raw === 'object' ? (raw as Partial<Settings>) : {}
  const merged = { ...DEFAULT_SETTINGS, ...doc }
  merged.sessionMethods = normalizeSessionMethods(merged.sessionMethods)
  // account names reach a bash `security` call and the Keychain — never trust disk
  merged.accounts = sanitizeAccountList(merged.accounts)
  // Data Model: a document written before the Workbench merge carries no
  // `workbenchWidth` of its own — seed it from the WIDER of the two panes it replaced,
  // so the merged panel opens at a width the user already dragged to rather than at the
  // shipped default. The key's own presence is the test, not its value: once it exists
  // it is authoritative, or every load would re-derive it from the dead keys and undo
  // the last drag. Those two keys deliberately stay on disk — saveSettings merges then
  // rewrites whole and has no key-deletion mechanism.
  merged.workbenchWidth = sanitizeWorkbenchWidth(
    'workbenchWidth' in doc
      ? merged.workbenchWidth
      : Math.max(merged.filePaneWidth, merged.browserPaneWidth)
  )
  merged.notesHeight = sanitizeNotesHeight(merged.notesHeight)
  merged.notesFolded =
    typeof merged.notesFolded === 'boolean' ? merged.notesFolded : DEFAULT_SETTINGS.notesFolded
  // an id Intl rejects throws at render time; a duplicate gives two chips one key
  merged.worldClocks = Array.isArray(merged.worldClocks)
    ? [...new Set(merged.worldClocks.filter(isZoneId))].slice(0, WORLD_CLOCK_MAX)
    : []
  // a document with settings in it but no `onboardingSeen` predates the welcome —
  // an upgrade, not a first run, so the welcome and every tip count as seen.
  const upgrade = !('onboardingSeen' in doc) && Object.keys(doc).length > 0
  if (upgrade) merged.onboardingSeen = true
  // every reader appends to this list, so a non-array on disk would throw
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

/** FR-08/NFR-07: the Workbench panel's minimum width. Shared rather than main-side
 *  because the drag clamp and the load-time repair must agree exactly — the two merged
 *  panes had different floors, and the higher one wins: below 440 a `web` tab hits most
 *  sites' mobile breakpoint, and any tab can be a `web` one now. */
export const WORKBENCH_WIDTH_FLOOR = 440

/** the saved width is
 *  arithmetic all the way to a CSS width, and Math.min/Math.max propagate a NaN instead
 *  of rejecting it — a garbage value read off a hand-edited settings.json would leave a
 *  panel too narrow to find the divider in. The window-fit clamp is separate (FR-08's
 *  "clamps to the window"); this only guarantees a usable number at or above the floor. */
export function sanitizeWorkbenchWidth(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_SETTINGS.workbenchWidth
  return Math.max(WORKBENCH_WIDTH_FLOOR, n)
}

/** the shortest the Notes island may stand while open. Below this the text box
 *  shows barely a line and the drag handle is hard to grab again. */
export const NOTES_HEIGHT_FLOOR = 120

/** the saved Notes height, repaired on load exactly like `sanitizeWorkbenchWidth` —
 *  the number goes straight into a CSS height, and NaN/Infinity would spread through the
 *  layout arithmetic instead of being rejected. Anything that is not a real number falls
 *  back to the shipped default; anything too short is raised to the floor. */
export function sanitizeNotesHeight(raw: unknown): number {
  const n = typeof raw === 'number' && Number.isFinite(raw) ? raw : DEFAULT_SETTINGS.notesHeight
  return Math.max(NOTES_HEIGHT_FLOOR, n)
}

/** FR-08 / edge case: <input type=number> min/max does not clamp typed values —
 *  a typed 99 used to really render the terminal at 99px. Empty/invalid falls
 *  back to the default (existing behavior), out-of-range clamps to 8–32. */
export function clampFontSize(raw: string | number): number {
  const n = Number(raw)
  if (!n) return DEFAULT_SETTINGS.fontSize
  return Math.min(32, Math.max(8, n))
}
