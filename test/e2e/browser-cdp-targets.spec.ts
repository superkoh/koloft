import { chromium, type Browser, type Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import { setGuestLimit, type E2EEnv } from './helpers/env'
import { centerTerm, runIn, startSessionIn, waitBooted } from './helpers/p1'
import {
  BROWSER,
  addressField,
  cdpEndpointOf,
  closeBrowser,
  crashGuest,
  guestContents,
  newWebTab,
  openBrowser,
  openTabs,
  openViaAgent,
  tabByTitle,
  typeInAddressBar
} from './helpers/browser'
import { startEchoServer } from './helpers/fixtureServer'

/**
 * Issue · P1 — the target list itself: what a client is shown, what that costs,
 * and what happens to it when the tab starts running a different session.
 *
 * BB-32/33 use a BARE WebSocket client rather than Playwright: `connectOverCDP`
 * auto-attaches to everything it finds, which would load every page it was told about
 * and destroy the very state under test ("listed, not loaded"). Node's own global
 * WebSocket is enough to ask one question.
 *
 * Cases: BB-32/33, BB-38, BB-39, BB-47, BB-59, BB-60, BB-61, BB-68.
 */

interface RawClient {
  send(method: string, params?: unknown, sessionId?: string): Promise<Record<string, unknown>>
  close(): void
}

/** a CDP client that does nothing it is not told to do */
async function rawClient(page: Page, url: string): Promise<RawClient> {
  const ws = new WebSocket(url)
  const pending = new Map<number, (msg: Record<string, unknown>) => void>()
  let id = 0
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(String(e.data)) as Record<string, unknown>
    if (typeof msg.id === 'number') pending.get(msg.id)?.(msg)
  })
  const open = new Promise<void>((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => reject(new Error('the endpoint refused the connection')))
  })
  await open
  return {
    send: (method, params, sessionId) =>
      new Promise((resolve) => {
        id += 1
        pending.set(id, resolve)
        ws.send(JSON.stringify({ id, method, params: params ?? {}, sessionId }))
      }),
    close: () => ws.close()
  }
}

/** a live session in ws-a whose claude launch carries an endpoint. `startSessionIn`
 *  waits for the session to bind, which is the barrier the old Preview-icon gate was. */
async function session(page: Page, env: E2EEnv): Promise<string> {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  return await cdpEndpointOf(env)
}

// BB-32/33/D4 — every tab is listed, including the ones that have never run, and listing
// is free: the page behind an unread agent tab is not fetched to answer a question about
// it (the whole reason an agent's open does not load). Attaching is what loads it, and it
// loads in the background: no tab is activated and no pane opens.
test('BB-32/33: every tab is listed without loading any; attaching loads it, in the background', async ({
  page,
  env
}) => {
  test.setTimeout(240_000)
  const server = await startEchoServer()
  try {
    const url = await session(page, env)
    // an agent-opened tab: listed, never loaded until someone looks at it
    await openViaAgent(page, server.url('/a'))
    await openBrowser(page)
    await expect(openTabs(page)).toHaveCount(1, { timeout: 40_000 })
    expect(server.count('/a')).toBe(0) // the barrier this case rests on

    const client = await rawClient(page, url)
    try {
      const list = (await client.send('Target.getTargets')) as {
        result: { targetInfos: { targetId: string; type: string; url: string }[] }
      }
      // BB-32: all of them, all "page", and the listing fetched nothing
      expect(list.result.targetInfos.every((t) => t.type === 'page')).toBe(true)
      const target = list.result.targetInfos.find((t) => t.url.includes('/a'))
      expect(target).toBeTruthy()
      expect(server.count('/a')).toBe(0)

      // BB-33
      const attached = (await client.send('Target.attachToTarget', {
        targetId: target?.targetId,
        flatten: true
      })) as { result?: { sessionId?: string } }
      expect(attached.result?.sessionId).toBeTruthy()

      // the positive receipt: the page really loaded now
      await expect.poll(() => server.count('/a'), { timeout: 40_000 }).toBeGreaterThan(0)
      // …and the strip did not switch to it (the agent tab is still unread)
      await expect(page.locator(BROWSER.tabAgent)).toHaveCount(1)
    } finally {
      client.close()
    }
  } finally {
    await server.close()
  }
})

// BB-47/BB-59/§4.4 — the endpoint belongs to the TAB, not to the session running in it.
// `/clear` gives the tab a new session id: the old tab set leaves, the new one arrives,
// and the client never loses its connection.
test('BB-47/59: /clear swaps the tab set under a connected client, connection intact', async ({
  page,
  env
}) => {
  test.setTimeout(300_000)
  const url = await session(page, env)
  let browser: Browser | null = null
  try {
    const pending = chromium.connectOverCDP(url)
    browser = await pending

    const p = await browser.contexts()[0].newPage()
    const gone = new Promise<void>((r) => p.on('close', () => r()))

    // the same pty, a brand-new session id
    await runIn(page, centerTerm(page), '/clear')

    await gone // the old session's pages are reported destroyed…
    expect(browser.isConnected()).toBe(true) // …and the endpoint is still the tab's

    // the client can drive the NEW session straight away
    const fresh = await browser.contexts()[0].newPage()
    expect(fresh).toBeTruthy()
  } finally {
    await browser?.close().catch(() => {})
  }
})

// BB-60 — the guest survives the panel being opened and closed while it is driven:
// off screen it lives on the stage, on screen it is an ordinary tab, and it is the SAME
// page throughout (no reload, no detach).
test('BB-60: a driven page survives the Browser column opening and closing', async ({
  page,
  env
}) => {
  test.setTimeout(300_000)
  const server = await startEchoServer()
  try {
    const url = await session(page, env)
    // the fixture ships the panel expanded (workbench.defaultOpen), so the loop below
    // would start from `open` and never put the page on the stage at all
    await closeBrowser(page)
    const pending = chromium.connectOverCDP(url)
    const browser = await pending
    try {
      const p = await browser.contexts()[0].newPage()
      await p.goto(server.page('/mark', '<body><div id="out">idle</div></body>'))
      // a value that only survives if the page is never reloaded
      await p.evaluate(() => {
        document.getElementById('out')!.textContent = 'kept'
      })

      for (const step of ['open', 'close', 'open'] as const) {
        if (step === 'open') await openBrowser(page)
        else await closeBrowser(page)
        await page.waitForTimeout(500)

        expect(await p.textContent('#out')).toBe('kept')
        const shot = await p.screenshot({ timeout: 30_000 })
        expect(shot.length).toBeGreaterThan(200)
      }
      // one load, from first to last — the page was never remounted underneath
      expect(server.count('/mark')).toBe(1)
    } finally {
      await browser.close().catch(() => {})
    }
  } finally {
    await server.close()
  }
})

// S1 — the stage holds EVERY guest a client is holding or mounting, not just the newest
// one. The mount half of that rule (two fresh guests mounting at once, where a single
// slot hid the first before it reached did-attach) is NOT pinned here: the collision
// lives inside one render cycle, and neither two back-to-back attaches (browser-level,
// so the relay runs them in order) nor two open requests dropped in the same instant
// reach it — both passed against a deliberately single-slot build. The capture half
// below is the observable one.
//
// S1, the other half — two driven pages, both asked for a picture at the same time.
//
// A capture reads real pixels, and only a guest that is genuinely visible produces any:
// off screen the stage is what gives one a box. While the stage was ONE slot, the second
// request took it from the first, whose guest went hidden again — and a capture on a
// hidden guest never answers at all (measured), so that screenshot hung until its own
// timeout. Nothing serialises the two: they are two pages of one client.
test('S1: two driven pages can be captured at the same time', async ({ page, env }) => {
  test.setTimeout(300_000)
  const server = await startEchoServer()
  try {
    const url = await session(page, env)
    // the fixture ships the panel expanded, and an expanded panel would give ONE of the
    // two a box of its own — off screen, the stage is the only source of pixels
    await closeBrowser(page)
    const pending = chromium.connectOverCDP(url)
    const browser = await pending
    try {
      const ctx = browser.contexts()[0]
      const first = await ctx.newPage()
      await first.goto(server.page('/shot-a', '<title>A</title><body>aaa</body>'))
      const second = await ctx.newPage()
      await second.goto(server.page('/shot-b', '<title>B</title><body>bbb</body>'))

      const shots = await Promise.all([
        first.screenshot({ timeout: 45_000 }),
        second.screenshot({ timeout: 45_000 })
      ])
      for (const shot of shots) expect(shot.length).toBeGreaterThan(200)
    } finally {
      await browser.close().catch(() => {})
    }
  } finally {
    await server.close()
  }
})

// BB-38/39/D5 — at the cap, a page an agent is driving is not a candidate for eviction:
// closing it would pull the page out from under a running command. When every tab the
// cap could take is being driven, the client's own request is REFUSED (a standard error
// it can act on) rather than one of its pages being closed.
test('BB-38/39: the tab cap refuses a client rather than close a page it is driving', async ({
  env
}) => {
  test.setTimeout(300_000)
  // `env` alone: the seam has to be in place BEFORE the app starts, and the auto-launched
  // fixture would already be holding this userData dir
  env.launchEnv.KOLOFT_BROWSER_TAB_CAP = '2'
  const started = await launchApp(env)
  try {
    const host = await started.firstWindow()
    await host.waitForLoadState('domcontentloaded')
    await waitBooted(host)
    await startSessionIn(host, 'ws-a')
    const url = await cdpEndpointOf(env)

    const pending = chromium.connectOverCDP(url)
    const browser = await pending
    try {
      const ctx = browser.contexts()[0]
      const first = await ctx.newPage()
      const second = await ctx.newPage()
      expect(ctx.pages().length).toBeGreaterThanOrEqual(2)

      // the third is refused — with a message, not by sacrificing one of the two
      await expect(ctx.newPage()).rejects.toThrow()
      expect(first.isClosed()).toBe(false)
      expect(second.isClosed()).toBe(false)
      await openBrowser(host)
      await expect(openTabs(host)).toHaveCount(2)

      // …and letting one go makes room again
      await second.close()
      await expect(openTabs(host)).toHaveCount(1, { timeout: 30_000 })
      const third = await ctx.newPage()
      expect(third).toBeTruthy()
    } finally {
      await browser.close().catch(() => {})
    }
  } finally {
    await started.close().catch(() => {})
  }
})

/** open a new tab on `url` the way the user does — ＋, then the address bar. The wait
 *  between the two is load-bearing here: the address bar belongs to whichever tab is
 *  current, so typing before ＋ has actually produced one navigates the tab that was
 *  already there — which, in these cases, is a page an agent is driving. */
async function openTabOn(page: Page, url: string): Promise<void> {
  const before = await openTabs(page).count()
  // FR-52: ＋ is a two-item dropdown now, not a one-click new tab
  await newWebTab(page)
  await expect(openTabs(page)).toHaveCount(before + 1, { timeout: 30_000 })
  // existing is not enough — it has to be the CURRENT one, which is what the blank
  // tab's own label says
  await expect(page.locator(`${BROWSER.tabActive} ${BROWSER.tabLabel}`)).toHaveText('New tab', {
    timeout: 30_000
  })
  await expect(addressField(page)).toBeVisible({ timeout: 20_000 })
  await typeInAddressBar(page, url)
}

// BB-40/D5 — the OTHER cap. The global live-guest budget evicts least-recently-used, and
// the page a client is driving is the oldest guest of all by the time the user opens
// anything: without the pin it is the first one the budget takes, and the client's grip
// dies silently. The pin has to make the budget step over it and take a user tab instead.
test('BB-40: the live-guest budget steps over the guest a client is driving', async ({ env }) => {
  test.setTimeout(300_000)
  // both seams must be in place BEFORE the app starts (see BB-38/39)
  setGuestLimit(env, 2)
  const server = await startEchoServer()
  const started = await launchApp(env)
  try {
    const host = await started.firstWindow()
    await host.waitForLoadState('domcontentloaded')
    await waitBooted(host)
    await startSessionIn(host, 'ws-a')
    const url = await cdpEndpointOf(env)

    const pending = chromium.connectOverCDP(url)
    const browser = await pending
    try {
      const driven = await browser.contexts()[0].newPage()
      const drivenUrl = server.page(
        '/driven',
        '<title>Driven</title><body><div id="out">driven</div></body>'
      )
      await driven.goto(drivenUrl)

      // two user tabs, each loaded: with a budget of two, something must give both times
      await openBrowser(host)
      await openTabOn(host, server.page('/u1', '<title>U1</title><body>u1</body>'))
      await expect(tabByTitle(host, 'U1')).toHaveCount(1, { timeout: 30_000 })
      await openTabOn(host, server.page('/u2', '<title>U2</title><body>u2</body>'))
      await expect(tabByTitle(host, 'U2')).toHaveCount(1, { timeout: 30_000 })

      // what gave was a user tab, never the driven page — it still has a live guest…
      await expect
        .poll(
          async () =>
            (await guestContents(started)).filter((g) => g.url.includes('/driven')).length,
          { timeout: 20_000 }
        )
        .toBe(1)
      // …and the client can still reach it, which is the point of not evicting it
      expect(await driven.title()).toBe('Driven')
      expect(await driven.locator('#out').textContent()).toBe('driven')
    } finally {
      await browser.close().catch(() => {})
    }
  } finally {
    await started.close().catch(() => {})
    await server.close()
  }
})

// §4.2 — connecting to a session that already has pages open. A client's handshake
// auto-attaches every listed tab, one after another, and each attach waits for the
// guest's first load to settle. A guest that finished loading long ago has nothing left
// to settle: charging it the full grace period anyway makes the handshake cost
// grace × tabs, which on a strip of open pages passes Playwright's own connect timeout
// and the client reports a browser it cannot reach. Three loaded tabs, one handshake,
// well under one grace period per tab.
test('a handshake over already-loaded tabs does not pay a settle wait per tab', async ({
  page,
  env
}) => {
  test.setTimeout(240_000)
  const server = await startEchoServer()
  try {
    const url = await session(page, env)
    await openBrowser(page)
    for (const name of ['P1', 'P2', 'P3']) {
      await openTabOn(
        page,
        server.page(`/${name.toLowerCase()}`, `<title>${name}</title><body>${name}</body>`)
      )
      await expect(tabByTitle(page, name)).toHaveCount(1, { timeout: 30_000 })
    }

    const started = Date.now()
    const pending = chromium.connectOverCDP(url)
    const browser = await pending
    try {
      const pages = browser.contexts()[0].pages()
      const took = Date.now() - started
      expect(pages.length).toBeGreaterThanOrEqual(3)
      // three settled tabs at a 4s grace each would be ≥12s; the bound leaves room for a
      // slow machine but none for paying the grace per tab
      expect(took).toBeLessThan(6_000)
    } finally {
      await browser.close().catch(() => {})
    }
  } finally {
    await server.close()
  }
})

// BB-68 — a cross-origin iframe attaches as its own sub-session, and the relay learns
// about it from the guest's own announcement (which arrives on the ROOT session, with
// the child's id inside the payload). Miss that and the client's first command to the
// frame comes back "no session": iframes become undrivable.
test('BB-68: a cross-origin iframe is reachable through its own sub-session', async ({
  page,
  env
}) => {
  test.setTimeout(300_000)
  const server = await startEchoServer()
  try {
    const url = await session(page, env)
    // 127.0.0.1 and localhost are the same server and DIFFERENT origins — a real
    // out-of-process iframe without needing a second host
    server.page('/frame-child', '<body><div id="inner">from the iframe</div></body>')
    const child = server.localhostUrl('/frame-child')
    const parent = server.page(
      '/frame-parent',
      `<body><h1>parent</h1><iframe src="${child}" width="300" height="200"></iframe></body>`
    )

    const pending = chromium.connectOverCDP(url)
    const browser = await pending
    try {
      const p = await browser.contexts()[0].newPage()
      await p.goto(parent)

      await expect.poll(() => p.frames().length, { timeout: 30_000 }).toBeGreaterThan(1)
      const frame = p.frames().find((f) => f.url().includes('/frame-child'))
      expect(frame).toBeTruthy()
      expect(await frame!.textContent('#inner')).toContain('from the iframe')
    } finally {
      await browser.close().catch(() => {})
    }
  } finally {
    await server.close()
  }
})

// BB-61/§4.3 — the page an agent is driving crashes. The client must be TOLD (a crash
// that reads as a command which simply never answers is the worst outcome), and the tab
// itself must survive: Koloft shows its own crash placeholder and the page is reloadable.
test('BB-61: a crash of a driven page is reported, and the tab survives it', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(300_000)
  const server = await startEchoServer()
  try {
    const url = await session(page, env)
    const pending = chromium.connectOverCDP(url)
    const browser = await pending
    try {
      const p = await browser.contexts()[0].newPage()
      await p.goto(server.url('/a'))
      await openBrowser(page)
      await expect(openTabs(page)).toHaveCount(1, { timeout: 30_000 })

      await crashGuest(app, '/a')

      // whichever way it surfaces — a crash event, the page closing, or the next
      // command failing — the client is TOLD. A title that simply comes back would mean
      // the crash reached nobody, which is the outcome this case exists to refuse.
      const outcome = await Promise.race([
        new Promise<string>((r) => p.on('crash', () => r('crash'))),
        new Promise<string>((r) => p.on('close', () => r('close'))),
        p
          .title()
          .then(() => 'answered')
          .catch(() => 'error')
      ])
      expect(outcome).not.toBe('answered')
      expect(browser.isConnected()).toBe(true)
      await expect(openTabs(page)).toHaveCount(1)
    } finally {
      await browser.close().catch(() => {})
    }
  } finally {
    await server.close()
  }
})
