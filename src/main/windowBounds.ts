import { WORKBENCH_WIDTH_FLOOR } from '@shared/settingsOps'

export interface WinBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface SavedWorkbenchWindow {
  bounds?: WinBounds
  popped?: boolean
}

export interface SavedWindowState {
  bounds?: WinBounds
  maximized?: boolean
  fullScreen?: boolean
  workbench?: SavedWorkbenchWindow
}

export function fullscreenOption(fullScreen: boolean): { fullscreen?: true } {
  return fullScreen ? { fullscreen: true } : {}
}

const TITLE_BAR_GRAB_PX = 100

const SIDEBAR_PX = 200
const TUI_FLOOR_PX = 380
const MIN_WIDTH = SIDEBAR_PX + TUI_FLOOR_PX + WORKBENCH_WIDTH_FLOOR

export function windowMinWidth(restoredWidth: number | undefined): number {
  return restoredWidth === undefined ? MIN_WIDTH : Math.min(MIN_WIDTH, restoredWidth)
}

const MIN_RESTORABLE_SIDE_PX = 200
const TITLE_BAR_ABOVE_DISPLAY_SLACK_PX = 8

export function usableBounds(raw: unknown, displays: WinBounds[]): WinBounds | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  const nums = [b.x, b.y, b.width, b.height]
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  const { x, y, width, height } = raw as WinBounds
  if (width < MIN_RESTORABLE_SIDE_PX || height < MIN_RESTORABLE_SIDE_PX) return null
  for (const d of displays) {
    const overlapX = Math.min(x + width, d.x + d.width) - Math.max(x, d.x)
    if (
      overlapX >= TITLE_BAR_GRAB_PX &&
      y >= d.y - TITLE_BAR_ABOVE_DISPLAY_SLACK_PX &&
      y <= d.y + d.height - TITLE_BAR_GRAB_PX
    ) {
      return { x, y, width, height }
    }
  }
  return null
}

const WORKBENCH_WINDOW_PREFERRED = { width: 960, height: 900 }
const WORKBENCH_WINDOW_SHARE_OF_SHARED_SCREEN = 0.5

function contains(area: WinBounds, x: number, y: number): boolean {
  return x >= area.x && x < area.x + area.width && y >= area.y && y < area.y + area.height
}

export function displayContaining(win: WinBounds, displays: WinBounds[]): WinBounds | undefined {
  const cx = win.x + win.width / 2
  const cy = win.y + win.height / 2
  return displays.find((d) => contains(d, cx, cy))
}

export function workbenchWindowBounds(
  saved: unknown,
  displays: WinBounds[],
  mainBounds: WinBounds
): WinBounds {
  const kept = usableBounds(saved, displays)
  if (kept) return kept
  const mainDisplay = displayContaining(mainBounds, displays) ?? displays[0] ?? mainBounds
  const other = displays.find((d) => d !== mainDisplay)
  if (other) {
    const width = Math.min(WORKBENCH_WINDOW_PREFERRED.width, other.width)
    const height = Math.min(WORKBENCH_WINDOW_PREFERRED.height, other.height)
    return {
      x: Math.round(other.x + (other.width - width) / 2),
      y: Math.round(other.y + (other.height - height) / 2),
      width,
      height
    }
  }
  const width = Math.max(
    WORKBENCH_WIDTH_FLOOR,
    Math.round(mainDisplay.width * WORKBENCH_WINDOW_SHARE_OF_SHARED_SCREEN)
  )
  return {
    x: mainDisplay.x + mainDisplay.width - width,
    y: mainDisplay.y,
    width,
    height: mainDisplay.height
  }
}
