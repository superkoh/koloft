import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import {
  chromium,
  type Browser,
  type ElectronApplication,
  type Locator,
  type Page
} from '@playwright/test'
import { expect } from './app'
import { centerTerm, readCalls, runIn } from './p1'
import type { E2EEnv } from './env'

export const BROWSER = {
  surface: '.wb-panel',
  tabStrip: '.wb-panel .wb-tabs',
  tab: '.wb-panel .wb-tab',
  tabOpen: '.wb-panel .wb-tab:not(.pinned)',
  tabPinned: '.wb-panel .wb-tab.pinned',
  tabLabel: '.lb',
  tabActive: '.wb-panel .wb-tab.on',
  tabAgent: '.wb-panel .wb-tab.agent',
  tabFrozen: '.wb-panel .wb-tab.frozen',
  tabClose: '.wb-tab .x',
  tabCloseIn: '.x',
  newTab: '.wb-panel .wb-new',
  newMenu: '.wb-newmenu',
  addressBar: '.wb-panel .baddr',
  addressField: '.wb-panel .baddr input, .wb-panel .baddr .url',
  suggestList: '.wb-panel .baddr .baddr-sugg',
  suggestRow: '.wb-panel .baddr .baddr-sugg .bext-mrow',
  progress: '.wb-panel .baddr .prog',
  errorPage: '.wb-panel .berror',
  retry: '.wb-panel .berror button',
  emptyState: '.wb-panel .bempty',
  crashPlaceholder: '.wb-panel .bcrash',
  certInterstitial: '.wb-panel .bcert',
  modal: '.bmodal',
  globe: '.aux-ico[aria-label="Workbench"]',
  surfaceState: '[data-surface]',
  permissionBar: '.wb-panel .bperm',
  permissionAllow: '.wb-panel .bperm .bperm-b.pri',
  permissionDeny: '.wb-panel .bperm .bperm-b:not(.pri)',
  permissionRefused: '.wb-panel .bperm.refused',
  downloadButton: '.wb-panel .baddr [aria-label="Downloads"]',
  downloadPanel: '.wb-panel .bdl',
  downloadRow: '.wb-panel .bdl .bdl-row',
  downloadClear: '.wb-panel .bdl .bdl-clear',
  overflowButton: '.wb-panel .baddr [aria-label="More"]',
  overflowMenu: '.wb-panel .bmenu',
  tabSpeaker: '.btab-spk',
  pageFullscreen: '.wb-panel.pagefull',
  kindAttr: '.wb-panel[data-kind]',

  drivenTab: '.wb-panel .wb-tab.driven',
  drivenBadge: '.wb-panel .bdriven',
  // PLATFORM§9
  stagedColumn: '.wb-col.staged',
  stagedGuest: '.wb-panel .bguest.staged'
} as const

export const OVERLAY = {
  root: '.wovl',
  guest: '.wovl .bguest',
  back: '.wovl [aria-label="Back"]',
  external: '.wovl [aria-label="Open in system browser"]',
  entry: '.titlebar [aria-label="Opened page"]',
  entryUnread: '.titlebar [aria-label="Opened page"].unread',
  modal: '.wovl .bmodal'
} as const

// PLATFORM§8
export async function overlayUrl(page: Page): Promise<string> {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel) as (HTMLElement & { getURL(): string }) | null
    try {
      return el?.getURL() ?? ''
    } catch {
      return ''
    }
  }, OVERLAY.guest)
}

export async function clickTerminalLink(
  page: Page,
  url: string,
  root = '.term-island'
): Promise<void> {
  const span = page.locator(`${root} .xterm-rows span`, { hasText: url }).last()
  await expect(span).toBeVisible({ timeout: 30_000 })
  let text = ''
  let box: { x: number; y: number; width: number; height: number } | null = null
  for (let i = 0; i < 40 && !box; i++) {
    text = (await span.textContent().catch(() => '')) ?? ''
    box = await span.boundingBox().catch(() => null)
    if (!box) await page.waitForTimeout(250)
  }
  if (!box) throw new Error(`the printed URL ${url} has no box`)
  const i = text.indexOf(url)
  const cw = box.width / Math.max(text.length, 1)
  const x = box.x + (i >= 0 ? cw * (i + url.length / 2) : box.width / 2)
  const y = box.y + box.height / 2
  // PLATFORM§18
  await page.mouse.move(x, y)
  await page.waitForTimeout(300)
  await page.mouse.click(x, y)
}

export type NavControl = 'Back' | 'Forward' | 'Reload' | 'Stop' | 'Open in system browser'

export const BROWSER_MENU_IDS = {
  toggle: 'toggle-browser',
  focusAddress: 'browser-focus-address',
  newTab: 'browser-new-tab',
  closeTab: 'browser-close-tab',
  reload: 'browser-reload',
  back: 'browser-back',
  forward: 'browser-forward',
  zoomIn: 'browser-zoom-in',
  zoomOut: 'browser-zoom-out',
  zoomReset: 'browser-zoom-reset',
  findInPage: 'find-in-page',
  focusMode: 'toggle-focus-mode',
  devtools: 'browser-devtools'
} as const

export function browserSurface(page: Page): Locator {
  return page.locator(BROWSER.surface)
}

export function browserTabs(page: Page): Locator {
  return page.locator(BROWSER.tab)
}

export function tabByTitle(page: Page, text: string | RegExp): Locator {
  return page.locator(BROWSER.tab).filter({ hasText: text })
}

export function activeTab(page: Page): Locator {
  return page.locator(BROWSER.tabActive)
}

export function agentTabs(page: Page): Locator {
  return page.locator(BROWSER.tabAgent)
}

export function frozenTabs(page: Page): Locator {
  return page.locator(BROWSER.tabFrozen)
}

export async function tabTitles(page: Page): Promise<string[]> {
  const texts = await page.locator(`${BROWSER.tab} ${BROWSER.tabLabel}`).allTextContents()
  return texts.map((t) => t.replace(/\s+/g, ' ').trim())
}

export function openTabs(page: Page): Locator {
  return page.locator(BROWSER.tabOpen)
}

export function pinnedTab(page: Page): Locator {
  return page.locator(BROWSER.tabPinned)
}

export async function activeKind(page: Page): Promise<string | null> {
  return page.locator(BROWSER.surface).first().getAttribute('data-kind')
}

export function globeIcon(page: Page): Locator {
  return page.locator(BROWSER.globe)
}

export async function globeHasUnread(page: Page): Promise<boolean> {
  return globeIcon(page).evaluate(
    (el) => el.classList.contains('unread') || el.querySelector('.unread') !== null
  )
}

// PLATFORM§10
export async function activeSurface(page: Page): Promise<string | null> {
  const el = page.locator(BROWSER.surfaceState).first()
  if ((await el.count()) === 0) return null
  return el.getAttribute('data-surface')
}

export async function openBrowser(page: Page): Promise<void> {
  if (await browserSurface(page).isVisible()) return
  await globeIcon(page).click()
  await expect(browserSurface(page)).toBeVisible({ timeout: 20_000 })
}

export async function closeBrowser(page: Page): Promise<void> {
  const col = page.locator('.wb-col')
  const columnOff = async (): Promise<boolean> =>
    (await col.count()) === 0 || (await col.first().evaluate((el) => el.classList.contains('off')))
  if (await columnOff()) return
  await globeIcon(page).click()
  await expect.poll(columnOff, { timeout: 20_000 }).toBe(true)
}

export async function newWebTab(page: Page): Promise<void> {
  await page.locator(BROWSER.newTab).click()
  await page.locator(`${BROWSER.newMenu} .mi`, { hasText: 'New web tab' }).click()
}

export function addressField(page: Page): Locator {
  return page.locator(BROWSER.addressField).first()
}

export async function addressValue(page: Page): Promise<string> {
  return addressField(page).evaluate((el) =>
    (el instanceof HTMLInputElement ? el.value : (el.textContent ?? '')).trim()
  )
}

export async function typeInAddressBar(
  page: Page,
  text: string,
  opts: { submit?: boolean } = {}
): Promise<void> {
  const field = addressField(page)
  await field.click()
  await field.fill(text)
  if (opts.submit !== false) await page.keyboard.press('Enter')
}

export function navButton(page: Page, which: NavControl): Locator {
  return page.locator(`${BROWSER.addressBar} [aria-label="${which}"]`)
}

export async function navDisabled(page: Page, which: NavControl): Promise<boolean> {
  return navButton(page, which).evaluate(
    (el) =>
      (el as HTMLButtonElement).disabled === true ||
      el.getAttribute('aria-disabled') === 'true' ||
      el.classList.contains('dis')
  )
}

export function isHostPage(p: Page): boolean {
  return /out\/renderer\/index\.html/.test(p.url())
}

export function guestPages(app: ElectronApplication): Page[] {
  return app.windows().filter((p) => !isHostPage(p))
}

export async function guestByUrl(
  app: ElectronApplication,
  match: string | RegExp,
  opts: { timeout?: number } = {}
): Promise<Page> {
  const deadline = Date.now() + (opts.timeout ?? 20_000)
  const hits = (u: string): boolean =>
    typeof match === 'string' ? u.includes(match) : match.test(u)
  for (;;) {
    const found = guestPages(app).find((p) => hits(p.url()))
    if (found) return found
    if (Date.now() > deadline) {
      const seen = app.windows().map((p) => p.url())
      throw new Error(`no guest page matching ${String(match)}; pages: ${JSON.stringify(seen)}`)
    }
    await new Promise((r) => setTimeout(r, 200))
  }
}

// PLATFORM§18
export async function guestType(guest: Page, selector: string, text: string): Promise<void> {
  const field = guest.locator(selector)
  await field.click()
  await field.fill(text)
  const landed = await field.inputValue().catch(() => '')
  if (landed !== text) {
    await field.click()
    await guest.keyboard.press('Meta+a')
    await guest.keyboard.type(text)
  }
}

export async function webviewAttrs(page: Page): Promise<Record<string, string>[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('webview')).map((el) => {
      const out: Record<string, string> = {}
      for (const a of Array.from(el.attributes)) out[a.name] = a.value
      return out
    })
  )
}

export interface GuestContents {
  id: number
  url: string
  // PLATFORM§13
  audible: boolean
  zoomFactor: number
  crashed: boolean
}

export async function guestContents(app: ElectronApplication): Promise<GuestContents[]> {
  return app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((w) => w.getType() === 'webview')
      .map((w) => ({
        id: w.id,
        url: w.getURL(),
        audible: w.isCurrentlyAudible(),
        zoomFactor: w.getZoomFactor(),
        crashed: w.isCrashed()
      }))
  )
}

export async function crashGuest(app: ElectronApplication, urlPart: string): Promise<void> {
  await app.evaluate(({ webContents }, part) => {
    const wc = webContents
      .getAllWebContents()
      .find((w) => w.getType() === 'webview' && w.getURL().includes(part))
    if (!wc) throw new Error(`no guest webContents for ${part}`)
    wc.forcefullyCrashRenderer()
  }, urlPart)
}

export interface WindowState {
  title: string
  url: string
  visible: boolean
}

export async function windowStates(app: ElectronApplication): Promise<WindowState[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({
      title: w.getTitle(),
      url: w.webContents.getURL(),
      visible: w.isVisible()
    }))
  )
}

export async function rendererZoomFactor(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    return win ? win.webContents.getZoomFactor() : 0
  })
}

export async function openViaAgent(page: Page, target: string): Promise<void> {
  await runIn(page, centerTerm(page), `/open ${target}`)
}

export function openRequestsDir(env: E2EEnv): string {
  return path.join(env.userData, 'opens')
}

export function dropOpenRequest(env: E2EEnv, payload: Record<string, unknown>): string {
  const dir = openRequestsDir(env)
  fs.mkdirSync(dir, { recursive: true })
  const openId = String(payload.openId ?? crypto.randomUUID())
  const file = path.join(dir, `${openId}.json`)
  fs.writeFileSync(file, JSON.stringify({ openId, ts: Math.floor(Date.now() / 1000), ...payload }))
  return file
}

export function readOpenCalls(env: E2EEnv): string[] {
  if (!fs.existsSync(env.openCalls)) return []
  return fs.readFileSync(env.openCalls, 'utf8').split('\n').filter(Boolean)
}

export function readExternalOpens(env: E2EEnv): string[] {
  if (!fs.existsSync(env.externalOpens)) return []
  return fs.readFileSync(env.externalOpens, 'utf8').split('\n').filter(Boolean)
}

export function downloadedFiles(env: E2EEnv): string[] {
  const root = env.downloadDir
  if (!fs.existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel)
      else out.push(rel)
    }
  }
  walk(root, '')
  return out.sort()
}

export async function cdpEndpointOf(env: E2EEnv): Promise<string> {
  let url = ''
  await expect
    .poll(
      () => {
        url = readCalls(env).at(-1)?.cdpEndpoint ?? ''
        return url
      },
      { timeout: 40_000 }
    )
    .toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/cdp\/[a-f0-9]{32}$/)
  return url
}

export async function connectCdp(_page: Page, url: string): Promise<Browser> {
  return await chromium.connectOverCDP(url)
}

// PLATFORM§17
export async function cdpRefusal(url: string): Promise<{ code: number; reason: string }> {
  return await new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason }))
    ws.addEventListener('message', () =>
      reject(new Error('the endpoint answered instead of refusing'))
    )
    setTimeout(() => reject(new Error('the endpoint neither answered nor refused')), 10_000)
  })
}
