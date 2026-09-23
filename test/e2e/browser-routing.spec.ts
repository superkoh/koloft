import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import type { E2EEnv } from './helpers/env'
import {
  auxIcon,
  centerTerm,
  clickAppMenuItem,
  FAKE_SESSION_TITLE,
  focusOwner,
  openSessionTerminal,
  panelTerm,
  runIn,
  startSessionIn,
  waitBooted
} from './helpers/p1'
import {
  OVERLAY,
  BROWSER,
  BROWSER_MENU_IDS,
  activeKind,
  addressField,
  addressValue,
  browserSurface,
  clickTerminalLink,
  downloadedFiles,
  globeHasUnread,
  globeIcon,
  guestByUrl,
  guestContents,
  newWebTab,
  openBrowser,
  openTabs,
  openViaAgent,
  readOpenCalls,
  typeInAddressBar,
  windowStates
} from './helpers/browser'
import {
  WORKBENCH,
  openInBrowse,
  showBrowse,
  wbActiveTab,
  wbTabTitles,
  wbUnreadTabs
} from './helpers/workbench'
import { hostResolverSwitch, startEchoServer } from './helpers/fixtureServer'

/**
 * URL routing + the open shim (FR-11/13/14/15/57; the case ids are the original
 * case list's routing table).
 *
 * Every case here answers one question: WHERE does a target land — a `web` tab, the
 * reading area, the OS, or nowhere — and who is allowed to put it there. The observables
 * are the ones the cases name: the tab strip and its unread marker, the echo server's
 * request log ("a page was really loaded"), the guest webContents' urls ("something
 * really navigated there"), `openCalls` ("it left for the OS") and the panel's own
 * `data-surface` / `data-kind`.
 */

/** Every live guest's url, as the main process sees it (empty string = never loaded). */
async function guestUrls(app: ElectronApplication): Promise<string[]> {
  return (await guestContents(app)).map((g) => g.url)
}

/**
 * The Given most of these cases share: one running session in ws-a, started the way the
 * product starts one (sidebar ▸ New session).
 *
 * Reaching the recording fake `open` rather than the real /usr/bin/open is load-bearing,
 * not incidental — an `open http://…` that escaped would launch the developer's actual
 * browser mid-run, which the invisible-testing rule forbids and which no `openCalls`
 * assertion could ever see. A session pty is a login shell and macOS's path_helper
 * hoists /usr/bin above whatever Koloft handed it, so the pinning cannot come from the pty:
 * every open below is AGENT-source, and fake-claude re-pins shim-dir + its own dir ahead
 * of /usr/bin for the child it spawns (fake-claude.js openEnv).
 */
async function runningSession(page: Page): Promise<void> {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await expect(page.locator('.ws-tab', { hasText: FAKE_SESSION_TITLE })).toBeVisible({
    timeout: 40_000
  })
  await expect(auxIcon(page, 'Workbench')).toHaveAttribute('aria-disabled', 'false', {
    timeout: 60_000
  })
}

/**
 * …plus the panel up — a tab strip is only observable while it is shown. `openBrowser`
 * chooses T1 vs T2 now rather than a surface, and the panel is open by DEFAULT after the
 * merge (`workbench.defaultOpen`, FR-06), so it is usually a no-op.
 *
 * Deliberately does NOT mint a `web` tab: most cases here count what a routing decision
 * put in the strip, and a tab the Given opened would be one the case has to subtract.
 */
async function browserSession(page: Page): Promise<void> {
  await runningSession(page)
  await expect(globeIcon(page)).toBeVisible({ timeout: 30_000 })
  await openBrowser(page)
}

/** …and the variant with a blank `web` tab already up, for the address-bar cases (FR-52:
 *  the panel opens on the pinned `files` tab, whose kind bar has no address field). */
async function addressBarSession(page: Page): Promise<void> {
  await browserSession(page)
  await newWebTab(page)
  await expect(addressField(page)).toBeVisible({ timeout: 20_000 })
}

/**
 * Make the agent `open` something and wait for the fake claude's own "opened" line —
 * a TEST-3 positive barrier, never an oracle: it only says the request left the pty,
 * so the negative assertions after it cannot pass vacuously.
 */
async function agentOpen(page: Page, target: string): Promise<void> {
  await openViaAgent(page, target)
  await expect(centerTerm(page)).toContainText('opened', { timeout: 30_000 })
}

/** The address bar's resting text with layout whitespace (host/path spans) squeezed out. */
async function addressText(page: Page): Promise<string> {
  return (await addressValue(page)).replace(/\s+/g, '')
}

// clickTerminalLink moved to helpers/browser.ts when the overlay spec became its
// second caller — same monospace-offset recipe, one copy.

/** The largest scrollTop anywhere inside the reading area; -1 when there is no pane. */
function previewScrollTop(page: Page): Promise<number> {
  return page.evaluate(() => {
    // the former aux column's `.file-pane-col` / `.pane-host` wrappers went with the
    // merge, and so did the `.file-pane` root. The pane's body kept its class but there
    // is now one per mounted artifact (reading area and `file` tabs alike), so it has to
    // be scoped to Browse's reading column or this reads whichever one happens to be first.
    const root = document.querySelector('.fv-read .file-pane-body')
    if (!root) return -1
    let max = (root as HTMLElement).scrollTop
    for (const n of Array.from(root.querySelectorAll('*'))) {
      max = Math.max(max, (n as HTMLElement).scrollTop)
    }
    return max
  })
}

/** The live xterm instance set — unchanged means the renderer was never navigated. */
function termIds(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Object.keys(
      (window as unknown as { __koloftTerms?: Record<string, unknown> }).__koloftTerms ?? {}
    ).sort()
  )
}

/** Write a workspace file and wait for its row to show up in Browse — the pinned `files`
 *  tab's half that took the former sidebar tree's job (FR-44). Reaching Browse is part of
 *  the wait: the tab opens on Changes, where no tree is mounted at all. */
async function seedWorkspaceFile(
  page: Page,
  env: E2EEnv,
  rel: string,
  body: string
): Promise<void> {
  fs.writeFileSync(path.join(env.workspaces.a, rel), body)
  await showBrowse(page)
  await expect(page.locator(`${WORKBENCH.panel} .ft-node.ft-file`, { hasText: rel })).toBeVisible({
    timeout: 30_000
  })
}

// ---- agent-source routing ---------------------------------------------------------------

test('BB-M01: agent `open http://localhost:PORT` lands a background Browser tab and never reaches the system browser', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  try {
    await browserSession(page)
    await agentOpen(page, server.localhostUrl('/a'))

    // the tab is built, and it carries the agent (unread) marker
    await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })
    await expect(wbUnreadTabs(page)).toHaveCount(1)
    // [0] is the pinned `files` tab's label (FR-02) — the agent's tab is the one after it
    expect((await wbTabTitles(page))[1]).toContain('localhost')

    // …but nothing loaded it (B5), and nothing left for the system browser
    expect(server.count()).toBe(0)
    expect(readOpenCalls(env).filter((l) => l.includes('http://'))).toEqual([])
    // …nor for the app-level overlay (BB-21): a live session's own strip took it
    expect(await page.locator(OVERLAY.root).count()).toBe(0)
    expect(await page.locator(OVERLAY.entry).count()).toBe(0)
  } finally {
    await server.close()
  }
})

test('BB-M28: agent `open <bare .html path>` lands a background Browser tab, never Safari', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await browserSession(page)
  // a BARE local path — neither file:// nor http: the shim must still intercept it
  await agentOpen(page, 'docs/page.html')

  await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })
  await expect(wbUnreadTabs(page)).toHaveCount(1)
  expect((await wbTabTitles(page))[1]).toContain('page.html')

  // not loaded, and never handed to the OS opener
  expect((await guestUrls(app)).filter((u) => u.includes('page.html'))).toEqual([])
  expect(readOpenCalls(env).filter((l) => l.includes('page.html'))).toEqual([])
})

// RETARGETED by FR-14/FR-51. The case's Then — "the aux surface is not yanked away from
// Browser" — survives verbatim as "the panel is not yanked away from the active `web` tab".
// Its Given half does not: the Eye's unread dot was the signal an agent file-open used to
// leave, and the merge deleted it out loud (FR-51: a collapsed panel leaves ZERO signal;
// FR-14: files the agent opens while collapsed are undiscoverable, accepted as a
// trade-off). So the dot assertion is replaced by FR-14's own stated positive barrier — a
// user open of the same file right afterwards still lands normally — which is what keeps
// the negatives here from passing vacuously.
test('BB-C11: an agent file-open never takes the panel away from the active web tab', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await addressBarSession(page)
  expect(await activeKind(page)).toBe('web')
  const tabsBefore = await openTabs(page).count()

  await agentOpen(page, 'README.md')
  // a routing decision that must NOT happen has no positive signal of its own — settle
  await page.waitForTimeout(3000)

  // FR-14: no tab, no panel movement, and no titlebar signal of any kind
  expect(await activeKind(page)).toBe('web')
  expect(await openTabs(page).count()).toBe(tabsBefore)
  await expect(browserSurface(page)).toBeVisible()
  expect(await globeHasUnread(page)).toBe(false)

  // the barrier: the user's own open of the SAME file lands, and it lands the way FR-57
  // says — the pinned `files` tab activated, the file in the reading area.
  //
  // It is driven from a shell rather than by a Browse row click, and that is the whole
  // point: a row click means first activating the pinned tab BY HAND, so
  // `activeKind === 'files'` would then be the gesture's own doing and the assertion would
  // pass no matter what FR-57 did. A shell's `open` is a USER open — the only shape in
  // which "the panel was yanked to `files`" is still an observation about the product.
  // that shell is the session's own terminal tab now, not the former island.
  await openSessionTerminal(app, page)
  await runIn(
    page,
    panelTerm(page),
    `export PATH="${env.shimDir}:${env.fakeBin}:$PATH"; hash -r; cd '${env.workspaces.a}'; open README.md`
  )
  await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('files')
  await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('README.md', { timeout: 30_000 })
})

test('BB-C14: agent request of a `file://` URL routes by extension, not by scheme bypass', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await browserSession(page)

  // ① a previewable .md over file:// goes to the FILE side, so it mints no tab at all
  //    (FR-14). The panel is up throughout, which is what makes the absence meaningful.
  //
  //    Where it lands has to be looked FOR: an agent open carries `source: 'intercept'`,
  //    so unlike a user open it does not bring Browse with it (FR-57) — the file becomes
  //    the reading area's subject silently, and the user meets it when they next open
  //    Browse. That is FR-14's prescribed discovery route, and this is it.
  await agentOpen(page, `file://${env.workspaces.a}/README.md`)
  await showBrowse(page)
  await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('README.md', { timeout: 30_000 })
  await expect(openTabs(page)).toHaveCount(0)

  // ② an .html over the same scheme lands in a `web` tab, in the background (FR-13)
  await agentOpen(page, `file://${env.workspaces.a}/docs/page.html`)
  await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })
  expect((await wbTabTitles(page))[1]).toContain('page.html')
  await expect(wbUnreadTabs(page)).toHaveCount(1)
})

test('BB-C13: agent `open` of a non-http scheme still passes through to the OS unchanged', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  // the panel is up so that "no tab is created" is a real observation and not merely an
  // unmounted surface
  await browserSession(page)
  await agentOpen(page, 'zoommtg://example')

  await expect
    .poll(() => readOpenCalls(env).join('\n'), { timeout: 30_000 })
    .toContain('zoommtg://example')
  await expect(openTabs(page)).toHaveCount(0)
})

// [PRE-IMPL: green — existing behavior]
test('BB-C50: an unsupported (non-web, non-previewable) `open` still passes through to the real `open`', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await runningSession(page)
  await agentOpen(page, 'notes.xyz')

  await expect.poll(() => readOpenCalls(env).join('\n'), { timeout: 30_000 }).toContain('notes.xyz')
  // "the surface never came up" is no longer an observation the merge allows — the panel
  // belongs to the session and is already showing (FR-04/FR-06). What still is one, and
  // is what the case meant, is that the unsupported target reached NEITHER kind: no tab
  // in the strip, nothing in the reading area.
  expect(await openTabs(page).count()).toBe(0)
  // Browse first: the reading area (and so its header) exists only in that half, so
  // counting it from the Changes stream would read 0 whatever the routing did.
  await showBrowse(page)
  expect(await page.locator(WORKBENCH.readingTitle).count()).toBe(0)
})

// ---- user-source routing ---------------------------------------------------------------

test('BB-M03: clicking a URL in the terminal opens it foreground in Browser without disturbing the TUI', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  try {
    await runningSession(page)
    const url = server.localhostUrl('/a')
    // the session's terminal prints the URL, and keeps the keyboard focus
    await runIn(page, centerTerm(page), url)
    await expect(centerTerm(page)).toContainText('handled', { timeout: 30_000 })
    expect(await focusOwner(page)).toBe('tui')

    await clickTerminalLink(page, url)

    // the panel shows a foreground `web` tab on that URL (FR-57)…
    await expect(browserSurface(page)).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('web')
    await expect
      .poll(() => addressText(page), { timeout: 30_000 })
      .toContain(`localhost:${server.port}/a`)
    // …the page really loaded…
    await expect.poll(() => server.count('/a'), { timeout: 30_000 }).toBeGreaterThan(0)
    // …the TUI still owns the input…
    expect(await focusOwner(page)).toBe('tui')
    await page.keyboard.type('koloft-e2e-still-typing')
    await page.keyboard.press('Enter')
    await expect(centerTerm(page)).toContainText('koloft-e2e-still-typing', { timeout: 30_000 })
    // …and nothing was handed to the system browser
    expect(readOpenCalls(env).filter((l) => l.includes('http://'))).toEqual([])
  } finally {
    await server.close()
  }
})

test('a URL printed as a REAL hyperlink (OSC 8) routes into Koloft like any other', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  // xterm's own OSC 8 provider outranks the web-links addon, and without a linkHandler
  // it falls back to a native confirm + a window.open the app denies — the click
  // dead-ends outside Koloft's routing table entirely. Anything that prints real
  // hyperlinks (Claude Code's own login/PR links, gh, ls --hyperlink) lands here.
  const dialogs: string[] = []
  page.on('dialog', (d) => {
    dialogs.push(d.message())
    void d.dismiss().catch(() => {})
  })
  try {
    await runningSession(page)
    const url = server.localhostUrl('osc8')
    // a shell, not the TUI: it is the one product surface where a raw escape sequence can
    // be typed, and its links route through the owning session exactly like the TUI's do.
    // the shell is a terminal tab in this session's own panel now.
    await openSessionTerminal(app, page)
    // the full url must NOT appear in the typed command: its echo would be plain text,
    // and the click would then land on that instead of on the hyperlink under test
    const base = server.localhostUrl('')
    await runIn(
      page,
      panelTerm(page),
      `b='${base}'; printf '\\033]8;;%sosc8\\007%sosc8\\033]8;;\\007\\n' "$b" "$b"`
    )

    await clickTerminalLink(page, url, '.wb-panel')

    // it lands in the session's panel as a foreground `web` tab — the user-source route
    await expect(browserSurface(page)).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('web')
    await expect
      .poll(() => addressText(page), { timeout: 30_000 })
      .toContain(`localhost:${server.port}/osc8`)
    await expect.poll(() => server.count('/osc8'), { timeout: 30_000 }).toBeGreaterThan(0)
    // …never through xterm's own escape hatch
    expect(dialogs).toEqual([])
    expect(readOpenCalls(env).filter((l) => l.includes('http://'))).toEqual([])
  } finally {
    await server.close()
  }
})

test('BB-M06: a non-URL address-bar entry becomes a DuckDuckGo search', async ({ env }) => {
  test.setTimeout(180_000)
  // duckduckgo.com is pinned at the loopback: the assertion is the URL the Browser
  // chose, and a search must never actually leave this machine during a test run
  env.extraArgs.push(hostResolverSwitch(['duckduckgo.com']))
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await addressBarSession(page)

    await typeInAddressBar(page, 'error message text')

    const targets = async (): Promise<string[]> => [
      await addressValue(page),
      ...(await guestUrls(app))
    ]
    await expect
      .poll(
        async () => (await targets()).some((u) => /^https?:\/\/[^/]*duckduckgo\.com\//.test(u)),
        {
          timeout: 30_000
        }
      )
      .toBe(true)
    const searched = (await targets()).filter((u) => /duckduckgo\.com/.test(u))
    expect(
      searched.some((u) => decodeURIComponent(u).replace(/\+/g, ' ').includes('error message text'))
    ).toBe(true)
    // and the words were not treated as a host
    expect((await targets()).some((u) => u.startsWith('http://error'))).toBe(false)
  } finally {
    await app.close().catch(() => {})
  }
})

test('BB-M21: an http(s) URL pointing at a `.pdf` renders in place, with no download', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  try {
    await addressBarSession(page)
    await typeInAddressBar(page, server.url('/doc.pdf'))

    await expect.poll(() => server.count('/doc.pdf'), { timeout: 30_000 }).toBeGreaterThan(0)
    await expect
      .poll(async () => (await guestUrls(app)).some((u) => u.endsWith('.pdf')), { timeout: 30_000 })
      .toBe(true)
    expect(await page.locator(BROWSER.errorPage).count()).toBe(0)
    expect(downloadedFiles(env)).toEqual([])
  } finally {
    await server.close()
  }
})

test('BB-M27: opening the same URL twice yields a single tab', async ({ app, page, env }) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  try {
    await runningSession(page)
    const url = server.localhostUrl('/a')

    // Given: one tab already on that URL, opened by the user from the terminal
    await runIn(page, centerTerm(page), url)
    await clickTerminalLink(page, url)
    await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })

    // When: the user opens the very same URL again (printed afresh, since expanding
    // the Browser reflowed the terminal that held the first line)
    await runIn(page, centerTerm(page), url)
    await clickTerminalLink(page, url)

    // Then: reused and activated, never a second tab
    await expect(openTabs(page)).toHaveCount(1)
    await expect(wbActiveTab(page)).toHaveCount(1)
    await expect
      .poll(() => addressText(page), { timeout: 20_000 })
      .toContain(`localhost:${server.port}/a`)
  } finally {
    await server.close()
  }
})

// ---- scheme whitelist at the address bar -------------------------------------------------

test('BB-C18: the address bar rejects `data:`, `koloft-file:`, `devtools:`, and `chrome:` schemes', async ({
  env
}) => {
  test.setTimeout(240_000)
  env.extraArgs.push(hostResolverSwitch(['duckduckgo.com']))
  const app = await launchApp(env)
  const server = await startEchoServer()
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await addressBarSession(page)
    const loaded = server.url('/a')
    await typeInAddressBar(page, loaded)
    await guestByUrl(app, loaded)

    for (const input of [
      'data:text/html,x',
      'koloft-file://localhost/etc/hosts',
      'devtools://x',
      'chrome://settings'
    ]) {
      await typeInAddressBar(page, input)
      await page.waitForTimeout(2500)
      const scheme = input.slice(0, input.indexOf(':') + 1)
      expect((await guestUrls(app)).filter((u) => u.startsWith(scheme))).toEqual([])
    }
    // only the http page the bar did accept is still there
    expect(await guestUrls(app)).toContain(loaded)
  } finally {
    await server.close()
    await app.close().catch(() => {})
  }
})

test('BB-C28: `chrome://` and `devtools://` are hard-blocked with no navigation', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  try {
    await addressBarSession(page)

    // ① from a page: an in-page link
    const linkPage = server.url(
      `/link?href=${encodeURIComponent('devtools://devtools/bundled/inspector.html')}`
    )
    await typeInAddressBar(page, linkPage)
    const guest = await guestByUrl(app, '/link')
    await guest.locator('#link').click()
    await page.waitForTimeout(3000)
    expect((await guestUrls(app)).filter((u) => u.startsWith('devtools:'))).toEqual([])

    // ② from the agent
    await agentOpen(page, 'chrome://settings')
    expect((await guestUrls(app)).filter((u) => u.startsWith('chrome:'))).toEqual([])
  } finally {
    await server.close()
  }
})

test('BB-C30: `data:` is allowed only from a user source, not from the address bar or agent', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  try {
    await addressBarSession(page)
    const userData = 'data:text/html,koloft-e2e-data-user'

    // ① user source: an in-page link click
    await typeInAddressBar(page, server.url(`/link?href=${encodeURIComponent(userData)}`))
    const guest = await guestByUrl(app, '/link')
    await guest.locator('#link').click()
    await expect
      .poll(async () => (await guestUrls(app)).some((u) => u.includes('koloft-e2e-data-user')), {
        timeout: 30_000
      })
      .toBe(true)

    // ② agent source
    await agentOpen(page, 'data:text/html,koloft-e2e-data-agent')
    expect((await guestUrls(app)).filter((u) => u.includes('koloft-e2e-data-agent'))).toEqual([])

    // ③ address bar
    await typeInAddressBar(page, 'data:text/html,koloft-e2e-data-addr')
    await page.waitForTimeout(3000)
    expect((await guestUrls(app)).filter((u) => u.includes('koloft-e2e-data-addr'))).toEqual([])
  } finally {
    await server.close()
  }
})

// ---- file://, about:blank, window.close --------------------------------------------------

test('BB-C31: a `file://` URL pointing at a directory shows the Chromium directory listing', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await addressBarSession(page)
  const dir = `file://${env.workspaces.a}/docs/`

  await typeInAddressBar(page, dir)

  const guest = await guestByUrl(app, `${env.workspaces.a}/docs/`)
  await expect(guest.locator('body')).toContainText('page.html', { timeout: 30_000 })
  expect(await page.locator(BROWSER.errorPage).count()).toBe(0)
  expect(downloadedFiles(env)).toEqual([])
})

test('BB-C29: `about:blank` is a legal new-tab initial state', async ({ app, page, env }) => {
  test.setTimeout(180_000)
  await browserSession(page)

  // FR-52: from the pinned `files` tab the ＋ is a two-item dropdown rather than a bare
  // new-tab button, and "New web tab" is the entry that mints the blank tab. The View ▸
  // "New Browser Tab" item this case used to click reaches the panel too, but on `files`
  // FR-52 makes it open this very dropdown — so the ＋ is the same gesture, one step
  // shorter.
  await newWebTab(page)
  await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })

  // no error page, the address bar is there, and whatever guest the fresh tab brought
  // up sits on about:blank rather than on anything else
  expect(await page.locator(BROWSER.errorPage).count()).toBe(0)
  await expect(addressField(page)).toBeVisible()
  for (const u of await guestUrls(app)) expect(['', 'about:blank']).toContain(u)
})

test('BB-C25: a guest `window.close()` closes only its own tab, never the host window', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  try {
    await addressBarSession(page)
    await typeInAddressBar(page, server.url('/a'))
    await guestByUrl(app, '/a')

    // the second tab comes from the View menu's own item rather than the ＋, which is the
    // gesture this case has always used and which FR-52 makes a direct blank-tab mint here
    // (the active tab is already `web`, so no dropdown stands in between). Kept on this
    // path deliberately: it is the suite's only end-to-end witness that `commandTarget`
    // hands TAB commands to the panel — that routing was gated on "is a page showing" until
    //, which left this item inert on a panel that always opens on `files`.
    await clickAppMenuItem(app, page, BROWSER_MENU_IDS.newTab)
    await typeInAddressBar(page, server.url('/close?n=1'))
    const first = await guestByUrl(app, '/close?n=1')
    await expect(openTabs(page)).toHaveCount(2, { timeout: 30_000 })

    await first.locator('#close-me').click()

    // only its own tab went; the other tab and the Koloft window are untouched
    await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })
    expect((await windowStates(app)).length).toBe(1)
    await expect(browserSurface(page)).toBeVisible()

    // the same call on the LAST web tab. RETARGETED by FR-18/19: it used to collapse the
    // Browser; the panel never collapses from a close now, because `files` is pinned and
    // there is no "last tab" to take it down. What the case is really about — a page's
    // window.close() reaching only its own tab, never the Koloft window — is unchanged.
    await typeInAddressBar(page, server.url('/close?n=2'))
    const last = await guestByUrl(app, '/close?n=2')
    await last.locator('#close-me').click()
    await expect(openTabs(page)).toHaveCount(0, { timeout: 30_000 })
    await expect(browserSurface(page)).toBeVisible()
    await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('files')
    expect((await windowStates(app)).length).toBe(1)
  } finally {
    await server.close()
  }
})

// ---- markdown link handling ---------------------------------------------------------------

test('BB-C52: an md `#anchor` link scrolls within Preview without navigating the renderer', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await runningSession(page)
  await seedWorkspaceFile(
    page,
    env,
    'mdanchor.md',
    '# Anchor fixture\n\n[jump to section](#section)\n\n' +
      Array.from({ length: 200 }, (_, i) => `filler line ${i}`).join('\n\n') +
      '\n\n## Section\n\nkoloft-e2e-anchor-body\n'
  )
  await openInBrowse(page, path.join(env.workspaces.a, 'mdanchor.md'))
  await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('mdanchor.md', { timeout: 30_000 })
  const rendererUrl = page.url()
  const terms = await termIds(page)
  expect(await previewScrollTop(page)).toBe(0)

  await page.locator(`${WORKBENCH.readingBody} a`, { hasText: 'jump to section' }).click()

  await expect.poll(() => previewScrollTop(page), { timeout: 20_000 }).toBeGreaterThan(0)
  expect(page.url()).toBe(rendererUrl)
  expect(await termIds(page)).toEqual(terms)
})

test('BB-C53: an md relative link to a previewable file opens that file in Preview', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await runningSession(page)
  await seedWorkspaceFile(page, env, 'mdtarget.md', '# Target\n\nkoloft-e2e-md-target-body\n')
  await seedWorkspaceFile(
    page,
    env,
    'mdrelative.md',
    '# Relative\n\n[go to target](./mdtarget.md)\n'
  )
  await openInBrowse(page, path.join(env.workspaces.a, 'mdrelative.md'))
  await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('mdrelative.md', {
    timeout: 30_000
  })
  const rendererUrl = page.url()

  await page.locator(`${WORKBENCH.readingBody} a`, { hasText: 'go to target' }).click()

  await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('mdtarget.md', { timeout: 30_000 })
  await expect(page.locator(WORKBENCH.readingBody)).toContainText('koloft-e2e-md-target-body')
  expect(page.url()).toBe(rendererUrl)
})

test('BB-C54: an md external link opens in Browser, not in the renderer', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  try {
    await runningSession(page)
    const url = server.url('/a')
    await seedWorkspaceFile(page, env, 'mdexternal.md', `# External\n\n[open the page](${url})\n`)
    await openInBrowse(page, path.join(env.workspaces.a, 'mdexternal.md'))
    await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('mdexternal.md', {
      timeout: 30_000
    })
    const rendererUrl = page.url()

    await page.locator(`${WORKBENCH.readingBody} a`, { hasText: 'open the page' }).click()

    await expect(browserSurface(page)).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('web')
    await expect
      .poll(() => addressText(page), { timeout: 30_000 })
      .toContain(`${server.host}:${server.port}/a`)
    await expect.poll(() => server.count('/a'), { timeout: 30_000 }).toBeGreaterThan(0)
    expect(page.url()).toBe(rendererUrl)
  } finally {
    await server.close()
  }
})
