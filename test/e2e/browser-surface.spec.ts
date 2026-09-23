import http from 'http'
import type { Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import { setGuestLimit, type E2EEnv } from './helpers/env'
import { gitInit, startSessionIn } from './helpers/p1'
import {
  BROWSER,
  addressValue,
  guestByUrl,
  guestContents,
  globeIcon,
  navButton,
  navDisabled,
  newWebTab,
  openBrowser,
  openTabs,
  pinnedTab,
  readExternalOpens,
  readOpenCalls,
  typeInAddressBar
} from './helpers/browser'
import { wbFrozenTabs, wbTabByTitle } from './helpers/workbench'
import { startEchoServer, type FixtureServer } from './helpers/fixtureServer'

/**
 * The Workbench's `web` kind (FR-36/37 — "the merge changes none of it"): the
 * tab strip, the address bar and its history autocomplete, back/forward, reload/stop, the
 * progress line, the ↗ escape hatch, the empty state, the standard error page with a
 * manual Retry, and the two capacity boundaries (per-kind 8-tab cap, global live-guest
 * cap through KOLOFT_BROWSER_GUEST_LIMIT — freeze, never close). Case ids are the original
 * case list's; the spec carrying an id IS its contract.
 *
 * Black box: nothing here imports from src/, every oracle is the one the case names
 * (tab strip DOM, address-bar text, the echo server's request log, the external-open
 * choke point, Koloft's toast).
 */

/** a page whose <title> is `name`, so the tab strip carries a decidable label */
function titled(name: string): string {
  return (
    `<!doctype html><html><head><meta charset="utf-8"><title>${name}</title></head>` +
    `<body><h1 id="mark">${name}</h1></body></html>`
  )
}

/**
 * A running session in ws-a with the panel showing (the Given of most cases).
 *
 * `openBrowser` no longer chooses a SURFACE — there is only one — it chooses T1 vs T2, and
 * the panel is open by DEFAULT after the merge (`workbench.defaultOpen`, FR-06), so it is
 * a no-op here more often than not.
 */
async function sessionWithWorkbench(page: Page, env: E2EEnv): Promise<void> {
  await startSessionIn(page, 'ws-a')
  // the titlebar icon is the panel's only pointer entry point — fail here, fast, when it
  // is missing, instead of burning the whole test budget on an invisible surface
  await expect(globeIcon(page)).toBeVisible({ timeout: 20_000 })
  await openBrowser(page)
}

/**
 * Open one more tab on `url` the way the strip offers it: ＋ ▸ New web tab (FR-52), then
 * the address bar. There is no bare "＋ = new browser tab" any more, and no url can be
 * typed before a `web` tab exists — the panel opens on the pinned `files` tab, whose kind
 * bar has no address field at all.
 */
async function openTabOn(page: Page, url: string): Promise<void> {
  await newWebTab(page)
  await expect(page.locator(BROWSER.addressField).first()).toBeVisible({ timeout: 20_000 })
  await typeInAddressBar(page, url)
}

/** Open a tab on `/<name>` and wait until the strip shows that page's title. */
async function openLoadedTab(page: Page, server: FixtureServer, name: string): Promise<void> {
  const url = server.page(`/${name.toLowerCase()}`, titled(name))
  await openTabOn(page, url)
  // An unloaded tab is labelled from its url (host/lastSegment), and `/x` already
  // contains "X" — so a substring match would return before the page reported its title
  // and leave the next assertion racing it. Wait for the label to BE the title.
  await expect(page.locator(`${BROWSER.tabActive} ${BROWSER.tabLabel}`)).toHaveText(name, {
    timeout: 30_000
  })
  await expect(wbTabByTitle(page, name)).toHaveCount(1, { timeout: 30_000 })
}

// ---- address bar -----------------------------------------------------------------

test('BB-M04: typing a URL in the address bar and submitting loads it in the active tab', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  gitInit(env.workspaces.a)
  const server = await startEchoServer()
  try {
    await sessionWithWorkbench(page, env)

    const url = server.localhostUrl('/a')
    await openTabOn(page, url)

    // the guest navigated there, and the server really served it
    await guestByUrl(app, `:${server.port}/a`)
    await expect.poll(() => server.count('/a'), { timeout: 20_000 }).toBeGreaterThanOrEqual(1)
    // …and the address bar's resting display shows the normalized url
    await expect
      .poll(() => addressValue(page), { timeout: 15_000 })
      .toMatch(new RegExp(`localhost:${server.port}/a`))
  } finally {
    await server.close()
  }
})

// The address bar remembers where the user has been: while they type, pages whose url or
// TITLE match are offered, and picking one navigates there. The title is the oracle on
// purpose — `zeb` submitted as typed would go to the search engine, so only a real pick
// can put a second request for /z in the server's log.
test('BB-M04c: the address bar offers a visited page by its title, and picking it navigates there', async ({
  page,
  env
}) => {
  test.setTimeout(180_000)
  gitInit(env.workspaces.a)
  const server = await startEchoServer()
  try {
    await sessionWithWorkbench(page, env)

    await openTabOn(page, server.page('/z', titled('Zebra')))
    await expect(page.locator(`${BROWSER.tabActive} ${BROWSER.tabLabel}`)).toHaveText('Zebra', {
      timeout: 30_000
    })

    await newWebTab(page)
    await typeInAddressBar(page, 'zeb', { submit: false })
    const row = page.locator(BROWSER.suggestRow).filter({ hasText: '/z' })
    await expect(row).toHaveCount(1, { timeout: 20_000 })

    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')

    await expect.poll(() => server.count('/z'), { timeout: 20_000 }).toBe(2)
    await expect
      .poll(() => addressValue(page), { timeout: 20_000 })
      .toMatch(new RegExp(`:${server.port}/z$`))
  } finally {
    await server.close()
  }
})

// ---- back / forward ---------------------------------------------------------------

test('BB-M07: an in-page link click navigates the tab, and Back returns to the prior page', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  gitInit(env.workspaces.a)
  const server = await startEchoServer()
  try {
    await sessionWithWorkbench(page, env)
    await openTabOn(page, server.url('/a'))
    const guest = await guestByUrl(app, `:${server.port}/a`)

    // the in-page link navigates THIS tab to B
    await guest.locator('#to-b').click()
    await expect.poll(() => addressValue(page), { timeout: 20_000 }).toContain('/b')
    await expect.poll(() => server.count('/b'), { timeout: 20_000 }).toBeGreaterThanOrEqual(1)

    // …and Back returns it to A — the page is not stranded with no way back
    await navButton(page, 'Back').click()
    await expect.poll(() => addressValue(page), { timeout: 20_000 }).toContain('/a')
  } finally {
    await server.close()
  }
})

test('BB-M08: back/forward reflect history and are disabled at the ends', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  gitInit(env.workspaces.a)
  const server = await startEchoServer()
  try {
    await sessionWithWorkbench(page, env)
    await openTabOn(page, server.url('/a'))
    const guest = await guestByUrl(app, `:${server.port}/a`)

    // freshly opened on a single page: no history in either direction
    expect(await navDisabled(page, 'Back')).toBe(true)
    expect(await navDisabled(page, 'Forward')).toBe(true)

    // one navigation forward: Back lights up, Forward stays disabled
    await guest.locator('#to-b').click()
    await expect.poll(() => addressValue(page), { timeout: 20_000 }).toContain('/b')
    await expect.poll(() => navDisabled(page, 'Back'), { timeout: 15_000 }).toBe(false)
    expect(await navDisabled(page, 'Forward')).toBe(true)

    // …until a Back is performed
    await navButton(page, 'Back').click()
    await expect.poll(() => addressValue(page), { timeout: 20_000 }).toContain('/a')
    await expect.poll(() => navDisabled(page, 'Forward'), { timeout: 15_000 }).toBe(false)
  } finally {
    await server.close()
  }
})

// ---- reload / stop / progress ------------------------------------------------------

test('BB-M09: Reload re-fetches the guest, and a load in flight can be stopped', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(240_000)
  gitInit(env.workspaces.a)
  const server = await startEchoServer()
  try {
    await sessionWithWorkbench(page, env)
    await openTabOn(page, server.url('/a'))
    const guest = await guestByUrl(app, `:${server.port}/a`)
    await expect.poll(() => server.count('/a'), { timeout: 20_000 }).toBe(1)

    // Reload → a second request
    await navButton(page, 'Reload').click()
    await expect.poll(() => server.count('/a'), { timeout: 20_000 }).toBe(2)

    // a response that stays in flight for 5s: the reload control presents as Stop
    await typeInAddressBar(page, server.url('/slow?ms=5000'))
    await expect(navButton(page, 'Stop')).toBeVisible({ timeout: 20_000 })
    await navButton(page, 'Stop').click()
    await expect(navButton(page, 'Reload')).toBeVisible({ timeout: 20_000 })

    // …and the pending navigation really stopped: past the server's own completion
    // mark the tail of the document has still never arrived
    await page.waitForTimeout(9_000)
    expect(await guest.locator('#slow-head').count()).toBe(1)
    expect(await guest.locator('#slow-done').count()).toBe(0)
  } finally {
    await server.close()
  }
})

test('BB-M10: a load in progress shows a progress indicator that clears on completion', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(240_000)
  gitInit(env.workspaces.a)
  const server = await startEchoServer()
  try {
    await sessionWithWorkbench(page, env)
    await openTabOn(page, server.url('/a'))
    const guest = await guestByUrl(app, `:${server.port}/a`)

    // a 6s response: present while loading…
    await typeInAddressBar(page, server.url('/slow?ms=6000'))
    await expect(page.locator(BROWSER.progress)).toBeVisible({ timeout: 20_000 })

    // …absent once the load has finished
    await expect(guest.locator('#slow-done')).toBeVisible({ timeout: 40_000 })
    await expect(page.locator(BROWSER.progress)).toHaveCount(0, { timeout: 20_000 })
  } finally {
    await server.close()
  }
})

// ---- the ↗ escape hatch -------------------------------------------------------------

test('BB-M11: the ↗ external-open button hands the current URL to the system browser', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  gitInit(env.workspaces.a)
  const server = await startEchoServer()
  try {
    await sessionWithWorkbench(page, env)
    const url = server.localhostUrl('/a')
    await openTabOn(page, url)
    await guestByUrl(app, `:${server.port}/a`)

    await navButton(page, 'Open in system browser').click()

    // exactly that url reached the "leave Koloft" choke point — the only sanctioned way
    // an http url gets to the OS
    await expect
      .poll(() => [...readExternalOpens(env), ...readOpenCalls(env)], { timeout: 20_000 })
      .toEqual([url])
  } finally {
    await server.close()
  }
})

// ---- empty state / error page ---------------------------------------------------------

// RETARGETED by the merge (FR-02/FR-52): "an empty tab set" no longer exists — the strip
// always carries the pinned `files` tab, whose content is the Files surface, not the
// Browser's empty state. The empty state moved WITH the `web` kind: it is what a blank web
// tab shows, and the three entry points plus the focused address bar are unchanged.
test('BB-C32: a blank web tab shows the three-entry empty state with the address bar focused', async ({
  page,
  env
}) => {
  test.setTimeout(180_000)
  gitInit(env.workspaces.a)
  await sessionWithWorkbench(page, env)

  // Given: nothing the user opened is in the strip yet — only the pinned `files` tab
  await expect(openTabs(page)).toHaveCount(0)
  await expect(pinnedTab(page)).toHaveClass(/\bon\b/)

  await newWebTab(page)

  await expect(openTabs(page)).toHaveCount(1)
  const empty = page.locator(BROWSER.emptyState)
  await expect(empty).toBeVisible({ timeout: 20_000 })
  // the three entry points of §05B, asserted structurally (the PRD fixes no copy)
  await expect(empty).toContainText(/⌘\s*L/)
  await expect(empty).toContainText(/terminal/i)
  await expect(empty).toContainText(/Claude|agent/i)
  // …and the keyboard lands in the address bar. This is the one assertion the merge made
  // load-bearing rather than incidental: coming from the pinned `files` tab, the address
  // row is mounted only by the render the tab creation schedules, so a focus call that
  // does not wait for that commit reaches nothing — and the find bar's own
  // "one bar at a time" cleanup runs on the same tab switch and can take the focus back.
  // Both were live bugs; this is what catches either of them returning.
  await expect
    .poll(() => page.evaluate(() => document.activeElement?.closest('.wb-panel .baddr') !== null), {
      timeout: 15_000
    })
    .toBe(true)
})

test('BB-M22: a load failure shows the standard error page with a working Retry', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(240_000)
  gitInit(env.workspaces.a)
  // take a port, then give it back: navigating to it is a real connection refusal, and
  // the same port can be brought up again for the Retry half
  const parked = await startEchoServer()
  const port = parked.port
  const url = parked.url('/a')
  await parked.close()

  const hits: string[] = []
  const revived = http.createServer((req, res) => {
    hits.push(req.url ?? '')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(
      '<!doctype html><html><head><title>Revived</title></head><body><h1 id="revived">koloft-e2e-retry-ok</h1></body></html>'
    )
  })
  try {
    await sessionWithWorkbench(page, env)
    await openTabOn(page, url)

    // the standard error page: an error code and a Retry button
    const errorPage = page.locator(BROWSER.errorPage)
    await expect(errorPage).toBeVisible({ timeout: 30_000 })
    await expect(errorPage).toContainText(/ERR_[A-Z_]+/)
    await expect(page.locator(BROWSER.retry)).toBeVisible()

    // bring the server up — nothing may retry on its own (D14)
    await new Promise<void>((ok) => revived.listen(port, '127.0.0.1', ok))
    await page.waitForTimeout(4_000)
    expect(hits).toEqual([])

    // …and the click really reloads
    await page.locator(BROWSER.retry).click()
    const guest = await guestByUrl(app, `:${port}/a`)
    await expect(guest.locator('#revived')).toBeVisible({ timeout: 20_000 })
  } finally {
    await new Promise<void>((ok) => revived.close(() => ok()))
  }
})

// ---- dedup: user re-open ---------------------------------------------------------------

test('BB-C01: a user re-open of an existing URL reuses and activates that tab', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(240_000)
  gitInit(env.workspaces.a)
  const server = await startEchoServer()
  try {
    await sessionWithWorkbench(page, env)
    // tab A opens tab B on /b, then A is made current again → [A(active), B]
    await openTabOn(page, server.url('/link?href=/b&blank=1'))
    const opener = await guestByUrl(app, `:${server.port}/link`)
    await opener.locator('#link').click()
    await expect(openTabs(page)).toHaveCount(2, { timeout: 30_000 })
    await expect(wbTabByTitle(page, 'Page B')).toHaveCount(1)
    await wbTabByTitle(page, 'Link').click()
    await expect(wbTabByTitle(page, 'Link')).toHaveClass(/\bon\b/, { timeout: 20_000 })

    // the user opens B's url a second time
    await opener.locator('#link').click()

    // no second tab, and B is the active one
    await expect(wbTabByTitle(page, 'Page B')).toHaveClass(/\bon\b/, { timeout: 30_000 })
    await expect(openTabs(page)).toHaveCount(2)
  } finally {
    await server.close()
  }
})

// ---- per-kind tab cap (8, and one past it) ------------------------------------------------

test('BB-C04: a per-session tab count of 8 is allowed', async ({ page, env }) => {
  test.setTimeout(300_000)
  gitInit(env.workspaces.a)
  const server = await startEchoServer()
  try {
    await sessionWithWorkbench(page, env)
    for (let i = 1; i <= 7; i++) await openLoadedTab(page, server, `T${i}`)
    await expect(openTabs(page)).toHaveCount(7)

    await openLoadedTab(page, server, 'T8')

    // all 8 coexist — nothing was evicted. The `n/8` counter that used to say so with
    // the strip retired in the merge (the panel renders none), so the strip itself is
    // the whole oracle now; FR-22 is otherwise unchanged.
    await expect(openTabs(page)).toHaveCount(8)
    await expect(wbTabByTitle(page, 'T1')).toHaveCount(1)
    // the pinned `files` tab is exempt from the per-kind cap (FR-02/FR-22)
    await expect(pinnedTab(page)).toHaveCount(1)
  } finally {
    await server.close()
  }
})

test('BB-C05: opening a 9th tab evicts the oldest-unseen non-current tab with a toast', async ({
  page,
  env
}) => {
  test.setTimeout(300_000)
  gitInit(env.workspaces.a)
  const server = await startEchoServer()
  try {
    await sessionWithWorkbench(page, env)
    // T1..T8, each current when it was created → T1 is the oldest-unseen non-current tab
    for (let i = 1; i <= 8; i++) await openLoadedTab(page, server, `T${i}`)
    await expect(openTabs(page)).toHaveCount(8)

    await openTabOn(page, server.page('/t9', titled('T9')))

    // a toast names the tab that was closed
    await expect(page.locator('.toast')).toHaveText(/t1/i, { timeout: 20_000 })
    // …and it is a real close, not a freeze: gone from the strip, not restorable
    await expect(wbTabByTitle(page, 'T1')).toHaveCount(0)
    await expect(wbFrozenTabs(page)).toHaveCount(0)
    await expect(wbTabByTitle(page, 'T9')).toHaveCount(1, { timeout: 30_000 })
    await expect(openTabs(page)).toHaveCount(8)
  } finally {
    await server.close()
  }
})

// ---- global live-guest cap (at the cap, and one past it) -----------------------------------

test('BB-C06: the global live-guest count at the cap is allowed', async ({ env }) => {
  test.setTimeout(300_000)
  gitInit(env.workspaces.a)
  setGuestLimit(env, 2)
  const server = await startEchoServer()
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await sessionWithWorkbench(page, env)

    await openLoadedTab(page, server, 'T1')
    await openLoadedTab(page, server, 'T2')

    // exactly at the cap: both guests are still live, neither was frozen
    await expect(wbFrozenTabs(page)).toHaveCount(0)
    await expect
      .poll(async () => (await guestContents(app)).filter((g) => /\/t[12]$/.test(g.url)).length, {
        timeout: 20_000
      })
      .toBe(2)
  } finally {
    await app.close().catch(() => {})
    await server.close()
  }
})

test('BB-C07: exceeding the global live-guest cap freezes the LRU guest, which reloads on reopen', async ({
  env
}) => {
  test.setTimeout(300_000)
  gitInit(env.workspaces.a)
  setGuestLimit(env, 2)
  const server = await startEchoServer()
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await sessionWithWorkbench(page, env)

    await openLoadedTab(page, server, 'T1')
    await openLoadedTab(page, server, 'T2')
    expect(server.count('/t1')).toBe(1)

    // a third url needs a live guest → the least-recently-used one (T1) gives way
    await openLoadedTab(page, server, 'T3')

    // frozen, not closed: still in the strip, still carrying its title
    await expect(wbTabByTitle(page, 'T1')).toHaveClass(/\bfrozen\b/, { timeout: 30_000 })
    await expect(openTabs(page)).toHaveCount(3)
    await expect(wbTabByTitle(page, 'T1')).toContainText('T1')

    // clicking it reloads from its url
    await wbTabByTitle(page, 'T1').click()
    await expect.poll(() => server.count('/t1'), { timeout: 30_000 }).toBe(2)
  } finally {
    await app.close().catch(() => {})
    await server.close()
  }
})
