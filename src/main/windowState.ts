import { app, screen, type BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { usableBounds, type SavedWindowState, type WinBounds } from './windowBounds'

/**
 * Window geometry persistence: size, position, maximized, fullscreen — restored on
 * the next launch instead of resetting to the 1440×920 default.
 *
 * Kept in its OWN file (window-state.json), not layout.json: the renderer replaces
 * layout.json wholesale on every (debounced) tab change, so a main-process field
 * there would race with — and be clobbered by — those writes. Main owns this file
 * exclusively.
 */

const DEFAULT_SIZE = { width: 1440, height: 920 }

function stateFile(): string {
  return path.join(app.getPath('userData'), 'window-state.json')
}

function loadState(): SavedWindowState {
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as SavedWindowState
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/** BrowserWindow construction geometry from the saved state. Bounds are validated
 *  against the connected displays (see usableBounds) so a window last seen on a
 *  now-unplugged monitor re-opens at the default size, OS-centered, not off-screen. */
export function restoredWindowGeometry(): {
  bounds: Partial<WinBounds> & { width: number; height: number }
  maximized: boolean
  fullScreen: boolean
} {
  const st = loadState()
  const displays = screen.getAllDisplays().map((d) => d.workArea)
  const bounds = usableBounds(st.bounds, displays)
  return {
    bounds: bounds ?? DEFAULT_SIZE,
    maximized: st.maximized === true,
    fullScreen: st.fullScreen === true
  }
}

/** Persist the window's geometry: debounced on resize/move (they stream events while
 *  dragging), immediate on the discrete state flips and on close. getNormalBounds()
 *  keeps the remembered rect the *un*-maximized/-fullscreened one, so leaving those
 *  states later restores the right size.
 *
 *  `pinnedFlags`: a background-test window is never shown and never enters maximize/
 *  fullscreen, so reading those live would write false over a real saved state when
 *  the run shares userData (a manual `KOLOFT_TEST_BACKGROUND=1 npm run dev`). The caller
 *  pins them to the values restored at launch; bounds still track live. */
export function trackWindowState(
  win: BrowserWindow,
  pinnedFlags?: { maximized: boolean; fullScreen: boolean }
): void {
  let timer: NodeJS.Timeout | null = null

  const write = (): void => {
    // reading from a destroyed window throws — quit can race the debounce timer
    if (win.isDestroyed()) return
    const st: SavedWindowState = {
      bounds: win.getNormalBounds(),
      maximized: pinnedFlags ? pinnedFlags.maximized : win.isMaximized(),
      fullScreen: pinnedFlags ? pinnedFlags.fullScreen : win.isFullScreen()
    }
    try {
      fs.writeFileSync(stateFile(), JSON.stringify(st, null, 2))
    } catch {
      /* best effort — geometry persistence must never crash the app */
    }
  }
  const writeSoon = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(write, 400)
  }

  win.on('resize', writeSoon)
  win.on('move', writeSoon)
  win.on('maximize', write)
  win.on('unmaximize', write)
  win.on('enter-full-screen', write)
  win.on('leave-full-screen', write)
  win.on('close', () => {
    if (timer) clearTimeout(timer)
    write()
  })
}
