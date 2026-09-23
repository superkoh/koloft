import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { expect } from './app'
import type { E2EEnv } from './env'

/**
 * The browser-extensions test kit
 *.
 *
 * Everything in this file is a CONTRACT authored by the cases, ahead of the feature:
 * the seam a test installs a probe extension through, the markup the new surfaces must
 * expose, and the fixture attributes the probes write. The implementation must follow
 * it; a spec never spells a selector itself.
 *
 * House conventions carried over from helpers/browser.ts: no data-testids, an
 * `aria-label` on every button, stable classes only where a container needs a name.
 *
 * ── the seam (§07 "probe seam") ────────────────────────────────────────────────
 *   KOLOFT_EXT_INSTALL_DIRS = absolute unpacked-extension dirs, ':' separated.
 * On startup the app installs each of them into its REAL extension registry:
 *   - idempotent, keyed by extension id — a dir already installed is not duplicated;
 *   - the result persists across relaunch WITHOUT the variable being set again;
 *   - the entries are listed / toggleable / uninstallable in Settings → Extensions,
 *     exactly like one installed from the Chrome Web Store.
 * It must be set BEFORE launchApp (argv/env is fixed at spawn time).
 */

export const EXT_INSTALL_DIRS_ENV = 'KOLOFT_EXT_INSTALL_DIRS'

/** Attributes the probe extensions write into a document (fixtures/ext-probes/). */
export const PROBE = {
  /** base: `<html data-koloft-bb-probe="<extension id>">` on every injected page */
  injected: 'data-koloft-bb-probe',
  /** storage-rw: the value read back on a `#read` page */
  storage: 'data-koloft-bb-storage',
  /** storage-rw: `done` once the `#write` page's write has landed */
  storageWritten: 'data-koloft-bb-storage-write',
  /** storage-sync: `softfail` when the sync call errored via lastError (the §06
   *  contract — sync is unavailable in content scripts but never throws) */
  sync: 'data-koloft-bb-sync',
  /** storage-sync: `ok` after a storage.local round trip made after the sync call */
  syncLocal: 'data-koloft-bb-sync-local',
  /** storage-sync: `1` once the script reached its last statement alive */
  syncAlive: 'data-koloft-bb-sync-alive',
  /** popup-browser-ns: `ok` once the popup script read `browser.runtime.id` */
  popup: 'data-koloft-bb-popup',
  /** ext-page: `ok` on the extension's own page */
  extPage: 'data-koloft-bb-extpage'
} as const

export const EXT = {
  /**
   * The action row inside the address bar; its left edge is the divider from the nav
   * controls (§03 figure 1: "grouped by thin dividers and nav buttons").
   *
   * the address bar is the `web` KIND's bar now, not the surface's, so the row is on
   * screen only while a `web` tab is active — on the pinned `files` tab there is no row at
   * all. A case therefore has to mint a web tab before it can reach an icon. That follows
   * from where an extension acts (a page) rather than from a decision about extensions.
   */
  actionRow: '.wb-panel .baddr .bext',
  /** one extension's action button, labelled with the extension's own name */
  action: '.wb-panel .baddr .bext button:not([aria-label="Extensions"])',
  /** the count/text badge an extension paints on its action */
  badge: '.bext-badge',
  /** the puzzle overflow entry — present only while more than 4 extensions are enabled */
  overflow: '.wb-panel .baddr .bext [aria-label="Extensions"]',
  /** the menu the puzzle opens, listing every extension by name */
  overflowMenu: '.bext-menu',
  /** Settings modal: one category row in the left nav (Extensions sits 4th, D2) */
  nav: '.set-ni',
  /** Settings → Extensions: one installed extension */
  row: '.ext-row',
  rowName: '.ext-name',
  rowVersion: '.ext-ver',
  /** the guidance shown where the list would be when nothing is installed (D1) */
  empty: '.ext-empty',
  /** the DOM modal (never a native dialog) used for install / permission / uninstall
   *  confirmation — .bmodal family, D7. Its buttons carry aria-labels:
   *  install "Install"/"Cancel", permission "Allow"/"Deny", uninstall "Uninstall"/"Cancel". */
  confirm: '.ext-confirm',
  /** §04 (user call): the Web Store's session-independent
   *  near-fullwindow overlay, its embedded guest, and its close control. R1:
   *  that overlay is now the app's one overlay component (helpers/browser.ts OVERLAY),
   *  with the store as a caller — the markup moved, the §04 ownership did not. */
  store: '.wovl',
  storeGuest: '.wovl .bguest',
  storeClose: '.wovl [aria-label="Close"]'
} as const

// ---- staging a probe extension ------------------------------------------------------

const PROBES_DIR = path.join(__dirname, '..', 'fixtures', 'ext-probes')

export interface StagedExtension {
  /** absolute path of the staged copy — what goes into KOLOFT_EXT_INSTALL_DIRS */
  dir: string
  /** the manifest name, i.e. the action button's and the list row's label */
  name: string
  version: string
}

function copyDir(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true })
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name)
    const dst = path.join(to, entry.name)
    if (entry.isDirectory()) copyDir(src, dst)
    else fs.copyFileSync(src, dst)
  }
}

/**
 * Stage a COPY of one fixtures/ext-probes variant under the test's own $HOME.
 *
 * Every call gets a fresh directory, which is what makes N probes distinguishable: an
 * unpacked extension's id is derived from its path, so two copies of the same variant
 * are two different extensions. `name` rewrites the manifest (and the action title with
 * it, so the label stays one string); `config` rewrites `config.js`, the only way to
 * hand a probe a fixture-server url that does not exist until the test is running.
 */
export function stageExtension(
  env: E2EEnv,
  variant: string,
  opts: { name?: string; config?: Record<string, string> } = {}
): StagedExtension {
  const root = path.join(env.home, 'ext-staged')
  fs.mkdirSync(root, { recursive: true })
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(root, `${variant}-`)))
  copyDir(path.join(PROBES_DIR, variant), dir)

  const manifestFile = path.join(dir, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as {
    name: string
    version: string
    action?: { default_title?: string }
  }
  if (opts.name !== undefined) {
    manifest.name = opts.name
    if (manifest.action) manifest.action.default_title = opts.name
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))
  }
  if (opts.config) {
    fs.writeFileSync(
      path.join(dir, 'config.js'),
      `self.KOLOFT_BB_CONFIG = ${JSON.stringify(opts.config)}\n`
    )
  }
  return { dir, name: manifest.name, version: manifest.version }
}

/** Point the seam at these unpacked dirs. Must run BEFORE launchApp. */
export function installExtensions(env: E2EEnv, extensions: StagedExtension[]): void {
  env.launchEnv[EXT_INSTALL_DIRS_ENV] = extensions.map((e) => e.dir).join(':')
}

/** Take the seam away — what a plain relaunch of an app that already has them looks like. */
export function clearInstallSeam(env: E2EEnv): void {
  delete env.launchEnv[EXT_INSTALL_DIRS_ENV]
}

// ---- the action row ------------------------------------------------------------------

export function actionRow(page: Page): Locator {
  return page.locator(EXT.actionRow)
}

/** Every extension action currently on the row (the overflow entry excluded). */
export function extActions(page: Page): Locator {
  return page.locator(EXT.action)
}

export function extAction(page: Page, name: string): Locator {
  return page.locator(`${EXT.actionRow} button[aria-label="${name}"]`)
}

export function extBadge(page: Page, name: string): Locator {
  return extAction(page, name).locator(EXT.badge)
}

export function extOverflow(page: Page): Locator {
  return page.locator(EXT.overflow)
}

export function extOverflowMenu(page: Page): Locator {
  return page.locator(EXT.overflowMenu)
}

/** The badge text an extension is showing, or '' when it has none. */
export async function badgeText(page: Page, name: string): Promise<string> {
  const badge = extBadge(page, name)
  if ((await badge.count()) === 0) return ''
  return (await badge.innerText()).trim()
}

// ---- Settings → Extensions -------------------------------------------------------------

/** The titlebar Settings button (multi-account.spec's entry point). */
export async function openSettings(page: Page): Promise<void> {
  await page.locator('.tb-ico[title="Settings"]').click()
  await expect(page.locator('.modal').first()).toBeVisible({ timeout: 20_000 })
}

export async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.locator('.modal')).toHaveCount(0, { timeout: 20_000 })
}

/** The category names in the Settings nav, in render order (D2's ordering oracle). */
export async function settingsNavItems(page: Page): Promise<string[]> {
  const texts = await page.locator(EXT.nav).allTextContents()
  return texts.map((t) => t.replace(/\s+/g, ' ').trim())
}

export async function openExtensionsPane(page: Page): Promise<void> {
  await openSettings(page)
  await page.locator(EXT.nav, { hasText: 'Extensions' }).click()
}

export function extRow(page: Page, name: string): Locator {
  return page.locator(EXT.row).filter({ has: page.locator(EXT.rowName, { hasText: name }) })
}

export function extToggle(page: Page, name: string): Locator {
  return page.locator(`${EXT.row} [aria-label="Toggle ${name}"]`)
}

export function extUninstall(page: Page, name: string): Locator {
  return page.locator(`${EXT.row} [aria-label="Uninstall ${name}"]`)
}

export function extConfirm(page: Page): Locator {
  return page.locator(EXT.confirm)
}

/** A confirm/deny button of the D7 modal, by its aria-label. */
export function confirmButton(page: Page, label: string): Locator {
  return page.locator(`${EXT.confirm} [aria-label="${label}"]`)
}

/** Whether the row's switch reads as on, in either shape a switch takes here. */
export async function toggleIsOn(page: Page, name: string): Promise<boolean> {
  return extToggle(page, name).evaluate(
    (el) =>
      el.getAttribute('aria-checked') === 'true' ||
      (el as HTMLInputElement).checked === true ||
      el.classList.contains('on')
  )
}

// ---- documents: guests, popups, windows -------------------------------------------------

/** A probe attribute on a loaded page's root element (null until the script ran). */
export function rootAttr(target: Page, attr: string): Promise<string | null> {
  return target.evaluate((a) => document.documentElement.getAttribute(a), attr)
}

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

/** webContents types that are never the popup: the SW, and an extension page rendered
 *  as a Browser tab (BB-C15). */
const NOT_POPUP_TYPES: string[] = ['serviceWorker', 'backgroundPage', 'worker', 'webview']

/** Live extension-popup documents (url each) — 0 once the popup has closed. */
export function extensionPopups(app: ElectronApplication): Promise<string[]> {
  return app.evaluate(
    ({ webContents }, excluded) =>
      webContents
        .getAllWebContents()
        .filter(
          (w) => w.getURL().startsWith('chrome-extension://') && !excluded.includes(w.getType())
        )
        .map((w) => w.getURL()),
    NOT_POPUP_TYPES
  )
}

/** The popup window's screen bounds, or null while no popup window exists. */
export function extensionPopupBounds(app: ElectronApplication): Promise<Bounds | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().startsWith('chrome-extension://')
    )
    return win ? win.getBounds() : null
  })
}

/** Wait for the popup floater and return its screen bounds. */
export async function waitForPopupBounds(
  app: ElectronApplication,
  timeout = 30_000
): Promise<Bounds> {
  await expect.poll(async () => (await extensionPopupBounds(app)) !== null, { timeout }).toBe(true)
  const bounds = await extensionPopupBounds(app)
  if (!bounds) throw new Error('extension popup window vanished between polls')
  return bounds
}

/** A probe attribute inside the popup document. Kit contract (pinned by conformance
 *  review): the D5 floater IS a BrowserWindow — one lookup shape shared with
 *  extensionPopupBounds, so BB-M03/M04 and BB-C13 judge the same thing. */
export function popupAttr(app: ElectronApplication, attr: string): Promise<string | null> {
  return app.evaluate(async ({ BrowserWindow }, attribute) => {
    const win = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().startsWith('chrome-extension://')
    )
    if (!win) return null
    return (await win.webContents.executeJavaScript(
      `document.documentElement.getAttribute(${JSON.stringify(attribute)})`
    )) as string | null
  }, attr)
}

/** Where a user's ESC lands while a popup is open: the popup itself when the harness
 *  can drive it as a page, otherwise the window it hangs off. */
export function popupKeyTarget(app: ElectronApplication, page: Page): Page {
  return app.windows().find((w) => w.url().startsWith('chrome-extension://')) ?? page
}

/** The host window's content rect in SCREEN coordinates — the offset that turns a
 *  Playwright bounding box into something comparable with a window's bounds. */
export function hostContentBounds(app: ElectronApplication): Promise<Bounds> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) =>
      /out\/renderer\/index\.html/.test(w.webContents.getURL())
    )
    if (!win) throw new Error('no host window')
    return win.getContentBounds()
  })
}
