import { app, screen, type BrowserWindow } from 'electron'
import fs from 'fs'
import path from 'path'
import {
  usableBounds,
  workbenchWindowBounds,
  type SavedWindowState,
  type SavedWorkbenchWindow,
  type WinBounds
} from './windowBounds'

const DEFAULT_SIZE = { width: 1440, height: 920 }
const DRAG_SETTLE_MS = 400

// ADR-0005
function stateFile(): string {
  return path.join(app.getPath('userData'), 'window-state.json')
}

let loaded: SavedWindowState | null = null

function state(): SavedWindowState {
  if (loaded) return loaded
  try {
    const parsed = JSON.parse(fs.readFileSync(stateFile(), 'utf8')) as SavedWindowState
    loaded = parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    loaded = {}
  }
  return loaded
}

function mergeState(patch: SavedWindowState): void {
  loaded = { ...state(), ...patch }
  try {
    fs.writeFileSync(stateFile(), JSON.stringify(loaded, null, 2))
  } catch {}
}

function displayAreas(): WinBounds[] {
  return screen.getAllDisplays().map((d) => d.workArea)
}

export function restoredWindowGeometry(): {
  bounds: Partial<WinBounds> & { width: number; height: number }
  maximized: boolean
  fullScreen: boolean
} {
  const st = state()
  const bounds = usableBounds(st.bounds, displayAreas())
  return {
    bounds: bounds ?? DEFAULT_SIZE,
    maximized: st.maximized === true,
    fullScreen: st.fullScreen === true
  }
}

function writeOnSettle(win: BrowserWindow, write: () => void): void {
  let timer: NodeJS.Timeout | null = null
  const writeSoon = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(write, DRAG_SETTLE_MS)
  }
  win.on('resize', writeSoon)
  win.on('move', writeSoon)
  win.on('close', () => {
    if (timer) clearTimeout(timer)
    write()
  })
}

export function trackWindowState(
  win: BrowserWindow,
  pinnedFlags?: { maximized: boolean; fullScreen: boolean }
): void {
  const write = (): void => {
    if (win.isDestroyed()) return
    mergeState({
      bounds: win.getNormalBounds(),
      maximized: pinnedFlags ? pinnedFlags.maximized : win.isMaximized(),
      fullScreen: pinnedFlags ? pinnedFlags.fullScreen : win.isFullScreen()
    })
  }
  writeOnSettle(win, write)
  win.on('maximize', write)
  win.on('unmaximize', write)
  win.on('enter-full-screen', write)
  win.on('leave-full-screen', write)
}

function savedWorkbench(): SavedWorkbenchWindow {
  const wb = state().workbench
  return wb && typeof wb === 'object' ? wb : {}
}

function saveWorkbench(patch: SavedWorkbenchWindow): void {
  mergeState({ workbench: { ...savedWorkbench(), ...patch } })
}

export function workbenchWasPopped(): boolean {
  const wb = savedWorkbench()
  return wb.popped === true && usableBounds(wb.bounds, displayAreas()) !== null
}

export function setWorkbenchPopped(popped: boolean): void {
  saveWorkbench({ popped })
}

export function workbenchWindowPlacement(mainBounds: WinBounds): WinBounds {
  return workbenchWindowBounds(savedWorkbench().bounds, displayAreas(), mainBounds)
}

export function trackWorkbenchWindow(
  win: BrowserWindow,
  onSettled: (bounds: WinBounds) => void
): void {
  const write = (): void => {
    if (win.isDestroyed()) return
    const bounds = win.getNormalBounds()
    saveWorkbench({ bounds })
    onSettled(bounds)
  }
  writeOnSettle(win, write)
  write()
}
