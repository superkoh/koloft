import type { BrowserCommand, WindowCommand } from './types'

export type PaneCommand = Exclude<BrowserCommand, 'toggle-browser' | 'toggle-focus-mode'>

export type CommandTarget =
  | { to: 'app'; cmd: 'toggle-browser' | 'toggle-focus-mode' }
  | { to: 'browser'; cmd: PaneCommand }
  | { to: 'window'; cmd: WindowCommand }
  | { to: 'none' }

// PLATFORM§7
export function commandTarget(cmd: BrowserCommand, browserActive: boolean): CommandTarget {
  if (cmd === 'toggle-browser' || cmd === 'toggle-focus-mode') return { to: 'app', cmd }
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

export interface GuestKeyInput {
  key: string
  meta: boolean
  control: boolean
  shift: boolean
  alt: boolean
}

export type GuestForwardedCommand = PaneCommand | 'find' | 'cycle-next' | 'cycle-prev'

// PLATFORM§7
export function guestShortcut(input: GuestKeyInput): GuestForwardedCommand | null {
  if (!input.meta && !input.control) return null
  const key = input.key.toLowerCase()
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

// PLATFORM§7
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

export interface WindowSurface {
  toggleDevTools(): void
  getZoomLevel(): number
  setZoomLevel(level: number): void
}

export function applyWindowCommand(win: WindowSurface, cmd: WindowCommand): void {
  if (cmd === 'window-devtools') win.toggleDevTools()
  else win.setZoomLevel(nextZoomLevel(win.getZoomLevel(), cmd))
}
