import type { Browser, ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './helpers/app'
import type { E2EEnv } from './helpers/env'
import {
  clickAppMenuItem,
  killSession,
  processAlive,
  startSessionIn,
  waitBooted,
  waitForCalls
} from './helpers/p1'
import {
  BROWSER,
  BROWSER_MENU_IDS,
  cdpEndpointOf,
  cdpRefusal,
  connectCdp,
  guestByUrl,
  newWebTab,
  openBrowser,
  openTabs,
  typeInAddressBar
} from './helpers/browser'
import { openSettings } from './helpers/extensions'
import { startEchoServer } from './helpers/fixtureServer'

/**
 * Issue · P1, second half — what happens to a connected client when the world
 * moves: the session it was driving ends, the user closes its tab or its page, the
 * master switch goes off, another session's client arrives.
 *
 * The rule under all of it (§4.3/§4.4): the USER always wins, and the client is always
 * TOLD — a page pulled out from under a command must come back as an error the tool can
 * act on, never as a wait that never ends.
 *
 * Cases: BB-23, BB-30, BB-49, BB-50, BB-51, BB-62. (BB-44's bringToFront is a unit
 * case: the relay answers it with nothing at all. BB-65 retired with the takeover
 * confirmation.)
 */

const endpointOf = cdpEndpointOf

/** a live session in `ws` ('ws-a' / 'ws-b') whose claude launch carries an endpoint.
 *  `startSessionIn` waits for the session to bind, which is the same barrier the old
 *  `auxIcon(page, 'Preview')` gate was. */
async function session(page: Page, env: E2EEnv, ws: string): Promise<string> {
  await waitBooted(page)
  await startSessionIn(page, ws)
  return await endpointOf(env)
}

const connect = connectCdp

// ---- D6: DevTools and the agent on the same page ---------------------------------------
//
// D6 was written for a fight that, measured on Electron 43 / Chromium 150, does not
// happen: `webContents.debugger` and the DevTools frontend hold the same page at the same
// time, in either order, and neither is thrown off. So there is nothing to arbitrate, and
// what these two cases pin is that BOTH sides keep working — the user gets DevTools, the
// agent keeps its grip, and the driving mark stays up so the user knows why the page moves
// on its own. The relay's refusal path (`attach` throwing → an error to the client) is
// still live for a real attach failure; it is simply not what DevTools produces. If a
// future Electron starts kicking one of them off, these are the cases that will say so.

/** how each live guest is currently held: by DevTools, by the relay, by both */
async function guestGrips(
  app: ElectronApplication
): Promise<{ url: string; devtools: boolean; attached: boolean }[]> {
  return app.evaluate(({ webContents }) =>
    webContents
      .getAllWebContents()
      .filter((w) => w.getType() === 'webview')
      .map((w) => ({
        url: w.getURL(),
        devtools: w.isDevToolsOpened(),
        attached: w.debugger.isAttached()
      }))
  )
}

// BB-50 — the user got there first.
test('BB-50: DevTools open on a tab does not lock the agent out of it', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(300_000)
  const server = await startEchoServer()
  try {
    const url = await session(page, env, 'ws-a')
    await openBrowser(page)
    // FR-52: the panel opens on the pinned `files` tab, whose kind bar has no address
    // field at all — a `web` tab has to be minted before any url can be typed
    await newWebTab(page)
    await typeInAddressBar(page, server.page('/guarded', '<title>Guarded</title><body>g</body>'))
    await guestByUrl(app, '/guarded')
    await clickAppMenuItem(app, page, BROWSER_MENU_IDS.devtools)
    await expect
      .poll(async () => (await guestGrips(app)).some((g) => g.devtools), { timeout: 30_000 })
      .toBe(true)

    const browser = await connect(page, url)
    try {
      // the client sees that page and can read it — DevTools took nothing from it
      const seen = browser.contexts()[0].pages()
      expect(seen.length).toBeGreaterThanOrEqual(1)
      const guarded = seen.find((p) => p.url().includes('/guarded'))
      expect(guarded).toBeTruthy()
      expect(await guarded!.title()).toBe('Guarded')

      // …and both grips are on it at once
      const grips = (await guestGrips(app)).filter((g) => g.url.includes('/guarded'))
      expect(grips).toHaveLength(1)
      expect(grips[0]).toMatchObject({ devtools: true, attached: true })
    } finally {
      await browser.close().catch(() => {})
    }
  } finally {
    await server.close()
  }
})

// BB-51 — the reverse order: the agent was already driving when the user reached for
// DevTools. The user gets their inspector; the client is not silently cut off.
test('BB-51: opening DevTools on a driven page takes it from neither side', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(300_000)
  const server = await startEchoServer()
  try {
    const url = await session(page, env, 'ws-a')
    const browser = await connect(page, url)
    try {
      const ctx = browser.contexts()[0]
      const driven = await ctx.newPage()
      await driven.goto(server.page('/driven', '<title>Driven</title><body>d</body>'))
      expect(await driven.title()).toBe('Driven')

      // the user goes and looks at that page — DevTools acts on the tab in front of
      // them, and a client's page is a BACKGROUND tab until they do
      await openBrowser(page)
      // `.first()` would be the pinned `files` tab now (FR-02), which is not a page at
      // all — the client's own tab is the first CLOSABLE one
      await openTabs(page).first().click()
      await expect(page.locator(BROWSER.tabActive)).toHaveCount(1, { timeout: 30_000 })
      await clickAppMenuItem(app, page, BROWSER_MENU_IDS.devtools)
      await expect
        .poll(async () => (await guestGrips(app)).some((g) => g.devtools), { timeout: 30_000 })
        .toBe(true)

      // the client still drives the page it was driving…
      await driven.goto(server.page('/after', '<title>After</title><body>a</body>'))
      expect(await driven.title()).toBe('After')
      expect(browser.isConnected()).toBe(true)

      // …and the user can still see that it is being driven
      await expect(page.locator(BROWSER.drivenTab)).toHaveCount(1, { timeout: 30_000 })
    } finally {
      await browser.close().catch(() => {})
    }
  } finally {
    await server.close()
  }
})

// BB-23/D2 — the master switch is a SECURITY switch: "off" means the tools connected
// right now stop driving, not "off for whatever starts next".
test('BB-23: turning browser control off drops the live connection at once', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(240_000)
  const url = await session(page, env, 'ws-a')
  const browser = await connect(page, url)
  const closed = new Promise<void>((r) => browser.on('disconnected', () => r()))
  try {
    await browser.contexts()[0].newPage()

    await openSettings(page)
    await page.locator('.set-ni', { hasText: 'Extensions' }).click()
    await page
      .locator('.set-row', { hasText: 'Let agents drive this Browser' })
      .locator('button[role="switch"], input[type="checkbox"], .switch')
      .first()
      .click()

    await closed // the client is told, now — not at its next command
    expect(browser.isConnected()).toBe(false)
  } finally {
    await browser.close().catch(() => {})
  }
})

// BB-30/D1 — an endpoint belongs to ONE session: its client sees that session's tabs
// and nothing else. Two sessions, two endpoints, no crossing.
test('BB-30: a client sees only its own session’s tabs', async ({ app, page, env }) => {
  test.setTimeout(300_000)
  await withTwoSessions(page, env, async (a, b) => {
    const clientA = await connect(page, a)
    const clientB = await connect(page, b)
    try {
      const pageA = await clientA.contexts()[0].newPage()
      await pageA.goto('about:blank#a-only')
      const pageB = await clientB.contexts()[0].newPage()
      await pageB.goto('about:blank#b-only')

      // each client sees its own page and NOT the other's — asserted both ways round,
      // so an empty world could never pass this by accident
      const urlsA = clientA
        .contexts()[0]
        .pages()
        .map((p) => p.url())
        .join(' ')
      const urlsB = clientB
        .contexts()[0]
        .pages()
        .map((p) => p.url())
        .join(' ')
      expect(urlsA).toContain('a-only')
      expect(urlsA).not.toContain('b-only')
      expect(urlsB).toContain('b-only')
      expect(urlsB).not.toContain('a-only')
    } finally {
      await clientA.close()
      await clientB.close()
    }
  })
})

// BB-62/§4.3 — the user closes a tab an agent is driving. The user wins, the client is
// told, and its next command on that page is an error rather than a hang.
test('BB-62: the user can close a driven tab; the client is told', async ({ app, page, env }) => {
  test.setTimeout(240_000)
  const server = await startEchoServer()
  try {
    const url = await session(page, env, 'ws-a')
    const browser = await connect(page, url)
    try {
      const p = await browser.contexts()[0].newPage()
      await p.goto(server.url('/a'))
      await openBrowser(page)
      await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })

      const gone = new Promise<void>((r) => p.on('close', () => r()))
      // the pinned `files` tab carries no ✕, so the first one on the strip is the
      // driven tab's
      await page.locator(BROWSER.tabClose).first().click()

      await gone
      await expect(openTabs(page)).toHaveCount(0, { timeout: 30_000 })
      // and the connection is still usable for everything else
      expect(browser.isConnected()).toBe(true)
      await expect(p.title()).rejects.toThrow()
    } finally {
      await browser.close().catch(() => {})
    }
  } finally {
    await server.close()
  }
})

// BB-49/§4.4 — the endpoint belongs to the tab, so closing the tab closes the door. A
// session that DIES ends the same way: its pty exit closes the tab (T-LIFE-05), and the
// client is told its tab went — there is no "cold tab" to keep an endpoint on.
test('BB-49: closing the Koloft tab closes its endpoint', async ({ app, page, env }) => {
  test.setTimeout(240_000)
  const url = await session(page, env, 'ws-a')
  const browser = await connect(page, url)
  const closed = new Promise<void>((r) => browser.on('disconnected', () => r()))
  try {
    await browser.contexts()[0].newPage()
    // close the session's tab the way the user does
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('shortcut:close-tab')
    })

    await closed
    // …and the key does not work any more: the path is gone, not merely idle
    expect(await cdpRefusal(url)).toEqual({ code: 1008, reason: 'unknown endpoint' })
  } finally {
    await browser.close().catch(() => {})
  }
})

/** two live sessions, in two workspaces, with an endpoint each */
async function withTwoSessions(
  page: Page,
  env: E2EEnv,
  fn: (a: string, b: string) => Promise<void>
): Promise<void> {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  const a = await endpointOf(env)

  // the positive barrier is the SECOND session BINDING, not just its launch record: the
  // endpoint exists from launch, but a client is only routed once the session binds —
  // which is exactly what `startSessionIn` waits for
  await startSessionIn(page, 'ws-b')
  const b = await endpointOf(env)
  expect(b).not.toBe(a)

  await fn(a, b)
}
