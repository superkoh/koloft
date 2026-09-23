import { app, screen, type BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import { usableBounds, type SavedWindowState, type WinBounds } from './windowBounds'

const DEFAULT_SIZE = { width: 1440, height: 920 }
const DRAG_SETTLE_MS = 400

// ADR-0005
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

export function trackWindowState(
  win: BrowserWindow,
  pinnedFlags?: { maximized: boolean; fullScreen: boolean }
): void {
  let timer: NodeJS.Timeout | null = null

  const write = (): void => {
    if (win.isDestroyed()) return
    const st: SavedWindowState = {
      bounds: win.getNormalBounds(),
      maximized: pinnedFlags ? pinnedFlags.maximized : win.isMaximized(),
      fullScreen: pinnedFlags ? pinnedFlags.fullScreen : win.isFullScreen()
    }
    try {
      fs.writeFileSync(stateFile(), JSON.stringify(st, null, 2))
    } catch {}
  }
  const writeSoon = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(write, DRAG_SETTLE_MS)
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
