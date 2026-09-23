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

/**
 * The Browser-surface test kit (PRD §08 TEST-9/TEST-10,
 * the original design notes).
 *
 * Two rules this file exists to enforce:
 *  - the R7 guest recipe lives HERE, never in a spec: Playwright's fill() /
 *    pressSequentially() fail SILENTLY on a <webview> guest (upstream #9729, closed
 *    wontfix); a real click() into the guest first is what makes input land.
 *  - every Browser selector is one constant, so the surface can be renamed once
 *    instead of in seven spec files. Koloft has no data-testids: these follow the house
 *    `aria-label`-on-a-button convention used by `.aux-ico`.
 *
 * Retargeted: the Browser surface merged into the Workbench panel, so the root
 * is `.wb-panel` and the strip is `.wb-tabs` / `.wb-tab`. Everything BELOW the kind bar
 * is untouched on purpose — FR-37 says the permission bar, interstitial, crash
 * placeholder, error page, dialogs, zoom and fullscreen behave exactly as before, and
 * reusing `BrowserAddressBar` verbatim (`.baddr`, `.bnav`, `.url`) is how that is
 * achieved rather than asserted.
 *
 * The one thing with NO successor is the per-session `n/8` counter: the merged strip has
 * no room for it and the pinned `files` tab's badge counts CHANGED FILES (FR-50), not
 * tabs. FR-22's cap is now observable by counting `tabOpen` instead.
 */
export const BROWSER = {
  /** the panel root — the merged aux column (T2 right rail or T3 full width) */
  surface: '.wb-panel',
  tabStrip: '.wb-panel .wb-tabs',
  /** EVERY tab, the pinned `files` one included (FR-02 makes it a real tab) */
  tab: '.wb-panel .wb-tab',
  /** …and only the closable ones. Almost every count assertion wants THIS: the pinned
   *  tab is always present, so `tab` is off by one against every pre-merge expectation. */
  tabOpen: '.wb-panel .wb-tab:not(.pinned)',
  /** FR-02: the system-pinned Files tab — first slot, no ✕ */
  tabPinned: '.wb-panel .wb-tab.pinned',
  /** the tab's own label text */
  tabLabel: '.lb',
  /** active tab */
  tabActive: '.wb-panel .wb-tab.on',
  /** agent-opened, not yet looked at (the unread dot) */
  tabAgent: '.wb-panel .wb-tab.agent',
  /** live guest evicted by the global cap — still listed, half transparent */
  tabFrozen: '.wb-panel .wb-tab.frozen',
  /**
   * FR-19's per-tab ✕.
   *
   * Two spellings on purpose. Playwright resolves a chained selector RELATIVE to the
   * locator it hangs off, so `tab.locator(BROWSER.tabClose)` with the document-rooted
   * form hunts for a `.wb-tab` nested inside a `.wb-tab` and matches nothing. Chain
   * `tabCloseIn`; use `tabClose` only from the page.
   */
  tabClose: '.wb-tab .x',
  /** the ✕ as chained UNDER a tab locator */
  tabCloseIn: '.x',
  newTab: '.wb-panel .wb-new',
  /** FR-52: the ＋ dropdown — exactly two items, never a terminal one */
  newMenu: '.wb-newmenu',
  addressBar: '.wb-panel .baddr',
  /** the editable address field, whichever shape it takes */
  addressField: '.wb-panel .baddr input, .wb-panel .baddr .url',
  /** the history-autocomplete list the address bar drops while the user edits… */
  suggestList: '.wb-panel .baddr .baddr-sugg',
  /** …and one row in it (the url, then the page's title) */
  suggestRow: '.wb-panel .baddr .baddr-sugg .bext-mrow',
  /** 2px progress line under the address bar, present only while loading */
  progress: '.wb-panel .baddr .prog',
  /** in-surface error page (§06E) and its Retry control */
  errorPage: '.wb-panel .berror',
  retry: '.wb-panel .berror button',
  /** empty state shown when the session has no tabs (§06E) */
  emptyState: '.wb-panel .bempty',
  /** crash placeholder (§05D-12) */
  crashPlaceholder: '.wb-panel .bcrash',
  /** §05D-4/B6: the certificate interstitial, the one failure with Chrome's shape */
  certInterstitial: '.wb-panel .bcert',
  /** DOM modal used for alert/confirm/prompt and basic auth (never a native dialog) */
  modal: '.bmodal',
  /** the titlebar Workbench toggle — the Eye and the Globe merged into one (FR-55) */
  /** titlebar toggle — the Eye and the Globe merged into one (FR-55) */
  globe: '.aux-ico[aria-label="Workbench"]',
  /** any element carrying the explicit active-surface state (TEST-8) */
  surfaceState: '[data-surface]',
  // ---- browser close-out ----
  /** §03 B7: the page-permission prompt / the refusal notice that replaced silence */
  permissionBar: '.wb-panel .bperm',
  permissionAllow: '.wb-panel .bperm .bperm-b.pri',
  permissionDeny: '.wb-panel .bperm .bperm-b:not(.pri)',
  permissionRefused: '.wb-panel .bperm.refused',
  /** §04 B9: the head-band download button, present only once this run has one */
  downloadButton: '.wb-panel .baddr [aria-label="Downloads"]',
  downloadPanel: '.wb-panel .bdl',
  downloadRow: '.wb-panel .bdl .bdl-row',
  downloadClear: '.wb-panel .bdl .bdl-clear',
  /** B12: the ⋯ menu */
  overflowButton: '.wb-panel .baddr [aria-label="More"]',
  overflowMenu: '.wb-panel .bmenu',
  /** §07 #4: the per-tab speaker */
  tabSpeaker: '.btab-spk',
  /** §07 #3: the pane while a page is fullscreen */
  pageFullscreen: '.wb-panel.pagefull',
  /** the panel names its active kind — a steadier oracle than probing for a bar */
  kindAttr: '.wb-panel[data-kind]',

  // ---- the CDP relay's marks ----
  /** D10: the per-session takeover confirmation. It hangs off the window, not off the
   *  panel — it is asked before any surface is involved. */
  /** BB-54: the tab a client is driving, and the pane-level badge beside it */
  drivenTab: '.wb-panel .wb-tab.driven',
  drivenBadge: '.wb-panel .bdriven',
  /** §4.1a/S1: the stage. A guest with no laid-out, visible box produces no frames at
   *  all, so while the panel is collapsed a driven page keeps a full-size column behind
   *  the UI (`.wb-col.staged`) with the guest painted under it. */
  stagedColumn: '.wb-col.staged',
  stagedGuest: '.wb-panel .bguest.staged'
} as const

/**
 * R1 — the app-level browser overlay: the surface a page lands on when no
 * session can take it (a link with nowhere to go, the releases page, the Web Store).
 * One constant per mark, same rule as BROWSER above.
 */
export const OVERLAY = {
  /** the overlay root (portalled to <body>, z 110) */
  root: '.wovl',
  /** its single guest — the ONE guest factory, so `.bguest` like every other */
  guest: '.wovl .bguest',
  back: '.wovl [aria-label="Back"]',
  /** ↗ — the deliberate way OUT of Koloft (D15/SEC-4) */
  external: '.wovl [aria-label="Open in system browser"]',
  /** titlebar entry, present only while the overlay holds a page… */
  entry: '.titlebar [aria-label="Opened page"]',
  /** …dotted while that page has not been looked at (the R1 background receipt) */
  entryUnread: '.titlebar [aria-label="Opened page"].unread',
  /** the overlay's OWN alert/confirm/prompt modal — a page here is on no strip, so its
   *  dialog may not be drawn in the Browser pane (§02) */
  modal: '.wovl .bmodal'
} as const

/** what the overlay's guest is actually showing — it loads through `loadURL`, so the
 *  `src` attribute stays at the bootstrap about:blank (#31918 guard) */
export async function overlayUrl(page: Page): Promise<string> {
  return await page.evaluate((sel) => {
    const el = document.querySelector(sel) as (HTMLElement & { getURL(): string }) | null
    try {
      return el?.getURL() ?? ''
    } catch {
      return '' // the guest has not attached yet — it can't name its webContents
    }
  }, OVERLAY.guest)
}

/**
 * Click a URL the terminal has printed. xterm activates a link from the buffer cells
 * under the pointer, so the click has to land on the URL's own columns: the row's text
 * is monospace, which makes the offset computable from the character index.
 */
export async function clickTerminalLink(
  page: Page,
  url: string,
  root = '.term-island'
): Promise<void> {
  const span = page.locator(`${root} .xterm-rows span`, { hasText: url }).last()
  await expect(span).toBeVisible({ timeout: 30_000 })
  // xterm's DOM renderer rewrites its row spans continuously, so a span resolved by one
  // call can already be detached by the next — measure and read in the same retry, and
  // keep retrying until one attempt sees both.
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
  // raw pointer events, not locator.click(): xterm's own .xterm-screen sits over the
  // row spans and would fail Playwright's actionability check, while the link provider
  // wants exactly this — a hover to resolve the range, then a click on those cells
  await page.mouse.move(x, y)
  await page.waitForTimeout(300)
  await page.mouse.click(x, y)
}

/** aria-labels the address-bar controls carry (house convention: `.aux-ico[aria-label]`) */
export type NavControl = 'Back' | 'Forward' | 'Reload' | 'Stop' | 'Open in system browser'

/**
 * Application-menu item ids for the Browser accelerators. Menu accelerators do not
 * respond to synthesized keys, so a spec drives them through the §0 menu seam:
 * `clickAppMenuItem(app, page, BROWSER_MENU_IDS.toggle)` (helpers/p1.ts). Cases that
 * are ABOUT the key travelling from inside a guest (⌘T/⌘R/⌘L per IMPL-4) press the
 * key on the guest Page instead — that is the before-input-event path.
 */
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

// ---- host-window surface --------------------------------------------------------------

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

/** every tab label, in strip order */
export async function tabTitles(page: Page): Promise<string[]> {
  const texts = await page.locator(`${BROWSER.tab} ${BROWSER.tabLabel}`).allTextContents()
  return texts.map((t) => t.replace(/\s+/g, ' ').trim())
}

/**
 * How many CLOSABLE tabs the strip holds — the successor to the former `n/8` counter.
 *
 * The counter had no room in the merged strip and no honest replacement: the pinned tab's
 * badge counts changed FILES (FR-50), not tabs. So FR-22's cap is asserted by counting,
 * and the pinned tab is excluded because it is exempt from the cap by construction.
 */
export function openTabs(page: Page): Locator {
  return page.locator(BROWSER.tabOpen)
}

/** FR-02's pinned Files tab — always present, always first, never closable. */
export function pinnedTab(page: Page): Locator {
  return page.locator(BROWSER.tabPinned)
}

/** Which kind the panel is showing (`files` | `web` | `file`) — the steadiest oracle for
 *  "the web chrome is up", since the address row exists only for the `web` kind. */
export async function activeKind(page: Page): Promise<string | null> {
  return page.locator(BROWSER.surface).first().getAttribute('data-kind')
}

/** the titlebar Workbench toggle — the Eye and the Globe merged into one (FR-55) */
export function globeIcon(page: Page): Locator {
  return page.locator(BROWSER.globe)
}

/**
 * Whether the titlebar carries ANY unread signal.
 *
 * FR-51 reverses what this is for: a collapsed panel now leaves ZERO signal — no dot, no
 * count — so this exists to assert the absence, where it used to assert the presence. The
 * marks live on the tab strip instead, and only expanding the panel reveals them.
 */
export async function globeHasUnread(page: Page): Promise<boolean> {
  return globeIcon(page).evaluate(
    (el) => el.classList.contains('unread') || el.querySelector('.unread') !== null
  )
}

/**
 * The explicit active-surface state (TEST-8) — `'browser'` / `'preview'`, or null when
 * the aux column shows neither. Never derive this from focus: offscreen,
 * document.hasFocus() reports true in three places at once.
 */
export async function activeSurface(page: Page): Promise<string | null> {
  const el = page.locator(BROWSER.surfaceState).first()
  if ((await el.count()) === 0) return null
  return el.getAttribute('data-surface')
}

/** Expand the panel and wait until it is up. (The Globe is the Workbench toggle now, so
 *  this no longer chooses a SURFACE — there is only one — it chooses T1 vs T2.) */
export async function openBrowser(page: Page): Promise<void> {
  if (await browserSurface(page).isVisible()) return
  await globeIcon(page).click()
  await expect(browserSurface(page)).toBeVisible({ timeout: 20_000 })
}

/**
 * Collapse the panel to T1 — the inverse of `openBrowser`, and the only way a case can
 * say "the column is NOT on screen": the e2e fixture seeds `workbench.defaultOpen: true`
 * (helpers/env.ts), so every session arrives with the panel already expanded.
 */
export async function closeBrowser(page: Page): Promise<void> {
  // Read the COLUMN, not the panel's visibility: while an agent drives a page the
  // collapsed column keeps a fixed-size stage (S1) and the panel root stays
  // `visible` behind the UI, so "hidden" would never come true — and `isVisible()` on
  // the panel would read that stage as "open" and toggle the panel back on.
  const col = page.locator('.wb-col')
  const off = async (): Promise<boolean> =>
    (await col.count()) === 0 || (await col.first().evaluate((el) => el.classList.contains('off')))
  if (await off()) return
  await globeIcon(page).click()
  await expect.poll(off, { timeout: 20_000 }).toBe(true)
}

/** FR-52 — the product's own door to a blank `web` tab: ＋ ▸ "New web tab". */
export async function newWebTab(page: Page): Promise<void> {
  await page.locator(BROWSER.newTab).click()
  await page.locator(`${BROWSER.newMenu} .mi`, { hasText: 'New web tab' }).click()
}

// ---- address bar ----------------------------------------------------------------------

export function addressField(page: Page): Locator {
  return page.locator(BROWSER.addressField).first()
}

/** what the address bar currently shows, whether it is an <input> or a rendered span */
export async function addressValue(page: Page): Promise<string> {
  return addressField(page).evaluate((el) =>
    (el instanceof HTMLInputElement ? el.value : (el.textContent ?? '')).trim()
  )
}

/** Focus the address bar, replace its content, and (by default) submit with Enter. */
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

/**
 * Whether a navigation control presents as unavailable. Accepts the three shapes a
 * disabled control takes in this codebase (`disabled`, `aria-disabled`, the `.dis`
 * class of the §06B markup) so the oracle is "the user cannot use it", not a
 * particular attribute.
 */
export async function navDisabled(page: Page, which: NavControl): Promise<boolean> {
  return navButton(page, which).evaluate(
    (el) =>
      (el as HTMLButtonElement).disabled === true ||
      el.getAttribute('aria-disabled') === 'true' ||
      el.classList.contains('dis')
  )
}

// ---- guests (each <webview> is its own Playwright Page) --------------------------------

/** the Koloft renderer window itself, told apart from every guest by its bundle url */
export function isHostPage(p: Page): boolean {
  return /out\/renderer\/index\.html/.test(p.url())
}

/** every currently attached guest page (host window excluded) */
export function guestPages(app: ElectronApplication): Page[] {
  return app.windows().filter((p) => !isHostPage(p))
}

/**
 * Resolve a guest BY URL — never by index: guests attach in a nondeterministic order
 * and app.windows() mixes in the host window.
 */
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

/**
 * THE guest input recipe (R7). fill() and pressSequentially() silently do nothing on a
 * guest until a real click has landed inside it, so this clicks first, fills, and falls
 * back to real keystrokes if the value still did not stick. Use it for every guest-side
 * text entry; do not hand-roll it in a spec.
 *
 * (Hidden guests are driveable as-is — the measured recipe needs no `force`.)
 */
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

/** Attributes of every <webview> in the host document — the SEC-5/SEC-6 posture oracle. */
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
  /** Stream-level signal — NOT "sound is reaching the speakers". Under parallel-worker
   *  load it reports true for seconds on a guest whose play() the autoplay policy refused
   *  and whose contents stayed muted throughout (retiring it as
   *  BB-N03's oracle). Assert silence via `isAudioMuted()`, never via this. */
  audible: boolean
  zoomFactor: number
  crashed: boolean
}

/** Main-process view of every live guest webContents (audio, zoom, url, crash state). */
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

/** Kill one guest's render process (the crash-placeholder fixture). */
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

/** Every BrowserWindow (incl. a detached devtools window) — count windows THIS way. */
export async function windowStates(app: ElectronApplication): Promise<WindowState[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({
      title: w.getTitle(),
      url: w.webContents.getURL(),
      visible: w.isVisible()
    }))
  )
}

/** The Koloft renderer's own zoom factor — must stay 1 while a guest zooms (BB-C68). */
export async function rendererZoomFactor(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    return win ? win.webContents.getZoomFactor() : 0
  })
}

/**
 * Make the AGENT open something: `/open <target>` is a fake-claude stdin command that
 * spawns `open` from inside the session's own pty, so the request carries that
 * session's tab id exactly as Claude Code's Bash tool would. Transcript-silent by
 * design — the only effect is the intercept.
 */
export async function openViaAgent(page: Page, target: string): Promise<void> {
  await runIn(page, centerTerm(page), `/open ${target}`)
}

/** `<userData>/opens` — the directory the open shim drops its JSON requests into. */
export function openRequestsDir(env: E2EEnv): string {
  return path.join(env.userData, 'opens')
}

/**
 * Drop a raw open-request JSON straight into the watched directory — what a co-user
 * process could do (SEC-14). Returns the file path it wrote.
 */
export function dropOpenRequest(env: E2EEnv, payload: Record<string, unknown>): string {
  const dir = openRequestsDir(env)
  fs.mkdirSync(dir, { recursive: true })
  const openId = String(payload.openId ?? crypto.randomUUID())
  const file = path.join(dir, `${openId}.json`)
  fs.writeFileSync(file, JSON.stringify({ openId, ts: Math.floor(Date.now() / 1000), ...payload }))
  return file
}

// ---- choke-point / filesystem oracles ---------------------------------------------------

/** Everything the recording fake `open` was handed (absent file = never invoked). */
export function readOpenCalls(env: E2EEnv): string[] {
  if (!fs.existsSync(env.openCalls)) return []
  return fs.readFileSync(env.openCalls, 'utf8').split('\n').filter(Boolean)
}

/**
 * Everything that reached the "leave Koloft for the OS" choke point (TEST-2). The P1
 * acceptance is that this file does NOT exist for an http flow — assert absence only
 * after a positive barrier (TEST-3), never on its own.
 */
export function readExternalOpens(env: E2EEnv): string[] {
  if (!fs.existsSync(env.externalOpens)) return []
  return fs.readFileSync(env.externalOpens, 'utf8').split('\n').filter(Boolean)
}

/** Files that landed in KOLOFT_DOWNLOAD_DIR, relative to it (recursive). */
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

// ---- the CDP relay, as a client sees it --------------------------------------------

/** The endpoint the shim injected into the most recent claude launch — discovered the way
 *  a tool discovers it, out of the launch env fake-claude records. Nothing reads Koloft's
 *  internals. */
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

/** Connect as a CDP client. Nothing is asked of the user on the way (the takeover
 *  confirmation retired: a session's own agent simply drives), so this is the plain
 *  connect — kept as the one place specs go through, should a handshake step return. */
export async function connectCdp(_page: Page, url: string): Promise<Browser> {
  return await chromium.connectOverCDP(url)
}

/**
 * How the relay turns a connection away: the close code and reason a bare socket gets.
 * A bare socket, not `connectOverCDP`: the relay refuses at the upgrade, within a
 * millisecond of `open`, and Playwright's client hangs for its whole connect timeout when
 * that close lands before it has sent its first command (measured: 30s on BB-49, 6s on
 * BB-25 — the same refusal, the race going the other way).
 */
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
