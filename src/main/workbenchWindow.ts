import { BrowserWindow, screen, type Display, type WebContents } from 'electron'
import { WORKBENCH_WINDOW_NAME, type WorkbenchWindowState } from '@shared/types'
import { setWorkbenchPopped, trackWorkbenchWindow, workbenchWindowPlacement } from './windowState'
import { displayContaining, koloftWindowChrome, type WinBounds } from './windowBounds'
import { WORKBENCH_WIDTH_FLOOR } from '@shared/settingsOps'

export interface WorkbenchWindowDeps {
  main(): BrowserWindow | null
  background: boolean
  guardHost(wc: WebContents): void
  watchFocus(win: BrowserWindow, report: (focused: boolean) => void): void
  send(channel: string, ...args: unknown[]): void
  agentDriving(): boolean
  quitting(): boolean
}

const WORKBENCH_WINDOW_MIN_HEIGHT = 400

let deps: WorkbenchWindowDeps | null = null
let win: BrowserWindow | null = null
let released = false
let settledBounds: WinBounds | null = null

export function setupWorkbenchWindow(d: WorkbenchWindowDeps): void {
  deps = d
  screen.on('display-removed', (_e, display) => onDisplayRemoved(display))
}

export function workbenchWindow(): BrowserWindow | null {
  return win && !win.isDestroyed() ? win : null
}

export function workbenchWindowMinimized(): boolean {
  return workbenchWindow()?.isMinimized() === true
}

function state(): WorkbenchWindowState {
  const w = workbenchWindow()
  return {
    open: !!w,
    focused: !!w && w.isFocused(),
    fullScreen: !!w && w.isFullScreen()
  }
}

function report(): void {
  deps?.send('workbench-window:state', state())
}

export function workbenchWindowOpenResponse(
  frameName: string,
  url: string
): Electron.WindowOpenHandlerResponse {
  const d = deps
  const main = d?.main()
  if (!d || !main || frameName !== WORKBENCH_WINDOW_NAME || url !== 'about:blank' || win) {
    return { action: 'deny' }
  }
  const bounds = workbenchWindowPlacement(main.getBounds())
  return {
    action: 'allow',
    overrideBrowserWindowOptions: {
      ...bounds,
      minWidth: WORKBENCH_WIDTH_FLOOR,
      minHeight: WORKBENCH_WINDOW_MIN_HEIGHT,
      ...koloftWindowChrome(d.background),
      title: 'Workbench',
      webPreferences: {
        webviewTag: true,
        // PLATFORM§5
        backgroundThrottling: !d.background
      }
    }
  }
}

export function adoptWorkbenchWindow(w: BrowserWindow): void {
  const d = deps
  if (!d) return
  win = w
  released = false
  setWorkbenchPopped(true)
  // PLATFORM§5
  d.main()?.webContents.setBackgroundThrottling(false)
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  w.webContents.on('will-navigate', (e) => e.preventDefault())
  // PLATFORM§42
  d.guardHost(w.webContents)
  d.watchFocus(w, report)
  w.on('enter-full-screen', report)
  w.on('leave-full-screen', report)
  trackWorkbenchWindow(w, (b) => {
    settledBounds = b
  })
  w.on('close', (e) => {
    if (released || d.quitting() || !d.main()) return
    e.preventDefault()
    requestDock()
  })
  w.on('closed', () => {
    if (win === w) win = null
    settledBounds = null
    const main = d.main()
    if (main && !main.isDestroyed()) main.webContents.setBackgroundThrottling(!d.background)
    report()
  })
  report()
}

export function requestDock(): void {
  if (!workbenchWindow()) return
  if (deps?.agentDriving()) {
    deps.send('workbench-window:refused')
    return
  }
  deps?.send('workbench-window:dock')
}

export function releaseWorkbenchWindow(): void {
  const w = workbenchWindow()
  if (!w) return
  released = true
  setWorkbenchPopped(false)
  w.close()
}

export function dropWorkbenchWindow(): void {
  workbenchWindow()?.destroy()
}

export function raiseWorkbenchWindow(takeFocus: boolean): void {
  const w = workbenchWindow()
  if (!w || deps?.background) return
  if (w.isMinimized()) w.restore()
  if (!takeFocus) {
    w.moveTop()
    return
  }
  w.show()
  w.focus()
}

function onDisplayRemoved(display: Display): void {
  if (!workbenchWindow() || !settledBounds) return
  if (!displayContaining(settledBounds, [display.bounds])) return
  if (deps?.agentDriving()) return
  requestDock()
}
