import type { BrowserCommand, WindowCommand } from './types'

/** The Browser commands the pane itself runs — everything that is not one of the two
 *  toggles deciding whether the surface is shown at all. */
export type PaneCommand = Exclude<BrowserCommand, 'toggle-browser' | 'toggle-focus-mode'>

/** Where one View-menu command lands once the active surface has arbitrated it. */
export type CommandTarget =
  | { to: 'app'; cmd: 'toggle-browser' | 'toggle-focus-mode' }
  | { to: 'browser'; cmd: PaneCommand }
  | { to: 'window'; cmd: WindowCommand }
  | { to: 'none' }

/**
 * Q2 — ⌘R / ⌘0± / ⌥⌘I are custom menu items rather than Electron roles, because a role
 * acts on the whole Koloft renderer: ⌘R inside a guest would reload the app and destroy
 * every live terminal. The renderer arbitrates them against `browserActive`, and this
 * table is the whole ruling: when it is true they act on the guest, otherwise they keep
 * the whole-window meaning their roles used to have.
 *
 * Since (D6/R14) `browserActive` IS a question about the focus, which reverses what
 * used to be written here. It means "the Workbench panel holds the caret AND its active
 * tab is a loaded web tab" — the caller composes both halves. Before, it meant only "a
 * guest is on screen", and that let a ⌘R typed at the conversation reload a page the user
 * was not looking at. The rule now is the one the focus ring draws: the keys belong to
 * whichever island is lit.
 *
 * Reload is the one exception with no `window` branch: outside the Browser it is
 * deliberately dropped rather than reloading the app window, and that is the safety
 * this feature exists for, not an omission to be "fixed" later.
 */
export function commandTarget(cmd: BrowserCommand, browserActive: boolean): CommandTarget {
  if (cmd === 'toggle-browser' || cmd === 'toggle-focus-mode') return { to: 'app', cmd }
  // these two are about TABS, not about the guest, so they reach the panel whatever
  // kind is active. `browserActive` answers "is there a page on screen for this to act
  // on", which is the right question for reload/zoom/devtools and the wrong one here: the
  // panel now always opens on the pinned `files` tab, so gating them on it left View ▸
  // "New Browser Tab" inert until a web tab already existed. The panel applies FR-52's
  // same-kind rule and FR-18's files no-op itself.
  if (cmd === 'browser-new-tab' || cmd === 'browser-close-tab') return { to: 'browser', cmd }
  if (browserActive) return { to: 'browser', cmd }
  switch (cmd) {
    case 'browser-devtools':
      return { to: 'window', cmd: 'window-devtools' }
    case 'browser-zoom-in':
      return { to: 'window', cmd: 'window-zoom-in' }
    case 'browser-zoom-out':
      return { to: 'window', cmd: 'window-zoom-out' }
    case 'browser-zoom-reset':
      return { to: 'window', cmd: 'window-zoom-reset' }
    default:
      return { to: 'none' }
  }
}

/** one keystroke as both of main's guest hooks see it (before-input-event's `input`,
 *  and the input-event observer's, whose modifiers arrive as a list) */
export interface GuestKeyInput {
  key: string
  meta: boolean
  control: boolean
  shift: boolean
  alt: boolean
}

/** The panel commands that can be fished out of a focused guest. A superset of
 *  `PaneCommand`: ⌘F and the two cycle keys are panel-level, not guest-level. */
export type GuestForwardedCommand = PaneCommand | 'find' | 'cycle-next' | 'cycle-prev'

/**
 * FR-53 — the keys main has to carry OUT of a focused guest, and the whole list.
 *
 * The problem this solves is structural: a focused page swallows the menu accelerators
 * that exist, and ⌘T has no menu accelerator at all (a focused shell or guest owns the key
 * while IT holds the focus). So without this list, every one of these keys goes dead
 * exactly while a page is focused — which after the merge is a normal place for the
 * focus to be, not the corner it used to be.
 *
 * The merge grew the list from two to five: ⌘W (FR-17 — close the active tab), ⌘F
 * (FR-35 — the guest's own findInPage) and ⌘⌥←/→ (FR-53 — cycle tabs) join ⌘T and ⌘L.
 * A command that is not idempotent — ⌘R above all — still travels exactly one carrier
 * and stays off this path.
 */
export function guestShortcut(input: GuestKeyInput): GuestForwardedCommand | null {
  if (!input.meta && !input.control) return null
  const key = input.key.toLowerCase()
  // ⌘⌥←/→ is the one entry that WANTS alt; everything else refuses both modifiers
  if (input.alt && !input.shift) {
    if (key === 'arrowright') return 'cycle-next'
    if (key === 'arrowleft') return 'cycle-prev'
    return null
  }
  if (input.shift || input.alt) return null
  if (key === 't') return 'browser-new-tab'
  if (key === 'l') return 'browser-focus-address'
  if (key === 'w') return 'browser-close-tab'
  if (key === 'f') return 'find'
  return null
}

/** Electron's zoom roles stepped by half a level and clamped to Chromium's range; the
 *  fallback keeps both, so the keys behave exactly as they did before the Browser. */
const ZOOM_STEP = 0.5
const MIN_ZOOM_LEVEL = -8
const MAX_ZOOM_LEVEL = 9

export function nextZoomLevel(
  level: number,
  cmd: Exclude<WindowCommand, 'window-devtools'>
): number {
  if (cmd === 'window-zoom-in') return Math.min(level + ZOOM_STEP, MAX_ZOOM_LEVEL)
  if (cmd === 'window-zoom-out') return Math.max(level - ZOOM_STEP, MIN_ZOOM_LEVEL)
  return 0
}

/** the slice of the host window's webContents the fallback drives (typed here so it
 *  stays main's only Electron dependency for this path) */
export interface WindowSurface {
  toggleDevTools(): void
  getZoomLevel(): number
  setZoomLevel(level: number): void
}

export function applyWindowCommand(win: WindowSurface, cmd: WindowCommand): void {
  if (cmd === 'window-devtools') win.toggleDevTools()
  else win.setZoomLevel(nextZoomLevel(win.getZoomLevel(), cmd))
}
