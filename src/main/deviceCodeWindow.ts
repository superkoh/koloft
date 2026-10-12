import { BrowserWindow } from 'electron'
import { randomUUID } from 'crypto'
import { osHandOffSuppressed } from './osOpen'

const WINDOW_WIDTH = 480
const WINDOW_HEIGHT = 720
const WINDOW_TITLE = 'Sign in to GitHub'

export interface DeviceCodePage {
  show(): void
  close(): void
}

export function openDeviceCodeWindow(url: string): DeviceCodePage {
  if (osHandOffSuppressed(url))
    return { show: () => void osHandOffSuppressed(url), close: () => {} }
  const partition = `gh-login-${randomUUID()}`
  let win: BrowserWindow | null = null
  const make = (): void => {
    const w = new BrowserWindow({
      width: WINDOW_WIDTH,
      height: WINDOW_HEIGHT,
      title: WINDOW_TITLE,
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    w.on('page-title-updated', (e) => e.preventDefault())
    w.on('closed', () => {
      if (win === w) win = null
    })
    void w.loadURL(url)
    win = w
  }
  make()
  return {
    show: () => {
      if (!win) return make()
      win.show()
      win.focus()
    },
    close: () => {
      win?.destroy()
      win = null
    }
  }
}
