import { BrowserWindow, WebContentsView, type WebContents } from 'electron'
import { ICON_PATHS } from '../renderer/src/icons/paths'

export const ADDRESS_BAR_HEIGHT = 36
const BROWSER_WINDOW_DEFAULT_SIZE = { width: 800, height: 600 }

export type AddressSecurity = 'secure' | 'not-secure' | 'plain'

export function addressSecurity(url: string, certificateRefused: boolean): AddressSecurity {
  if (certificateRefused) return 'not-secure'
  if (/^https:/i.test(url)) return 'secure'
  if (/^http:/i.test(url)) return 'not-secure'
  return 'plain'
}

function icon(name: keyof typeof ICON_PATHS): string {
  return `<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="${ICON_PATHS[name]}"/></svg>`
}

const BAR_PAGE = `<!doctype html>
<html><head><meta charset="utf-8"><title>Address</title>
<style>
:root { --bg-1: #161618; --bg-2: #1c1c1f; --line: rgba(255, 255, 255, 0.1); --fg: #f3f1ee; --fg-faint: #908b84; --red: #d9776a;
  --font: -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif;
  --mono: 'SF Mono', 'JetBrains Mono', Menlo, monospace; }
html, body { margin: 0; height: 100%; overflow: hidden; background: var(--bg-2); color: var(--fg); font: 12.5px var(--font); }
.baddr { box-sizing: border-box; display: flex; align-items: center; height: ${ADDRESS_BAR_HEIGHT}px; padding: 0 9px; border-bottom: 1px solid var(--line); }
.url { box-sizing: border-box; display: flex; align-items: center; gap: 6px; flex: 1; min-width: 0; height: 26px; padding: 0 10px; background: var(--bg-1); border: 1px solid var(--line); border-radius: 7px; }
.badge { display: none; align-items: center; gap: 4px; flex: none; color: var(--fg-faint); }
.badge.on { display: flex; }
#not-secure { color: var(--red); }
input { flex: 1; min-width: 0; border: 0; outline: 0; padding: 0; background: transparent; color: inherit; font: 12.5px var(--mono); cursor: text; }
</style></head>
<body><div class="baddr"><div class="url">
<span id="secure" class="badge" role="img" aria-label="Connection is secure">${icon('lock')}</span>
<span id="not-secure" class="badge">${icon('warning')}<span>Not secure</span></span>
<input id="address" aria-label="Address" readonly spellcheck="false">
</div></div>
<script>
function show(s) {
  document.getElementById('address').value = s.url
  document.getElementById('secure').classList.toggle('on', s.security === 'secure')
  document.getElementById('not-secure').classList.toggle('on', s.security === 'not-secure')
}
</script></body></html>`

const BAR_URL = `data:text/html;charset=utf-8,${encodeURIComponent(BAR_PAGE)}`

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
  void host.loadURL(BAR_URL)

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

  let refusedUrl: string | null = null
  const showAddress = (): void => {
    if (host.isDestroyed() || page.isDestroyed()) return
    const url = page.getURL()
    const state = { url, security: addressSecurity(url, url === refusedUrl) }
    void host.webContents.executeJavaScript(`show(${JSON.stringify(state)})`).catch(() => {})
  }
  // PLATFORM§8
  page.on('certificate-error', (_e, url, _error, _cert, _callback, isMainFrame) => {
    if (isMainFrame) refusedUrl = url
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
  host.on('close', (e) => {
    if (page.isDestroyed()) return
    e.preventDefault()
    page.close({ waitForBeforeUnload: true })
  })
  if (show)
    host.once('ready-to-show', () => {
      host.show()
      if (!page.isDestroyed()) page.focus()
    })
  return { host, page }
}
