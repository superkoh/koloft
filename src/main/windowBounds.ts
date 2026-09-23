import { WORKBENCH_WIDTH_FLOOR } from '@shared/settingsOps'

export interface WinBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface SavedWindowState {
  bounds?: WinBounds
  maximized?: boolean
  fullScreen?: boolean
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
