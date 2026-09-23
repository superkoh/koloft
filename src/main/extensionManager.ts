import {
  app,
  session,
  webContents,
  WebContentsView,
  type BrowserWindow,
  type Session,
  type WebContents
} from 'electron'
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import type { ElectronChromeExtensions } from 'electron-chrome-extensions'
import {
  BROWSER_PARTITION,
  type ExtensionPermissionRequest,
  type ExtensionPopupAnchor
} from '@shared/types'

export interface ManagedExtension {
  id: string
  name: string
  version: string
  path: string
  enabled: boolean
}

const INSTALL_DIRS_ENV = 'KOLOFT_EXT_INSTALL_DIRS'

const BACKGROUND_TEST = process.env.KOLOFT_TEST_BACKGROUND === '1'

// PLATFORM§15
const disabled = new Map<string, ManagedExtension>()
const changeListeners = new Set<() => void>()

let extensions: ElectronChromeExtensions | null = null

export interface ExtensionHost {
  window(): BrowserWindow | null
  openTab(url: string): Promise<WebContents | null>
  ask(request: ExtensionPermissionRequest): void
}

let host: ExtensionHost | null = null

function browserSession(): Session {
  return session.fromPartition(BROWSER_PARTITION)
}

function extensionsPath(): string {
  return path.join(app.getPath('userData'), 'Extensions')
}

export function parseInstallDirs(raw: string | undefined): string[] {
  if (!raw) return []
  const seen = new Set<string>()
  const dirs: string[] = []
  for (const entry of raw.split(':')) {
    const trimmed = entry.trim()
    if (!trimmed || !path.isAbsolute(trimmed)) continue
    const normalized = path.normalize(trimmed)
    const dir = normalized.length > 1 ? normalized.replace(/\/+$/, '') : normalized
    if (seen.has(dir)) continue
    seen.add(dir)
    dirs.push(dir)
  }
  return dirs
}

// PLATFORM§15
export function seamStageDir(store: string, sourceDir: string): string {
  const key = crypto.createHash('sha256').update(sourceDir).digest('hex').slice(0, 16)
  return path.join(store, `unpacked-${key}`)
}

export function stageSeamExtension(store: string, sourceDir: string): string | null {
  try {
    if (!fs.statSync(sourceDir).isDirectory()) return null
    if (!fs.statSync(path.join(sourceDir, 'manifest.json')).isFile()) return null
  } catch {
    return null
  }
  const dest = seamStageDir(store, sourceDir)
  if (fs.existsSync(dest)) return dest
  const pending = `${dest}.partial`
  try {
    fs.rmSync(pending, { recursive: true, force: true })
    fs.mkdirSync(store, { recursive: true })
    fs.cpSync(sourceDir, pending, { recursive: true })
    fs.renameSync(pending, dest)
    return dest
  } catch (err) {
    console.error(`[koloft] failed to install extension from ${sourceDir}:`, err)
    fs.rmSync(pending, { recursive: true, force: true })
    return null
  }
}

export function installedRoot(store: string, extensionPath: string): string | null {
  const rel = path.relative(store, extensionPath)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return path.join(store, rel.split(path.sep)[0])
}

export function disabledStatePath(store: string): string {
  return path.join(store, 'koloft-disabled.json')
}

function disabledRow(value: unknown): ManagedExtension | null {
  const row = value as Partial<ManagedExtension> | null
  if (!row || typeof row !== 'object') return null
  if (typeof row.id !== 'string' || !row.id) return null
  if (typeof row.path !== 'string' || !row.path) return null
  return {
    id: row.id,
    name: typeof row.name === 'string' ? row.name : row.id,
    version: typeof row.version === 'string' ? row.version : '',
    path: row.path,
    enabled: false
  }
}

export function readDisabledState(store: string): ManagedExtension[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(fs.readFileSync(disabledStatePath(store), 'utf8'))
  } catch {
    return []
  }
  if (!Array.isArray(parsed)) return []
  const rows: ManagedExtension[] = []
  for (const entry of parsed) {
    const row = disabledRow(entry)
    if (row && fs.existsSync(row.path)) rows.push(row)
  }
  return rows
}

export function writeDisabledState(store: string, rows: ManagedExtension[]): void {
  try {
    fs.mkdirSync(store, { recursive: true })
    fs.writeFileSync(disabledStatePath(store), JSON.stringify(rows, null, 2))
  } catch (err) {
    console.error('[koloft] failed to record the disabled extensions:', err)
  }
}

function persistDisabled(): void {
  writeDisabledState(extensionsPath(), [...disabled.values()])
}

export function listExtensions(): ManagedExtension[] {
  const loaded = browserSession().extensions.getAllExtensions()
  const rows: ManagedExtension[] = loaded.map((ext) => ({
    id: ext.id,
    name: ext.name,
    version: ext.version,
    path: ext.path,
    enabled: true
  }))
  return [...rows, ...disabled.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export async function setExtensionEnabled(id: string, enabled: boolean): Promise<void> {
  const ses = browserSession()
  if (enabled) {
    const off = disabled.get(id)
    if (!off) return
    // PLATFORM§15
    disabled.delete(id)
    try {
      await ses.extensions.loadExtension(off.path)
    } catch (err) {
      disabled.set(id, off)
      throw err
    }
  } else {
    const on = ses.extensions.getExtension(id)
    if (!on) return
    disabled.set(id, {
      id: on.id,
      name: on.name,
      version: on.version,
      path: on.path,
      enabled: false
    })
    ses.extensions.removeExtension(id)
  }
  persistDisabled()
  notifyChanged()
}

export function uninstallExtension(id: string): void {
  const ses = browserSession()
  const loaded = ses.extensions.getExtension(id)
  const known = loaded ?? disabled.get(id)
  if (!known) return
  if (loaded) ses.extensions.removeExtension(id)
  disabled.delete(id)
  const root = installedRoot(extensionsPath(), known.path)
  if (root) fs.rmSync(root, { recursive: true, force: true })
  persistDisabled()
  notifyChanged()
}

export function onExtensionsChanged(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

function notifyChanged(): void {
  for (const listener of changeListeners) listener()
}

const GUEST_REPORT_TIMEOUT_MS = 15_000

const UPSTREAM_POPUP_GAP_PX = 5

interface ActionPopup {
  browserWindow?: BrowserWindow
  destroy(): void
  isDestroyed(): boolean
}
let popup: ActionPopup | null = null

let popupAnchor: ExtensionPopupAnchor | null = null

export function beforeActivate(rect: ExtensionPopupAnchor): void {
  popupAnchor = rect
  const win = host?.window()
  if (win && !win.isDestroyed() && !liveGuest()) standInTab(win)
}

// PLATFORM§15
function placePopup(view: ActionPopup): void {
  const win = host?.window()
  const floater = view.browserWindow
  if (!win || win.isDestroyed() || !popupAnchor || !floater || floater.isDestroyed()) return
  const frame = win.getBounds()
  const content = win.getContentBounds()
  const bounds = floater.getBounds()
  const x = Math.floor(frame.x + popupAnchor.x + popupAnchor.width - bounds.width)
  const y = Math.floor(
    frame.y +
      (frame.height - content.height) +
      popupAnchor.y +
      popupAnchor.height +
      UPSTREAM_POPUP_GAP_PX
  )
  if (bounds.x === x && bounds.y === y) return
  floater.setBounds({ ...bounds, x, y })
}

// PLATFORM§15
let standIn: WebContentsView | null = null

let reportedGuest: WebContents | null = null
let reportedUrl = ''

function trimTarget(url: string): string {
  const raw = url.trim()
  return raw.length > 1 ? raw.replace(/\/+$/, '') : raw
}

export function sameTabTarget(want: string, got: string): boolean {
  const a = trimTarget(want)
  const b = trimTarget(got)
  if (!a || !b) return false
  return b === a || b.startsWith(`${a}/`) || b.startsWith(`${a}?`) || b.startsWith(`${a}#`)
}

interface GuestWaiter {
  url: string
  settle(guest: WebContents | null): void
}
const guestWaiters = new Set<GuestWaiter>()
const permissionAsks = new Map<string, (granted: boolean) => void>()

function liveGuest(): WebContents | null {
  if (reportedGuest && !reportedGuest.isDestroyed()) return reportedGuest
  reportedGuest = null
  return null
}

function standInTab(win: BrowserWindow): void {
  if (!extensions) return
  if (!standIn || standIn.webContents.isDestroyed()) {
    standIn = new WebContentsView({ webPreferences: { session: browserSession(), sandbox: true } })
    void standIn.webContents.loadURL('about:blank')
  }
  extensions.addTab(standIn.webContents, win)
  extensions.selectTab(standIn.webContents)
}

function releaseStandIn(): void {
  const view = standIn
  standIn = null
  if (!view || view.webContents.isDestroyed()) return
  extensions?.removeTab(view.webContents)
  view.webContents.close()
}

export function reportActiveGuest(webContentsId: number, url: string): void {
  const win = host?.window()
  if (!extensions || !win || win.isDestroyed()) return
  const guest = webContentsId > 0 ? webContents.fromId(webContentsId) : null
  if (!guest || guest.isDestroyed() || guest.session !== browserSession()) {
    reportedGuest = null
    reportedUrl = ''
    return
  }
  reportedGuest = guest
  reportedUrl = url
  extensions.selectTab(guest)
  releaseStandIn()
  for (const waiter of [...guestWaiters]) {
    if (!sameTabTarget(waiter.url, url)) continue
    guestWaiters.delete(waiter)
    waiter.settle(guest)
  }
}

export function reportOpenDropped(url: string): void {
  for (const waiter of [...guestWaiters]) {
    if (!sameTabTarget(waiter.url, url)) continue
    guestWaiters.delete(waiter)
    waiter.settle(null)
  }
}

// PLATFORM§15
export function dismissActionPopup(): void {
  const view = popup
  popup = null
  if (view && !view.isDestroyed()) view.destroy()
}

export function answerPermissionRequest(id: string, granted: boolean): void {
  const resolve = permissionAsks.get(id)
  if (!resolve) return
  permissionAsks.delete(id)
  resolve(granted)
}

function denyPendingAsks(): void {
  const waiting = [...permissionAsks.values()]
  permissionAsks.clear()
  for (const resolve of waiting) resolve(false)
}

const askedHosts = new WeakSet<WebContents>()

function watchAskHost(): void {
  const win = host?.window()
  if (!win || win.isDestroyed()) return
  const wc = win.webContents
  if (wc.isDestroyed() || askedHosts.has(wc)) return
  askedHosts.add(wc)
  wc.on('destroyed', denyPendingAsks)
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) denyPendingAsks()
  })
}

export function awaitGuestFor(url: string): Promise<WebContents | null> {
  const current = liveGuest()
  if (current && sameTabTarget(url, reportedUrl)) return Promise.resolve(current)
  return new Promise((resolve) => {
    const waiter: GuestWaiter = {
      url,
      settle: (guest) => {
        clearTimeout(timer)
        resolve(guest)
      }
    }
    const timer = setTimeout(() => {
      guestWaiters.delete(waiter)
      resolve(null)
    }, GUEST_REPORT_TIMEOUT_MS)
    guestWaiters.add(waiter)
  })
}

async function createTab(details: { url?: string }): Promise<[WebContents, Electron.BaseWindow]> {
  const win = host?.window()
  if (!win || win.isDestroyed()) throw new Error('no window to open an extension tab in')
  const url = typeof details.url === 'string' ? details.url.trim() : ''
  const guest = url ? await host?.openTab(url) : null
  if (!guest) throw new Error(`could not open '${url}' as a Browser tab`)
  return [guest, win]
}

function requestPermissions(
  extension: Electron.Extension,
  request: { permissions?: string[]; origins?: string[] }
): Promise<boolean> {
  if (!host) return Promise.resolve(false)
  const id = crypto.randomUUID()
  const ask: ExtensionPermissionRequest = {
    kind: 'permission',
    id,
    name: extension.name,
    permissions: request.permissions ?? [],
    origins: request.origins ?? []
  }
  return new Promise<boolean>((resolve) => {
    watchAskHost()
    permissionAsks.set(id, resolve)
    host?.ask(ask)
  })
}

function permissionStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

export function installAsk(
  askId: string,
  name: string,
  manifest: { version?: unknown; permissions?: unknown; host_permissions?: unknown }
): ExtensionPermissionRequest {
  return {
    kind: 'install',
    id: askId,
    name,
    version: typeof manifest.version === 'string' ? manifest.version : '',
    permissions: permissionStrings(manifest.permissions),
    origins: permissionStrings(manifest.host_permissions)
  }
}

function confirmInstall(details: {
  localizedName: string
  manifest: { version?: unknown; permissions?: unknown; host_permissions?: unknown }
}): Promise<{ action: 'allow' | 'deny' }> {
  if (!host) return Promise.resolve({ action: 'deny' as const })
  const id = crypto.randomUUID()
  return new Promise<boolean>((resolve) => {
    watchAskHost()
    permissionAsks.set(id, resolve)
    host?.ask(installAsk(id, details.localizedName, details.manifest))
  }).then((granted) => ({ action: granted ? ('allow' as const) : ('deny' as const) }))
}

const adoptedGuests = new WeakSet<WebContents>()

function adoptGuest(contents: WebContents): void {
  const win = host?.window()
  if (!extensions || !win || win.isDestroyed()) return
  if (contents.isDestroyed() || adoptedGuests.has(contents)) return
  adoptedGuests.add(contents)
  extensions.addTab(contents, win)
  contents.on('focus', () => extensions?.selectTab(contents))
}

function adoptExistingGuests(ses: Session): void {
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue
    if (contents.getType() !== 'webview' || contents.session !== ses) continue
    adoptGuest(contents)
  }
}

// PLATFORM§15
export function setupExtensions(extensionHost: ExtensionHost): void {
  const ses = browserSession()
  const store = extensionsPath()
  host = extensionHost

  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview' || contents.session !== ses) return
    adoptGuest(contents)
  })

  void (async () => {
    const { ElectronChromeExtensions } = await import('electron-chrome-extensions')
    const { installChromeWebStore, loadAllExtensions, updateExtensions } =
      await import('electron-chrome-web-store')

    extensions = new ElectronChromeExtensions({
      license: 'GPL-3.0',
      session: ses,
      createTab,
      requestPermissions
    })
    adoptExistingGuests(ses)
    extensions.on('browser-action-popup-created', (view: ActionPopup) => {
      popup = view
      placePopup(view)
      const floater = view.browserWindow
      if (!floater) return
      floater.on('resize', () => placePopup(view))
      const win = host?.window()
      const replace = (): void => placePopup(view)
      win?.on('move', replace)
      win?.on('resize', replace)
      floater.once('closed', () => {
        if (!win || win.isDestroyed()) return
        win.off('move', replace)
        win.off('resize', replace)
      })
      if (BACKGROUND_TEST) floater.on('show', () => floater.hide())
    })
    // PLATFORM§15
    ElectronChromeExtensions.handleCRXProtocol(session.defaultSession)

    await installChromeWebStore({
      session: ses,
      extensionsPath: store,
      loadExtensions: false,
      autoUpdate: false,
      beforeInstall: confirmInstall
    })
    ses.extensions.on('extension-loaded', () => notifyChanged())
    // PLATFORM§15
    for (const type of ['service-worker', 'frame'] as const) {
      ses.registerPreloadScript({
        id: `koloft-ext-alias-${type}`,
        type,
        filePath: path.join(__dirname, '../preload/extAlias.js')
      })
    }

    for (const dir of parseInstallDirs(process.env[INSTALL_DIRS_ENV])) {
      if (!stageSeamExtension(store, dir)) {
        console.error(`[koloft] ${INSTALL_DIRS_ENV}: not an unpacked extension: ${dir}`)
      }
    }

    await loadAllExtensions(ses, store, { allowUnpacked: true })
    for (const off of readDisabledState(store)) {
      disabled.set(off.id, off)
      if (ses.extensions.getExtension(off.id)) ses.extensions.removeExtension(off.id)
    }
    notifyChanged()

    updateExtensions(ses).catch(() => {})
  })().catch((err) => console.error('[koloft] extension platform failed to start:', err))
}
