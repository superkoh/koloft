import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import type { E2EEnv } from './helpers/env'
import { gitCommitAll, gitInit, startSessionIn, waitBooted } from './helpers/p1'
import { artifactBody, openFileTab, WORKBENCH } from './helpers/workbench'

/**
 * The Markdown preview's non-functional discipline
 *: a preview that now runs a diagram engine, a
 * formula engine and a syntax highlighter inside the PRIVILEGED renderer must stay
 * inert (nothing in a document ever executes), self-contained (no host is ever
 * contacted, offline is a normal day), resilient (one bad block never blanks the page)
 * and visually one light-paper surface.
 *
 * Every oracle here is the one its case names, and every selector comes from the DOM
 * contract (declared in src/renderer/src/markdown/index.ts's header; the spec doc is
 * retired) — nothing reads the
 * implementation. Written before the feature exists: these are supposed to be red.
 */

const SAMPLES = path.join(__dirname, 'fixtures', 'md-preview')

/**
 * Surface migration: the aux column's single-file Preview pane is gone, so
 * every case reads its document out of a Workbench `file` tab — FR-30's markdown →
 * Rendered route, through the same PreviewViewer the former pane used.
 *
 * `artifactBody` is the ACTIVE tab's pane: a case that opens two documents has two
 * artifacts mounted, and an inactive one is hidden with `visibility` (never `display`, so
 * it keeps its layout box and its scroll offset) — an unscoped locator matches both.
 *
 * The measuring `page.evaluate` blocks below spell `.wb-artifact` literally instead: a
 * browser-side callback is serialized and cannot close over `WORKBENCH`, the same
 * constraint the kit's own `layoutState` lives with. Every Playwright-side locator goes
 * through the kit.
 */
function mdBody(page: Page): Locator {
  return artifactBody(page).locator('.md-body')
}

/** FR-31's kind-bar path label; replaces the former FilePane's `.file-pane-title`. Reads
 *  the `file` tab's bar — Browse's reading area spells the same header `.fv-artifact-hd`. */
function artifactTitle(page: Page): Locator {
  return page.locator(WORKBENCH.artifactTitle)
}

/** FR-33's ↻ — moved out of the body and into the kind bar, like FR-32's ≡ (which BB-N11
 *  reaches by selector rather than by locator, since it Tabs to it). */
function reloadButton(page: Page): Locator {
  return page.locator(WORKBENCH.reload)
}

/** A session in ws-a, which is what gives the panel a session to hang off and fixes
 *  FR-34's fence (the same Given preview.spec.ts uses). */
async function sessionInWorkspaceA(page: Page): Promise<void> {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
}

function sampleText(name: string): string {
  return fs.readFileSync(path.join(SAMPLES, name), 'utf8')
}

/**
 * Put a document in the workspace and open it as a `file` tab the way a user does —
 * FR-52's ＋ ▸ "Open file…". The native panel never appears (the main-side file-dialog
 * seam answers the pick); draining its queue is the positive barrier that the picker
 * really was raised and really answered.
 */
async function openDoc(page: Page, env: E2EEnv, name: string, text: string): Promise<void> {
  const full = path.join(env.workspaces.a, name)
  fs.writeFileSync(full, text)
  await openPath(page, env, full)
  await expect(mdBody(page)).toBeVisible({ timeout: 30_000 })
}

/** The same open, for a file that is already on disk (and not necessarily markdown). */
async function openPath(page: Page, env: E2EEnv, full: string): Promise<void> {
  await openFileTab(page, env, full)
  await expect(artifactTitle(page)).toHaveText(path.basename(full), { timeout: 30_000 })
}

async function openSample(page: Page, env: E2EEnv, name: string): Promise<void> {
  await openDoc(page, env, name, sampleText(name))
}

/** The body of the first fenced block of a sample — the "fence source text" a copy button owes
 *  the clipboard, taken from the file on disk rather than from the DOM. */
function fenceBody(md: string): string {
  const m = /```[a-z]*\n([\s\S]*?)```/.exec(md)
  if (!m) throw new Error('sample has no fenced block')
  return m[1]
}

/** A global the document tried to write, or null when it never ran. */
function globalFlag(page: Page, name: string): Promise<unknown> {
  return page.evaluate((k) => (window as unknown as Record<string, unknown>)[k] ?? null, name)
}

function windowCount(app: ElectronApplication): Promise<number> {
  return app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)
}

// ---- network observation -------------------------------------------------------------

/** Start recording every request the renderer makes, file:// module loads included
 *  (verified: Chromium reports dynamic `import()` of a file:// chunk as a request). */
function recordRequests(page: Page): string[] {
  const urls: string[] = []
  page.on('request', (r) => urls.push(r.url()))
  return urls
}

/** Requests aimed at a host that is not this machine. */
function externalRequests(urls: string[]): string[] {
  return urls.filter((u) => {
    let parsed: URL
    try {
      parsed = new URL(u)
    } catch {
      return false
    }
    if (!/^(https?|wss?|ftp):$/.test(parsed.protocol)) return false
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    return !(
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '::1' ||
      host === '0.0.0.0' ||
      host.endsWith('.localhost')
    )
  })
}

function isScript(url: string): boolean {
  return /\.(m?js)(\?|#|$)/i.test(url)
}

// ---- palette observation --------------------------------------------------------------

interface Palette {
  /** the first non-transparent background walking up from the element */
  bg: string
  /** every distinct foreground colour of the text inside it */
  colors: string[]
}

/** NOTE the selector is PLAIN CSS: it goes through `document.querySelector` inside the
 *  page, so Playwright's `:visible` pseudo-class is a syntax error here. Every caller
 *  below has exactly one file tab open, which is what makes the bare class unambiguous. */
async function paletteOf(page: Page, selector: string): Promise<Palette> {
  const p = await page.evaluate((sel) => {
    const root = document.querySelector(sel)
    if (!root) return null
    let bg = ''
    for (let el: Element | null = root; el; el = el.parentElement) {
      const c = getComputedStyle(el).backgroundColor
      if (c && c !== 'transparent' && !/^rgba\(\s*0,\s*0,\s*0,\s*0\s*\)$/.test(c)) {
        bg = c
        break
      }
    }
    const colors = new Set<string>()
    const walk = (el: Element): void => {
      for (const child of Array.from(el.children)) walk(child)
      if (el.children.length === 0 && (el.textContent ?? '').trim()) {
        colors.add(getComputedStyle(el).color)
      }
    }
    walk(root)
    if (colors.size === 0) colors.add(getComputedStyle(root).color)
    return { bg, colors: Array.from(colors) }
  }, selector)
  if (!p) throw new Error(`no element matches ${selector}`)
  return p
}

/** WCAG relative luminance, so "light text on a dark background" is a number comparison, not an opinion. */
function luminance(css: string): number {
  const m = /rgba?\(([^)]+)\)/.exec(css)
  if (!m) return Number.NaN
  const parts = m[1].split(/[,/]/).map((n) => Number(n.trim()))
  const lin = (v: number): number => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * lin(parts[0]) + 0.7152 * lin(parts[1]) + 0.0722 * lin(parts[2])
}

function textLuminance(p: Palette): number {
  const ls = p.colors.map(luminance).filter((n) => !Number.isNaN(n))
  return ls.reduce((a, b) => a + b, 0) / ls.length
}

// ---- scrolling / keyboard --------------------------------------------------------------

/** Scroll the preview from top to bottom in steps, so every lazily rendered block
 *  really passes through the viewport (a single jump to the end would skip the middle). */
async function scrollPreviewThrough(page: Page): Promise<void> {
  const steps = 12
  for (let i = 1; i <= steps; i++) {
    await page.evaluate((frac) => {
      const root = Array.from(document.querySelectorAll('.wb-artifact')).find(
        (el) => getComputedStyle(el).visibility !== 'hidden'
      )
      if (!root) return
      const nodes = [root, ...Array.from(root.querySelectorAll('*'))] as HTMLElement[]
      for (const n of nodes)
        if (n.scrollHeight > n.clientHeight + 4) n.scrollTop = n.scrollHeight * frac
    }, i / steps)
    await page.waitForTimeout(250)
  }
}

/** Press Tab until the focus lands on something matching `selector` (and, when given,
 *  carrying `text`). Returns false when it never does within `max` presses. */
async function tabUntilMatch(page: Page, selector: string, text = '', max = 90): Promise<boolean> {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab')
    const hit = await page.evaluate(
      (arg) => {
        const el = document.activeElement
        if (!el || !el.matches(arg.sel)) return false
        return arg.want === '' || (el.textContent ?? '').includes(arg.want)
      },
      { sel: selector, want: text }
    )
    if (hit) return true
  }
  return false
}

// ---- clipboard -------------------------------------------------------------------------

/**
 * Record what a copy button hands the clipboard WITHOUT touching the developer's real
 * pasteboard (the R7 rule browser-nfr.spec.ts states: the harness may neither read nor
 * overwrite it). Both routes are covered — main's `clipboard` module and the renderer's
 * `navigator.clipboard` / `execCommand('copy')` — because which one the button uses is
 * an implementation detail a black-box test may not assume.
 */
async function armClipboardSpy(app: ElectronApplication, page: Page): Promise<void> {
  await app.evaluate(({ clipboard }) => {
    const g = globalThis as unknown as { __koloftCopied?: string[] }
    g.__koloftCopied = []
    clipboard.writeText = ((text: string): void => {
      g.__koloftCopied?.push(text)
    }) as typeof clipboard.writeText
  })
  await page.evaluate(() => {
    const w = window as unknown as { __koloftCopied?: string[] }
    w.__koloftCopied = []
    if (navigator.clipboard) {
      Object.defineProperty(navigator.clipboard, 'writeText', {
        configurable: true,
        value: (text: string): Promise<void> => {
          w.__koloftCopied?.push(text)
          return Promise.resolve()
        }
      })
    }
    document.execCommand = ((cmd: string): boolean => {
      if (cmd === 'copy') w.__koloftCopied?.push(document.getSelection()?.toString() ?? '')
      return true
    }) as typeof document.execCommand
  })
}

async function copiedTexts(app: ElectronApplication, page: Page): Promise<string[]> {
  const fromMain = await app.evaluate(
    () => (globalThis as unknown as { __koloftCopied?: string[] }).__koloftCopied ?? []
  )
  const fromRenderer = await page.evaluate(
    () => (window as unknown as { __koloftCopied?: string[] }).__koloftCopied ?? []
  )
  return [...fromMain, ...fromRenderer]
}

// ---- security --------------------------------------------------------------------------

test('BB-N01 scripts inside a document do not run', async ({ app, page, env }) => {
  // [PRE-IMPL: green — existing behavior] the md pipeline already ends in DOMPurify.
  test.setTimeout(180_000)
  await sessionInWorkspaceA(page)
  await openSample(page, env, 'nfr-n01-scripts.md')

  await expect(mdBody(page)).toContainText('nfr-n01-body-visible', { timeout: 30_000 })
  // an inline <script> runs synchronously and an <img onerror> fires on the failed
  // load — both would have happened by now if either had survived
  await page.waitForTimeout(1500)

  expect(await globalFlag(page, '__koloftN01Script')).toBeNull()
  expect(await globalFlag(page, '__koloftN01Onerror')).toBeNull()
  await expect(mdBody(page).locator('h1')).toContainText('N01 embedded html')
})

test('BB-N02 click-interaction directives inside a diagram do nothing', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await sessionInWorkspaceA(page)
  // the callback the document's `click … call` names: defined up front so that a bound
  // handler would be observable, instead of failing silently as an unknown symbol
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>
    w.koloftN02Pwn = (): void => {
      w.__koloftN02Pwned = 1
    }
  })
  await openSample(page, env, 'nfr-n02-click.md')

  const svg = mdBody(page).locator('.mmd svg')
  await expect(svg).toBeVisible({ timeout: 60_000 })
  const windowsBefore = await windowCount(app)
  const urlBefore = page.url()

  await svg.locator('text', { hasText: 'n02-node-a' }).first().click()
  await page.waitForTimeout(1500)

  expect(await globalFlag(page, '__koloftN02Pwned')).toBeNull()
  // nothing navigated and no window was opened (the zoom view is in-page, so it does
  // not move either number)
  expect(page.url()).toBe(urlBefore)
  expect(await windowCount(app)).toBe(windowsBefore)
})

test('BB-N03 a security-level directive inside a document cannot lower the level', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await sessionInWorkspaceA(page)
  await openSample(page, env, 'nfr-n03-init.md')

  const svg = mdBody(page).locator('.mmd svg')
  await expect(svg).toBeVisible({ timeout: 60_000 })
  await page.waitForTimeout(1500)

  expect(await globalFlag(page, '__koloftN03Pwn')).toBeNull()
  await expect(mdBody(page).locator('img')).toHaveCount(0)
})

test('BB-N04 dangerous syntax inside a formula yields nothing runnable', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await sessionInWorkspaceA(page)
  await openSample(page, env, 'nfr-n04-math.md')

  // barrier, not the oracle: the document really reached the page. NOT the \href link
  // text — KaTeX with `trust: false` renders that command as an error without keeping its
  // argument, which is the refusal working, not a missing render.
  await expect(mdBody(page)).toContainText('nfr-n04-body-visible', { timeout: 30_000 })
  await page.waitForTimeout(1000)

  await expect(page.locator('a[href^="javascript:"]')).toHaveCount(0)
  await expect(mdBody(page).locator('img[src^="http"]')).toHaveCount(0)
})

test('BB-N19 a fake copy button or fake image forged by the document cannot reach the clipboard', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await sessionInWorkspaceA(page)
  await armClipboardSpy(app, page)
  await openSample(page, env, 'nfr-n19-forgery.md')
  await expect(mdBody(page)).toContainText('nfr-n19-body-visible', { timeout: 30_000 })

  // the forged code block: shows `npm i`, carries another payload
  await mdBody(page).locator('button.md-code-copy').first().click()

  // the forged diagram: a hand-written .mmd holding a plausible svg
  const fake = mdBody(page).locator('.mmd').first()
  await fake.click()
  if (await page.locator('.mmd-zoom').isVisible()) {
    await page.locator('.mmd-zoom button.mmd-copy').click()
  }
  await page.waitForTimeout(500)

  const copied = await copiedTexts(app, page)
  expect(copied.join('\n')).not.toContain('n19-forged-code-payload')
  expect(copied.join('\n')).not.toContain('n19-forged-diagram-payload')
})

test('BB-N12 bidi control characters in a code block cannot fool the eye', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  const source = fenceBody(sampleText('nfr-n12-bidi.md'))
  await sessionInWorkspaceA(page)
  await armClipboardSpy(app, page)
  await openSample(page, env, 'nfr-n12-bidi.md')

  const block = mdBody(page).locator('.md-code')
  await expect(block).toBeVisible({ timeout: 30_000 })
  await block.locator('button.md-code-copy').click()

  const copied = await copiedTexts(app, page)
  expect(copied.length).toBeGreaterThan(0)
  // char-for-char, control characters included. The one normalization is the fence's
  // own closing newline, which "fence source text" does not pin down either way.
  expect(copied[copied.length - 1].replace(/\n+$/, '')).toBe(source.replace(/\n+$/, ''))

  // …while what is DISPLAYED carries no raw bidi control: they are escaped or marked,
  // never left to silently reorder the line
  const shown = await block.locator('pre').evaluate((el) => el.textContent ?? '')
  expect(/[\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/.test(shown)).toBe(false)
})

// ---- offline / self-contained ------------------------------------------------------------

test('BB-N05 rendering never makes an external network request', async ({ app, page, env }) => {
  test.setTimeout(180_000)
  const urls = recordRequests(page)
  await sessionInWorkspaceA(page)
  await openSample(page, env, 'nfr-n05-rich.md')

  await expect(mdBody(page)).toContainText('nfr-n05-closing-line', { timeout: 30_000 })
  await scrollPreviewThrough(page)
  // barriers, not the oracle: all three diagrams, both formulas and all three code
  // blocks really rendered, so "no external request" cannot pass vacuously
  await expect(mdBody(page).locator('.mmd svg')).toHaveCount(3, { timeout: 60_000 })
  await expect
    .poll(() => mdBody(page).locator('.katex').count(), { timeout: 30_000 })
    .toBeGreaterThanOrEqual(2)
  await expect(mdBody(page).locator('.md-code')).toHaveCount(3)

  expect(externalRequests(urls)).toEqual([])
})

test('BB-N06 diagrams and formulas still show with the network down', async ({ env }) => {
  test.setTimeout(180_000)
  // "network blocked": every DNS lookup fails, so no host is reachable at all, while file://
  // (the app's own chunks and fonts) is untouched. argv is fixed at spawn time, so this
  // has to go in before the launch — hence the manual launch instead of the app fixture.
  env.extraArgs.push('--host-resolver-rules=MAP * ~NOTFOUND')
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await sessionInWorkspaceA(page)
    await openSample(page, env, 'nfr-n06-offline.md')

    await expect(mdBody(page).locator('.mmd svg')).toBeVisible({ timeout: 60_000 })
    await expect(mdBody(page).locator('.katex').first()).toBeVisible({ timeout: 30_000 })
    await expect(mdBody(page).locator('.mmd-error')).toHaveCount(0)

    const katexFonts = await page.evaluate(async () => {
      await document.fonts.ready
      let loaded = 0
      document.fonts.forEach((f) => {
        if (/katex/i.test(f.family) && f.status === 'loaded') loaded++
      })
      return loaded
    })
    expect(katexFonts).toBeGreaterThan(0)
  } finally {
    await app.close().catch(() => {})
  }
})

test('BB-N16 a text-only document does not load the diagram and formula code', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  // NOTE: only the first half of this case's Then is asserted. The second half ("first-screen
  // text visible < 300 ms") is a wall-clock threshold that this harness cannot measure
  // honestly — see the report: it stays a manual perf check, together with BB-N08.
  const urls = recordRequests(page)
  await sessionInWorkspaceA(page)

  const lines: string[] = []
  for (let i = 1; i <= 1000; i++) lines.push(i % 10 === 0 ? '' : `nfr-n16 plain line ${i}`)
  await openDoc(page, env, 'nfr-n16-plain.md', lines.join('\n'))
  await expect(mdBody(page)).toContainText('nfr-n16 plain line 1', { timeout: 30_000 })
  await page.waitForTimeout(2000)

  expect(urls.filter((u) => /mermaid|katex/i.test(u))).toEqual([])

  // falsifiability barrier, not the oracle: a document that DOES carry a diagram and a
  // formula must pull script chunks this one never did — otherwise the assertion above
  // would also hold on a build that lazily loads nothing at all.
  const before = new Set(urls.filter(isScript))
  await openSample(page, env, 'nfr-n06-offline.md')
  await expect(mdBody(page).locator('.mmd svg')).toBeVisible({ timeout: 60_000 })
  expect(urls.filter(isScript).filter((u) => !before.has(u)).length).toBeGreaterThan(0)
})

// ---- resilience ---------------------------------------------------------------------------

test('BB-N09 one block failing to render does not take down the whole document', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await sessionInWorkspaceA(page)
  await openSample(page, env, 'nfr-n09-partial.md')

  await expect(mdBody(page)).toContainText('nfr-n09-opening-line', { timeout: 30_000 })
  await scrollPreviewThrough(page)
  await expect(mdBody(page)).toContainText('nfr-n09-closing-line')

  // the healthy code block is there AND coloured
  const code = mdBody(page).locator('.md-code')
  await expect(code).toBeVisible()
  const palette = await paletteOf(page, `${WORKBENCH.artifact} .md-body .md-code`)
  expect(palette.colors.length).toBeGreaterThanOrEqual(2)

  // the broken diagram degraded in place, and the broken formula kept every character
  await expect(mdBody(page).locator('.mmd-error')).toHaveCount(1, { timeout: 60_000 })
  await expect(mdBody(page)).toContainText('\\koloftinvalidcmdn09{x}')
})

/**
 * BB-N10 → §6 "deleted on disk" (case WB-R12). The original Then — a reload whose
 * read fails keeps the last good render — was SUPERSEDED, deliberately: a file that is
 * gone now says so instead of leaving a stale document on screen that the reader has no
 * way of telling apart from the live one. What the case still guards is the same failure
 * mode it was written for (a failed reload must not blank or crash the panel) plus the
 * two clauses §6 added: the tab is not auto-closed, and the placeholder offers the exit.
 *
 * The "transient failure keeps the last good content" branch survives in the code for
 * errors that are neither missing / too-large / binary; it has no black-box construction
 * (every read failure this harness can cause is one of those three), so it is not
 * asserted here rather than being asserted weakly.
 */
test('BB-N10 read fails on reload: a deleted file shows a placeholder and a way to close', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await sessionInWorkspaceA(page)
  await openSample(page, env, 'nfr-n10-version.md')
  await expect(mdBody(page)).toContainText('nfr-n10-version-one', { timeout: 30_000 })
  const tabs = page.locator(WORKBENCH.tab)
  await expect(tabs).toHaveCount(2) // the pinned `files` tab plus this one

  fs.rmSync(path.join(env.workspaces.a, 'nfr-n10-version.md'))
  await reloadButton(page).click()
  await page.waitForTimeout(2500)

  // the panel is standing, the tab is still there, and the pane says what happened
  const state = artifactBody(page).locator('.code-state')
  await expect(state).toBeVisible()
  await expect(state).toContainText('no longer exists')
  await expect(tabs).toHaveCount(2)

  // …and the placeholder's own close entry is what closes it — never the app on its own
  await state.locator(WORKBENCH.stateButton).click()
  await expect(tabs).toHaveCount(1)
})

test('BB-N14 refreshing again and again does not insert diagrams twice', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await sessionInWorkspaceA(page)
  await openSample(page, env, 'nfr-n14-two.md')

  const diagrams = mdBody(page).locator('.mmd')
  await expect(diagrams.locator('svg')).toHaveCount(2, { timeout: 60_000 })

  await reloadButton(page).click()
  await page.waitForTimeout(800)
  await reloadButton(page).click()
  await page.waitForTimeout(3000)

  await expect(diagrams).toHaveCount(2)
  await expect(diagrams.locator('svg')).toHaveCount(2)
})

// ---- layout & keyboard ----------------------------------------------------------------------

test('BB-N11 the keyboard can jump via the outline and close a zoomed image', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await sessionInWorkspaceA(page)
  await openSample(page, env, 'nfr-n11-keys.md')
  await expect(mdBody(page).locator('.mmd svg')).toBeVisible({ timeout: 60_000 })

  const third = mdBody(page).locator('h2', { hasText: 'n11-heading-three' })
  await expect(third).not.toBeInViewport()

  // the Given "focus is inside the preview panel": click the kind bar's path label, which is where the
  // panel's focusable chrome starts (the label is a span, and the panel root is focusable
  // precisely so a click on non-focusable chrome lands there). Starting from the BODY
  // would send forward-Tab away from the outline — FR-31 put ≡ in the kind bar, above the
  // body in DOM order — and on into the terminal, whose xterm textarea swallows Tab: a
  // pre-existing app-wide behaviour, not something this preview introduces.
  await artifactTitle(page).click()

  expect(await tabUntilMatch(page, WORKBENCH.outline)).toBe(true)
  await page.keyboard.press('Enter')
  await expect(page.locator('.outline-list')).toBeVisible({ timeout: 10_000 })
  expect(await tabUntilMatch(page, '.outline-it', 'n11-heading-three')).toBe(true)
  await page.keyboard.press('Enter')
  await expect(third).toBeInViewport({ timeout: 10_000 })

  // Activating a row closes the list, so the element that had the focus leaves the DOM.
  // Focus has to be handed back inside the panel, or forward-Tab restarts at the top of
  // the app and is swallowed by the TUI's xterm textarea long before it comes round to
  // the artifact again — which is exactly what this next line detects.
  expect(await tabUntilMatch(page, '.mmd, .mmd *')).toBe(true)
  await page.keyboard.press('Enter')
  await expect(page.locator('.mmd-zoom')).toBeVisible({ timeout: 10_000 })
  await page.keyboard.press('Escape')
  await expect(page.locator('.mmd-zoom')).toHaveCount(0, { timeout: 10_000 })

  const focusInPane = await page.evaluate(() => !!document.activeElement?.closest('.wb-panel'))
  expect(focusInPane).toBe(true)
})

test('BB-N13 long Chinese and Arabic paragraphs do not burst the panel', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await sessionInWorkspaceA(page)
  await openSample(page, env, 'nfr-n13-intl.md')
  await expect(mdBody(page)).toContainText('nfr-n13-body-visible', { timeout: 30_000 })

  const m = await page.evaluate(() => {
    const pane = document.querySelector('.wb-artifact') as HTMLElement | null
    if (!pane) return null
    const width = (sel: string): number => {
      const el = document.querySelector(sel)
      return el ? el.getBoundingClientRect().width : -1
    }
    const doc = document.documentElement
    return {
      paneWidth: pane.getBoundingClientRect().width,
      docOverflow: doc.scrollWidth - doc.clientWidth,
      paneOverflow: pane.scrollWidth - pane.clientWidth,
      zh: width('#n13-zh'),
      ar: width('#n13-ar'),
      heading: width('.wb-artifact .md-body h1')
    }
  })
  if (!m) throw new Error('no preview pane')

  // no horizontal scrollbar anywhere on the page
  expect(m.docOverflow).toBeLessThanOrEqual(0)
  expect(m.paneOverflow).toBeLessThanOrEqual(1)
  // …and each of the three blocks stays inside the pane (1px for sub-pixel rounding)
  for (const w of [m.zh, m.ar, m.heading]) {
    expect(w).toBeGreaterThan(0)
    expect(w).toBeLessThanOrEqual(m.paneWidth + 1)
  }
})

// ---- theme consistency -----------------------------------------------------------------------

test('BB-N17 switching theme does not disturb the code view or the diff view', async ({
  app,
  page,
  env
}) => {
  // [PRE-IMPL: green — existing behavior] the code view and the inline diff keep the
  // dark theme; only the preview turns light.
  test.setTimeout(180_000)
  const file = path.join(env.workspaces.a, 'nfr-n17-sample.ts')
  fs.writeFileSync(file, 'export const n17 = { label: "seventeen", count: 17 }\n')
  gitInit(env.workspaces.a)
  gitCommitAll(env.workspaces.a)
  await sessionInWorkspaceA(page)

  // the Source view: the file as committed, no change yet — FR-30 routes an UNCHANGED
  // code file straight to Source, so `.code-body` is what the tab opens on
  await openPath(page, env, file)
  await expect(artifactBody(page).locator('.code-body')).toBeVisible({ timeout: 30_000 })
  const codeView = await paletteOf(page, `${WORKBENCH.artifact} .code-body`)
  expect(luminance(codeView.bg)).toBeLessThan(textLuminance(codeView))
  expect(codeView.colors.length).toBeGreaterThanOrEqual(2)

  // …and its change view: give the file a diff, then take the kind bar's Diff segment.
  // The retired pane needed a reopen through another file to get here; FR-31's segment is
  // a control on the tab itself, so the change view is one click away in place.
  fs.writeFileSync(
    file,
    'export const n17 = { label: "seventeen", count: 18 }\nexport const added = true\n'
  )
  const diffBtn = page.locator(WORKBENCH.viewSeg).locator('button', { hasText: 'Diff' })
  await expect(diffBtn).toBeEnabled({ timeout: 30_000 })
  await diffBtn.click()
  const idiff = artifactBody(page).locator('.idiff')
  await expect(idiff).toBeVisible({ timeout: 30_000 })
  const diffView = await paletteOf(page, `${WORKBENCH.artifact} .idiff`)
  expect(luminance(diffView.bg)).toBeLessThan(textLuminance(diffView))
  expect(diffView.colors.length).toBeGreaterThanOrEqual(2)
})

test('BB-N18 code blocks in the preview are dark text on a light background', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await sessionInWorkspaceA(page)
  await openSample(page, env, 'nfr-n18-code.md')
  await expect(mdBody(page).locator('.md-code')).toBeVisible({ timeout: 30_000 })

  const code = await paletteOf(page, `${WORKBENCH.artifact} .md-body .md-code pre`)
  expect(luminance(code.bg)).toBeGreaterThan(textLuminance(code))

  // …the same direction as the pane's own paper: light behind, dark in front
  const paper = await paletteOf(page, `${WORKBENCH.artifact} .md-body`)
  expect(luminance(paper.bg)).toBeGreaterThan(textLuminance(paper))
})
