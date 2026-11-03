import path from 'path'
import { BrowserWindow, WebContentsView, type WebContents } from 'electron'
import { addressSecurity } from '@shared/signInAddress'

export const ADDRESS_BAR_HEIGHT = 36
const BROWSER_WINDOW_DEFAULT_SIZE = { width: 800, height: 600 }

function loadAddressBar(host: BrowserWindow): void {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) void host.loadURL(new URL('sign-in-bar.html', `${devUrl}/`).toString())
  else void host.loadFile(path.join(__dirname, '../renderer/sign-in-bar.html'))
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).host
  } catch {
    return null
  }
}

// PLATFORM§8
type SignInWindowOptions = Electron.BrowserWindowConstructorOptions & { webContents?: WebContents }

export function openSignInWindow(
  options: SignInWindowOptions,
  show: boolean
): { host: BrowserWindow; page: WebContents } {
  const width = options.width ?? BROWSER_WINDOW_DEFAULT_SIZE.width
  const height = options.height ?? BROWSER_WINDOW_DEFAULT_SIZE.height
  const host = new BrowserWindow({
    x: options.x,
    y: options.y,
    width,
    height: height + ADDRESS_BAR_HEIGHT,
    useContentSize: true,
    show: false,
    backgroundColor: '#1c1c1f',
    webPreferences: { sandbox: true, contextIsolation: true }
  })
  host.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  host.webContents.on('will-navigate', (e) => e.preventDefault())
  host.on('page-title-updated', (e) => e.preventDefault())
  loadAddressBar(host)

  const view = new WebContentsView({ webContents: options.webContents })
  const page = view.webContents
  host.contentView.addChildView(view)
  const layOut = (): void => {
    const [w, h] = host.getContentSize()
    view.setBounds({
      x: 0,
      y: ADDRESS_BAR_HEIGHT,
      width: w,
      height: Math.max(0, h - ADDRESS_BAR_HEIGHT)
    })
  }
  layOut()
  host.on('resize', layOut)

  const refusedHosts = new Set<string>()
  const showAddress = (): void => {
    if (host.isDestroyed() || page.isDestroyed()) return
    const url = page.getURL()
    const refused = refusedHosts.has(hostOf(url) ?? '')
    const state = { url, security: addressSecurity(url, refused) }
    void host.webContents.executeJavaScript(`show(${JSON.stringify(state)})`).catch(() => {})
  }
  // PLATFORM§8
  page.on('certificate-error', (_e, url, _error, _cert, _callback, isMainFrame) => {
    const refused = isMainFrame ? hostOf(url) : null
    if (refused) refusedHosts.add(refused)
  })
  host.webContents.on('did-finish-load', showAddress)
  page.on('did-navigate', showAddress)
  page.on('did-navigate-in-page', (_e, _url, isMainFrame) => {
    if (isMainFrame) showAddress()
  })
  page.on('did-fail-load', (_e, _code, _desc, _url, isMainFrame) => {
    if (isMainFrame) showAddress()
  })
  page.on('page-title-updated', (_e, title) => {
    if (!host.isDestroyed()) host.setTitle(title)
  })
  // PLATFORM§8
  page.on('content-bounds-updated', (_e, bounds) => {
    if (!host.isDestroyed()) host.setBounds(bounds)
  })
  page.once('destroyed', () => {
    if (!host.isDestroyed()) host.close()
  })
  // PLATFORM§8
  host.on('closed', () => {
    if (!page.isDestroyed()) page.close()
  })
  if (show)
    host.once('ready-to-show', () => {
      host.show()
      if (!page.isDestroyed()) page.focus()
    })
  return { host, page }
}
