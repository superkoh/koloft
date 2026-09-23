/**
 * Pure window-bounds validation — no Electron imports so the logic is unit-testable
 * (the hermetic Vitest layer runs without an Electron runtime). windowState.ts feeds
 * it the live display work areas.
 */

export interface WinBounds {
  x: number
  y: number
  width: number
  height: number
}

/** What userData/window-state.json holds. All fields optional: absent/corrupt fields
 *  degrade to the default window, never to a crash. */
export interface SavedWindowState {
  bounds?: WinBounds
  maximized?: boolean
  fullScreen?: boolean
}

/** BrowserWindow construction props for the saved fullscreen flag. The key must be
 *  ABSENT unless true: Electron treats an explicit `fullscreen: false` as "hide or
 *  disable the macOS fullscreen button", degrading the green traffic light to
 *  zoom/maximize-only. */
export function fullscreenOption(fullScreen: boolean): { fullscreen?: true } {
  return fullScreen ? { fullscreen: true } : {}
}

/** Minimum on-screen overlap (px) that keeps the title bar reachable by the mouse. */
const GRAB = 100

/** B1: 1020 = 200 sidebar + 380 TUI floor + 440 Browser floor — the narrowest window in
 *  which the aux column can still hold a Browser. */
const MIN_WIDTH = 1020

/**
 * The `minWidth` a window opens with. Electron clamps construction bounds up against
 * `minWidth`, so a user upgrading from the old 900 minimum would have their saved
 * geometry silently widened; the minimum yields to a narrower restored width instead
 * and only binds that window's future resizes (B1/BB-C55).
 */
export function windowMinWidth(restoredWidth: number | undefined): number {
  return restoredWidth === undefined ? MIN_WIDTH : Math.min(MIN_WIDTH, restoredWidth)
}

/**
 * Return the saved bounds if they still land on a connected display, else null (the
 * caller falls back to the default size + OS centering). Guards the unplugged-monitor
 * case: bounds saved on an external display must not restore the window off-screen.
 * "Lands" = enough horizontal overlap with some display for a GRAB-wide strip, and the
 * title bar's y sits within that display's vertical range (not above it, not below the
 * bottom grab margin).
 */
export function usableBounds(raw: unknown, displays: WinBounds[]): WinBounds | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  const nums = [b.x, b.y, b.width, b.height]
  if (!nums.every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  const { x, y, width, height } = raw as WinBounds
  if (width < 200 || height < 200) return null
  for (const d of displays) {
    const overlapX = Math.min(x + width, d.x + d.width) - Math.max(x, d.x)
    if (overlapX >= GRAB && y >= d.y - 8 && y <= d.y + d.height - GRAB) {
      return { x, y, width, height }
    }
  }
  return null
}
