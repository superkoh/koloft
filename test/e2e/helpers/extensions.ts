import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { expect } from './app'
import type { E2EEnv } from './env'

export const EXT_INSTALL_DIRS_ENV = 'KOLOFT_EXT_INSTALL_DIRS'

export const PROBE = {
  injected: 'data-koloft-bb-probe',
  storage: 'data-koloft-bb-storage',
  storageWritten: 'data-koloft-bb-storage-write',
  sync: 'data-koloft-bb-sync',
  syncLocal: 'data-koloft-bb-sync-local',
  syncAlive: 'data-koloft-bb-sync-alive',
  popup: 'data-koloft-bb-popup',
  extPage: 'data-koloft-bb-extpage'
} as const

export const EXT = {
  actionRow: '.wb-panel .baddr .bext',
  action: '.wb-panel .baddr .bext button:not([aria-label="Extensions"])',
  badge: '.bext-badge',
  overflow: '.wb-panel .baddr .bext [aria-label="Extensions"]',
  overflowMenu: '.bext-menu',
  nav: '.set-ni',
  row: '.ext-row',
  rowName: '.ext-name',
  rowVersion: '.ext-ver',
  empty: '.ext-empty',
  confirm: '.ext-confirm',
  store: '.wovl',
  storeGuest: '.wovl .bguest',
  storeClose: '.wovl [aria-label="Close"]'
} as const

const PROBES_DIR = path.join(__dirname, '..', 'fixtures', 'ext-probes')

export interface StagedExtension {
  dir: string
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

export function stageExtension(
  env: E2EEnv,
  variant: string,
  opts: { name?: string; config?: Record<string, string> } = {}
): StagedExtension {
  const root = path.join(env.home, 'ext-staged')
  fs.mkdirSync(root, { recursive: true })
  // PLATFORM§15
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

export function installExtensions(env: E2EEnv, extensions: StagedExtension[]): void {
  env.launchEnv[EXT_INSTALL_DIRS_ENV] = extensions.map((e) => e.dir).join(':')
}

export function clearInstallSeam(env: E2EEnv): void {
  delete env.launchEnv[EXT_INSTALL_DIRS_ENV]
}

export function actionRow(page: Page): Locator {
  return page.locator(EXT.actionRow)
}

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

export async function badgeText(page: Page, name: string): Promise<string> {
  const badge = extBadge(page, name)
  if ((await badge.count()) === 0) return ''
  return (await badge.innerText()).trim()
}

export async function openSettings(page: Page): Promise<void> {
  await page.locator('.tb-ico[title="Settings"]').click()
  await expect(page.locator('.modal').first()).toBeVisible({ timeout: 20_000 })
}

export async function closeSettings(page: Page): Promise<void> {
  await page.keyboard.press('Escape')
  await expect(page.locator('.modal')).toHaveCount(0, { timeout: 20_000 })
}

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

export function confirmButton(page: Page, label: string): Locator {
  return page.locator(`${EXT.confirm} [aria-label="${label}"]`)
}

export async function toggleIsOn(page: Page, name: string): Promise<boolean> {
  return extToggle(page, name).evaluate(
    (el) =>
      el.getAttribute('aria-checked') === 'true' ||
      (el as HTMLInputElement).checked === true ||
      el.classList.contains('on')
  )
}

export function rootAttr(target: Page, attr: string): Promise<string | null> {
  return target.evaluate((a) => document.documentElement.getAttribute(a), attr)
}

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

const NOT_POPUP_TYPES: string[] = ['serviceWorker', 'backgroundPage', 'worker', 'webview']

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

export function extensionPopupBounds(app: ElectronApplication): Promise<Bounds | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) =>
      w.webContents.getURL().startsWith('chrome-extension://')
    )
    return win ? win.getBounds() : null
  })
}

export async function waitForPopupBounds(
  app: ElectronApplication,
  timeout = 30_000
): Promise<Bounds> {
  await expect.poll(async () => (await extensionPopupBounds(app)) !== null, { timeout }).toBe(true)
  const bounds = await extensionPopupBounds(app)
  if (!bounds) throw new Error('extension popup window vanished between polls')
  return bounds
}

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

export function popupKeyTarget(app: ElectronApplication, page: Page): Page {
  return app.windows().find((w) => w.url().startsWith('chrome-extension://')) ?? page
}

export function hostContentBounds(app: ElectronApplication): Promise<Bounds> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) =>
      /out\/renderer\/index\.html/.test(w.webContents.getURL())
    )
    if (!win) throw new Error('no host window')
    return win.getContentBounds()
  })
}
