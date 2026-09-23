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

/**
 * THE extension platform layer (design §05, D8/D9/D10 — the browser-extensions design
 * is retired). Everything Chrome-extension about Koloft is scoped to the
 * browser partition from here: the host window, Preview's viewer and every pty surface
 * live on the default session and are never reached.
 *
 * The install store is Chromium's own shape — `<userData>/Extensions/` — so a Web Store
 * install (M3) and a dir handed in through the §07 seam land in one registry, and both
 * come back on the next launch from the directory alone.
 *
 * Honest platform boundary (§06, kept here so it survives the doc): capability is
 * whatever electron-chrome-extensions really implements — no chrome.commands (global
 * shortcuts), no declarativeNetRequest (MV3 ad blockers degraded), no sidePanel or
 * new-tab takeover; storage.sync degrades to local in SW/extension pages and
 * soft-fails (lastError) in content scripts — measured, the Electron binding layer
 * cannot shim it. The management pane promises no compatibility: an installed
 * extension that doesn't work is expected, not a bug. Firefox/Safari extensions are
 * out; extensions never reach the Preview viewer or Koloft's own UI. Signing/notarization,
 * Touch ID pairing, the iCloud-passwords allowlist PR: tracked as follow-ups.
 */

export interface ManagedExtension {
  id: string
  name: string
  version: string
  /** absolute path of the loaded (or last loaded) extension directory */
  path: string
  enabled: boolean
}

/** §07 seam: absolute unpacked-extension dirs, ':' separated, installed on startup. */
const INSTALL_DIRS_ENV = 'KOLOFT_EXT_INSTALL_DIRS'

/** D1: the only place an extension comes from — opened as a Browser tab, never outside. */

/** R7 (index.ts's own BACKGROUND_TEST): an automated run happens on the developer's live
 *  machine, so nothing here may take the screen. The action popup is the one surface in
 *  this module that is a real OS window. */
const BACKGROUND_TEST = process.env.KOLOFT_TEST_BACKGROUND === '1'

/** Where a disabled extension waits: Electron has no disabled state, so switching one
 *  off unloads it, and only Koloft still knows it is installed. */
const disabled = new Map<string, ManagedExtension>()
const changeListeners = new Set<() => void>()

let extensions: ElectronChromeExtensions | null = null

/** What the UI layer lends the platform: the window every extension surface hangs off,
 *  the way into the Browser strip (D6), and the way onto the screen (D7). */
export interface ExtensionHost {
  window(): BrowserWindow | null
  /** D6: put this url in the CURRENT session's strip as a user action — active at once,
   *  no agent unread dot. False when the strip never took it: no session to put it in,
   *  or a url the routing table refuses. */
  openTab(url: string): Promise<WebContents | null>
  /** D7: ask the user; the verdict comes back through `answerPermissionRequest`. */
  ask(request: ExtensionPermissionRequest): void
}

let host: ExtensionHost | null = null

function browserSession(): Session {
  return session.fromPartition(BROWSER_PARTITION)
}

function extensionsPath(): string {
  return path.join(app.getPath('userData'), 'Extensions')
}

// ---- the seam's install layer ------------------------------------------------------

/**
 * The dirs the seam names, as this process can act on them: absolute only (a relative
 * path means nothing to a spawned app), each spelling of one dir collapsed to a single
 * install, order preserved.
 */
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

/**
 * Where a source dir is staged inside the store. Keyed by the source path, which is
 * what makes an install idempotent across relaunches AND keeps two copies of one probe
 * apart — an unpacked extension's id is derived from the path it is loaded from, so a
 * stable staged path is a stable extension id.
 */
export function seamStageDir(store: string, sourceDir: string): string {
  const key = crypto.createHash('sha256').update(sourceDir).digest('hex').slice(0, 16)
  return path.join(store, `unpacked-${key}`)
}

/**
 * Install one unpacked dir into the store, by copying: the source may be anywhere, and
 * an install has to outlive it. Returns the staged path, or null when the dir is not an
 * extension. Already staged is left untouched — re-copying would wipe whatever the
 * extension has written into its own directory since.
 */
export function stageSeamExtension(store: string, sourceDir: string): string | null {
  try {
    if (!fs.statSync(sourceDir).isDirectory()) return null
    if (!fs.statSync(path.join(sourceDir, 'manifest.json')).isFile()) return null
  } catch {
    return null
  }
  const dest = seamStageDir(store, sourceDir)
  if (fs.existsSync(dest)) return dest
  // staged aside and moved into place, so a copy that dies half way never leaves a
  // directory the loader would read as an installed extension
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

/**
 * The directory an uninstall may remove: the extension's own folder under the store —
 * for a Web Store install the id dir, versions and all, not just the loaded version.
 * Null for an extension living outside the store, which Koloft did not put there.
 */
export function installedRoot(store: string, extensionPath: string): string | null {
  const rel = path.relative(store, extensionPath)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return path.join(store, rel.split(path.sep)[0])
}

// ---- the disabled set, as it survives a relaunch -------------------------------------

/**
 * Electron has no disabled state: switching an extension off UNLOADS it, so after a
 * relaunch the loader would find its directory and bring it back on. The off switches
 * are therefore Koloft's own record, kept beside the extensions they refer to.
 */
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

/** The extensions to unload again on startup. A row whose directory is gone is dropped:
 *  the extension was uninstalled from under Koloft, and an off switch for something that is
 *  no longer installed would list a row nothing can ever turn back on. */
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

// ---- the query / mutation face (IPC lands on this in M3) ----------------------------

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
    // out of the map BEFORE the load that makes it true: `extension-loaded` announces the
    // registry mid-await, and an extension both loaded and recorded as off is two rows
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

/** Fires whenever the installed set or one extension's on/off state changes. */
export function onExtensionsChanged(listener: () => void): () => void {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

function notifyChanged(): void {
  for (const listener of changeListeners) listener()
}

// ---- the current tab, the popup, the new tab, the permission ask (D4–D7) -------------

/** How long `chrome.tabs.create` waits for the strip to report the guest it made. */
const GUEST_REPORT_TIMEOUT_MS = 15_000

/** The gap between the address bar and the floater under it, upstream's own. */
const POPUP_GAP = 5

/** The popup the library opened for the action last clicked, while it is up (D5). */
interface ActionPopup {
  browserWindow?: BrowserWindow
  destroy(): void
  isDestroyed(): boolean
}
let popup: ActionPopup | null = null

/** Where the next popup hangs, as the action row measured it (D5). */
let popupAnchor: ExtensionPopupAnchor | null = null

/**
 * The action row is about to activate an extension: here is where that extension's
 * popup hangs (D5), and this is the last moment before the platform is asked to answer
 * against a current tab (D4) — which is why the stand-in, if one is needed at all, is
 * made here and not a moment sooner.
 */
export function beforeActivate(rect: ExtensionPopupAnchor): void {
  popupAnchor = rect
  const win = host?.window()
  if (win && !win.isDestroyed() && !liveGuest()) standInTab(win)
}

/**
 * D5/figure 2: put the floater under the icon that raised it — its RIGHT edge meeting the
 * icon's, its top edge clearing the bar the icon sits in. The formula is upstream's, so
 * nothing jumps when upstream's own placement lands, but the timing is not: upstream
 * places the window only once the extension's page has reported a preferred size, which
 * is several frames after the window exists and never at all for a page that reports
 * none. Called again on every resize, because a right-aligned edge depends on the width.
 */
function placePopup(view: ActionPopup): void {
  const win = host?.window()
  const floater = view.browserWindow
  if (!win || win.isDestroyed() || !popupAnchor || !floater || floater.isDestroyed()) return
  const frame = win.getBounds()
  const content = win.getContentBounds()
  const bounds = floater.getBounds()
  const x = Math.floor(frame.x + popupAnchor.x + popupAnchor.width - bounds.width)
  const y = Math.floor(
    frame.y + (frame.height - content.height) + popupAnchor.y + popupAnchor.height + POPUP_GAP
  )
  if (bounds.x === x && bounds.y === y) return
  floater.setBounds({ ...bounds, x, y })
}

/**
 * D4's other half: every action a user clicks is answered against the extension
 * platform's CURRENT TAB, and upstream refuses outright when there is none. Koloft's
 * Browser legitimately has none — a session's surface opens on 「No page open yet」 —
 * so an empty strip is represented to extensions by this blank page. It is made only
 * when an action is actually activated over an empty strip, and a real guest takes its
 * place the moment one reports; nothing renders it, and it is not a window.
 */
let standIn: WebContentsView | null = null

/** The guest the strip last reported as backing its current tab (D4), and the url the
 *  strip's tab carries — what tells one pending `chrome.tabs.create` from another. */
let reportedGuest: WebContents | null = null
let reportedUrl = ''

function trimTarget(url: string): string {
  const raw = url.trim()
  return raw.length > 1 ? raw.replace(/\/+$/, '') : raw
}

/**
 * Whether the tab the strip just reported is the one a `chrome.tabs.create` asked for.
 * The url Koloft opened is the identity — resolving every waiter with whatever reported
 * next hands the wrong WebContents to the wrong caller — allowing for the trailing slash
 * a bare origin grows and for a page that has already moved on to somewhere under it.
 */
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
  // removed from the tab list BEFORE the destroy, so the platform never holds a dead one
  extensions?.removeTab(view.webContents)
  view.webContents.close()
}

/**
 * D4: which Browser tab the extensions see as active is the renderer's word — main can
 * tell a guest from a page, but only the strip knows which tab of which session is on
 * screen. `webContentsId` is 0 when the current session's strip has no live guest.
 */
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

/**
 * The strip could not take the open at all — no session owns the tab the request was
 * addressed to. Whoever is waiting for that url is told now rather than sitting out the
 * full report timeout for a tab that is never going to exist.
 */
export function reportOpenDropped(url: string): void {
  for (const waiter of [...guestWaiters]) {
    if (!sameTabTarget(waiter.url, url)) continue
    guestWaiters.delete(waiter)
    waiter.settle(null)
  }
}

/**
 * D5: the floater closes on Esc and on a click anywhere outside it. Both arrive as this
 * call rather than through a key/blur handler here — upstream's blur fires when another
 * APP takes the focus, not when the user clicks elsewhere in Koloft, and main's own
 * `before-input-event` is fed by native input alone, so an Esc that lands in the popup's
 * document is reported by the script Koloft runs there (src/preload/extAlias.ts).
 */
export function dismissActionPopup(): void {
  const view = popup
  popup = null
  if (view && !view.isDestroyed()) view.destroy()
}

/** D7: the user's verdict on one runtime permission request. */
export function answerPermissionRequest(id: string, granted: boolean): void {
  const resolve = permissionAsks.get(id)
  if (!resolve) return
  permissionAsks.delete(id)
  resolve(granted)
}

/**
 * The window that was asked is gone — reloaded or closed — and with it every modal on
 * screen. An extension stopped inside its own call would otherwise wait forever, so the
 * unanswered ask becomes the refusal a dismissed modal already is (D7).
 */
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

/**
 * The guest backing the tab `url` was opened in. The strip may already be on it — a
 * `chrome.tabs.create` for the page that is on screen dedups into the active tab and
 * mints nothing — so the current report is the first thing consulted, and only then is
 * the next one waited for.
 */
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

/**
 * D6: `chrome.tabs.create` lands in the current session's strip as a user action, and
 * the platform is owed the guest that came of it. The strip mints the guest, so the
 * answer is the report it sends back (`reportActiveGuest`) — the new tab is active at
 * once, which is exactly the report that follows.
 */
async function createTab(details: { url?: string }): Promise<[WebContents, Electron.BaseWindow]> {
  const win = host?.window()
  if (!win || win.isDestroyed()) throw new Error('no window to open an extension tab in')
  const url = typeof details.url === 'string' ? details.url.trim() : ''
  // openTab returns the guest it made (matched on the routed target); no second await
  // on the raw url, which a routing rewrite would never match (review)
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

/** The strings of one manifest list and nothing else: a Web Store response is network
 *  input, and a summary that cannot be read is not a reason to fail the install. */
function permissionStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/**
 * §04 figure 4: what the install confirmation says about the extension the store is offering.
 * The manifest is the whole source (D7), and it spells both permission lists — and even
 * the version — at its own discretion.
 */
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

/**
 * D7/§04 figure 4: the Web Store page's own "Add to Chrome" is stopped inside this hook
 * until the user has read what the extension asks for. Upstream's `beforeInstall` is
 * the sanctioned seam, so the store's install flow stays entirely upstream's — Koloft only
 * supplies the verdict, through the same modal a running extension's ask goes to.
 */
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

// ---- startup ------------------------------------------------------------------------

/** Every Browser guest the platform has been told about, so the two ways in — the
 *  creation hook and the backfill below — never register one twice. */
const adoptedGuests = new WeakSet<WebContents>()

function adoptGuest(contents: WebContents): void {
  const win = host?.window()
  if (!extensions || !win || win.isDestroyed()) return
  if (contents.isDestroyed() || adoptedGuests.has(contents)) return
  adoptedGuests.add(contents)
  extensions.addTab(contents, win)
  contents.on('focus', () => extensions?.selectTab(contents))
}

/**
 * The platform starts asynchronously, and a restored session's Browser tabs do not wait
 * for it: every guest minted before the constructor resolved missed the creation hook
 * and is a page the extensions cannot see. They are taken in the moment there is
 * something to take them into.
 */
function adoptExistingGuests(ses: Session): void {
  for (const contents of webContents.getAllWebContents()) {
    if (contents.isDestroyed()) continue
    if (contents.getType() !== 'webview' || contents.session !== ses) continue
    adoptGuest(contents)
  }
}

export function setupExtensions(extensionHost: ExtensionHost): void {
  const ses = browserSession()
  const store = extensionsPath()
  host = extensionHost

  // D4's first half, and all main can decide on its own: a Browser guest is a tab, and
  // the one the user last touched is the active one. Which tab the Koloft strip considers
  // current is the renderer's word, and reaches selectTab from the UI layer.
  app.on('web-contents-created', (_e, contents) => {
    if (contents.getType() !== 'webview' || contents.session !== ses) return
    adoptGuest(contents)
  })

  void (async () => {
    // deferred so this module stays importable without Electron's runtime, and so the
    // libraries' own startup cost lands after the window is on its way
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
    // D5: the popup is the library's own BrowserWindow; what Koloft owns is where it sits
    // and when it goes away.
    extensions.on('browser-action-popup-created', (view: ActionPopup) => {
      popup = view
      placePopup(view)
      const floater = view.browserWindow
      if (!floater) return
      floater.on('resize', () => placePopup(view))
      // the anchor is in the host window's coordinates, so the floater follows the
      // window it hangs off — a drag or a resize otherwise leaves it stranded
      const win = host?.window()
      const replace = (): void => placePopup(view)
      win?.on('move', replace)
      win?.on('resize', replace)
      floater.once('closed', () => {
        if (!win || win.isDestroyed()) return
        win.off('move', replace)
        win.off('resize', replace)
      })
      // R7: an automated run may never put a window on screen. The bounds math still
      // runs — the popup is a real window with real placement, it is simply not shown.
      if (BACKGROUND_TEST) floater.on('show', () => floater.hide())
    })
    // the action row lives in the host window, on the DEFAULT session — this is what
    // serves `crx://extension-icon/…` there, and it is per-session, not per-instance
    ElectronChromeExtensions.handleCRXProtocol(session.defaultSession)

    // D1/§04: 「Add to Chrome」 on a chromewebstore.google.com tab installs into the
    // store directory this registry already reads from — the only way an extension gets
    // in. Loading and updating stay Koloft's own below (the seam has to be staged before
    // anything is read, and the alias preload has to be registered before an extension's
    // service worker can start), so the library is left with the install path alone.
    await installChromeWebStore({
      session: ses,
      extensionsPath: store,
      loadExtensions: false,
      autoUpdate: false,
      beforeInstall: confirmInstall
    })
    // an install lands in Chromium's registry, not in anything Koloft was told about
    ses.extensions.on('extension-loaded', () => notifyChanged())
    // D9, and the order is the whole point: the lib patches `chrome` from its own
    // preloads, and this aliases `browser` onto the result.
    // TODO(M4): these preload files resolve out of node_modules, which a packaged app
    // does not ship — the copy into the asar is packaging work.
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

    // the registry IS the store directory: everything installed, however it got there,
    // comes back from here on every launch with no seam and no network
    await loadAllExtensions(ses, store, { allowUnpacked: true })
    // …including the ones the user switched off, which the loader has no notion of: they
    // are listed as installed and unloaded again straight away
    for (const off of readDisabledState(store)) {
      disabled.set(off.id, off)
      if (ses.extensions.getExtension(off.id)) ses.extensions.removeExtension(off.id)
    }
    notifyChanged()

    // D10: silent, and never something startup waits on — offline is the normal case
    updateExtensions(ses).catch(() => {})
  })().catch((err) => console.error('[koloft] extension platform failed to start:', err))
}
