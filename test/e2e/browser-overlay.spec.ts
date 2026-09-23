import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp, withOpenPath } from './helpers/app'
import type { E2EEnv } from './helpers/env'
import { openSessionTerminal, panelTerm, runIn, startSessionIn, waitBooted } from './helpers/p1'
import {
  BROWSER,
  OVERLAY,
  downloadedFiles,
  dropOpenRequest,
  guestByUrl,
  openTabs,
  overlayUrl,
  readExternalOpens,
  readOpenCalls
} from './helpers/browser'
import { openSettings } from './helpers/extensions'
import { startEchoServer } from './helpers/fixtureServer'

/**
 * Issue · P0 — the app-level browser overlay (R1/R3).
 *
 * The capability under test: a page Koloft intercepted that no session's Browser can show
 * is no longer handed to macOS. It lands on one overlay inside the window — shown on the
 * spot when the user just asked for it, taken quietly (toast + a dotted titlebar entry)
 * when they did not.
 *
 * Both oracles matter and neither is sufficient alone: `readExternalOpens` staying empty
 * says nothing left Koloft, and the overlay/entry assertions say the request was RECEIVED
 * rather than dropped on the floor. Every negative here follows a positive barrier.
 *
 * Cases: BB-02, BB-06/09, BB-10…18, BB-67 of the black-box set. BB-01 (which BB-03
 * duplicated) lives in open-intercept.spec.ts next to the island `open` cases; BB-21's
 * "not the overlay" negatives sit on browser-routing's BB-M01, the same action; BB-07/08
 * are main-side branches; BB-19 is browser-extensions.spec.ts's store-overlay case;
 * BB-04/05 retired — a dead session has no tab on screen to click a link in (T-LIFE-05).
 */

/** A live claude session, started the way the product starts one (the fake claude, still
 *  through the real shim). */
async function runningSession(page: Page): Promise<void> {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
}

/**
 * Put `url` on the overlay through the real background path — a drop request whose
 * owning tab no longer exists (the late `open` of BB-06) — and then open it from the
 * titlebar. The behaviour cases below all need A page on the overlay; which door it came
 * through is BB-01…06's business, not theirs.
 */
async function overlayShowing(page: Page, env: E2EEnv, url: string): Promise<void> {
  dropOpenRequest(env, { tabId: 'koloft-e2e-closed-tab', url })
  const entry = page.locator(OVERLAY.entry)
  const root = page.locator(OVERLAY.root)
  // A background landing parks behind the titlebar entry — UNLESS the overlay is already
  // on screen, in which case it navigates in place and no entry is ever raised. Cases
  // here do not close the overlay behind them and the app is shared, so both states are
  // reachable; waiting only for the entry made whichever case followed an open one flake.
  await expect
    .poll(async () => (await root.isVisible()) || (await entry.isVisible()), { timeout: 60_000 })
    .toBe(true)
  if (!(await root.isVisible())) await entry.click()
  await expect(root).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => overlayUrl(page), { timeout: 30_000 }).toContain(new URL(url).pathname)
}

// ---- A1: where an unownable open lands, and how it is presented ------------------------

// BB-02 — the regression half: with a live session there is a Browser to render it, and
// R1 changes nothing about that path.
test('BB-02: the island’s `open` still lands in the live session’s Browser', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  try {
    await runningSession(page)
    await openSessionTerminal(app, page)
    await runIn(page, panelTerm(page), withOpenPath(env, `open '${server.localhostUrl('/a')}'`))

    await expect(page.locator(BROWSER.surface)).toBeVisible({ timeout: 40_000 })
    await guestByUrl(app, `:${server.port}/a`)
    // the session took it, so the app-level surface was never involved
    expect(await page.locator(OVERLAY.root).count()).toBe(0)
    expect(await page.locator(OVERLAY.entry).count()).toBe(0)
    expect(readExternalOpens(env)).toEqual([])
  } finally {
    await server.close()
  }
})

// BB-06/09 — the late `open`: the tab that fired it is gone, so nobody is waiting for
// this page. Nothing may pop open; the receipt is a toast plus a dotted titlebar entry.
// The mark is a STATE, not a counter: a second background landing merges into the
// same mark and replaces the page, so opening the entry shows the last one.
test('BB-06/09: late opens are taken in the background — toast + ONE unread entry that shows the last page', async ({
  page,
  env
}) => {
  test.setTimeout(120_000)
  const server = await startEchoServer()
  try {
    dropOpenRequest(env, { tabId: 'koloft-e2e-closed-tab', url: server.localhostUrl('/a') })

    // the entry (with its unread dot) IS the receipt — assert it before the negatives
    await expect(page.locator(OVERLAY.entryUnread)).toBeVisible({ timeout: 30_000 })
    await expect(page.locator('.toast')).toBeVisible({ timeout: 5_000 })
    expect(await page.locator(OVERLAY.root).count()).toBe(0)
    // nothing was loaded behind the user's back either, and nothing left Koloft
    expect(server.count('/a')).toBe(0)
    expect(readExternalOpens(env)).toEqual([])

    // BB-09: a second landing — still exactly one entry, one dot, never a second badge
    dropOpenRequest(env, { tabId: 'koloft-e2e-closed-tab-2', url: server.localhostUrl('/b') })
    await expect(page.locator(OVERLAY.entry)).toHaveCount(1)
    await expect(page.locator(OVERLAY.entryUnread)).toHaveCount(1)

    await page.locator(OVERLAY.entry).click()
    await expect(page.locator(OVERLAY.root)).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => overlayUrl(page), { timeout: 30_000 }).toContain('/b')
    await expect.poll(() => server.count('/b'), { timeout: 30_000 }).toBeGreaterThan(0)
    await expect(page.locator(OVERLAY.entryUnread)).toHaveCount(0)
  } finally {
    await server.close()
  }
})

// D8, the boot case — an open that was already waiting when Koloft started. The startup
// sweep exists exactly for this and hands it over immediately, which is BEFORE the
// renderer has run its effects; `webContents.send` to a renderer with no listener yet
// drops the message and still reports success, so the page used to vanish with its drop
// file already consumed. Under load that cost ~6% of app-startup opens; dropped before
// launch it is every one of them.
test('a page already waiting when Koloft starts is never swallowed', async ({ env }) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  // `env` alone: the request has to be on disk BEFORE the app that must not lose it
  const started = await launchApp(env)
  try {
    const host = await started.firstWindow()
    dropOpenRequest(env, { tabId: 'koloft-e2e-closed-tab', url: server.localhostUrl('/a') })
    await host.waitForLoadState('domcontentloaded')

    await expect(host.locator(OVERLAY.entryUnread)).toBeVisible({ timeout: 40_000 })
    expect(readExternalOpens(env)).toEqual([])
    await host.locator(OVERLAY.entry).click()
    await expect(host.locator(OVERLAY.root)).toBeVisible({ timeout: 20_000 })
    await expect.poll(() => server.count('/a'), { timeout: 30_000 }).toBeGreaterThan(0)
  } finally {
    await started.close().catch(() => {})
    await server.close()
  }
})

// ---- A2: what the overlay itself does ---------------------------------------------------

// BB-10 — R3: the releases page is app-level content. It opens from inside Settings, on
// top of it, and Esc peels the page off without closing Settings underneath.
test('BB-10: Settings→About’s releases link opens IN Koloft, over Settings; Esc closes only it', async ({
  env
}) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  env.launchEnv.KOLOFT_RELEASES_URL = server.url('/a')
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await openSettings(page)
    await page.locator('.set-ni', { hasText: 'About' }).click()
    await page.getByRole('button', { name: /Open releases page/ }).click()

    await expect(page.locator(OVERLAY.root)).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => overlayUrl(page), { timeout: 30_000 }).toContain('/a')
    expect(readExternalOpens(env)).toEqual([])

    await page.keyboard.press('Escape')
    await expect(page.locator(OVERLAY.root)).toHaveCount(0)
    await expect(page.locator('.modal').first()).toBeVisible()
  } finally {
    await app.close().catch(() => {})
    await server.close()
  }
})

// BB-11 — the same page from the update modal's "View release ↗", where the url is the
// one the last check cached rather than the constant index.
test('BB-11: the update modal’s View release opens the cached page in the overlay', async ({
  env
}) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  const fixture = path.join(env.home, 'update-fixture.json')
  fs.writeFileSync(fixture, '[]')
  env.launchEnv.KOLOFT_UPDATE_FIXTURE = fixture
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    // one release, newer than whatever this run reports as its version, in GitHub's own
    // /releases shape (same recipe as update-changelog.spec.ts — an unpackaged run
    // reports ELECTRON's version, so it is never hardcoded)
    const running = await app.evaluate(({ app }) => app.getVersion())
    const m = running.match(/^(\d+)\.(\d+)\.(\d+)/)
    if (!m) throw new Error(`cannot parse version: ${running}`)
    const next = `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
    fs.writeFileSync(
      fixture,
      JSON.stringify([
        {
          tag_name: `v${next}`,
          name: `Koloft v${next}`,
          body: '## What’s Changed\n\n- something\n',
          html_url: server.url('/b'),
          draft: false,
          prerelease: false,
          assets: [
            {
              name: `Koloft-${next}-arm64.dmg`,
              browser_download_url: 'https://example.invalid/Koloft.dmg'
            }
          ]
        }
      ])
    )
    await page.waitForFunction(
      () =>
        (window as unknown as { __koloftShortcutsReady?: boolean }).__koloftShortcutsReady === true,
      undefined,
      { timeout: 20_000 }
    )
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('shortcut:check-update')
    })
    await page.locator('.update-modal').waitFor({ state: 'visible', timeout: 30_000 })
    await page.getByRole('button', { name: /View release/ }).click()

    await expect(page.locator(OVERLAY.root)).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => overlayUrl(page), { timeout: 30_000 }).toContain('/b')
    expect(readExternalOpens(env)).toEqual([])
  } finally {
    await app.close().catch(() => {})
    await server.close()
  }
})

// BB-12 — ↗ is the escape hatch, and the only way a page here reaches the OS: exactly
// one hand-off, of exactly this url.
test('BB-12: ↗ hands the overlay’s page to the system browser — exactly once', async ({
  page,
  env
}) => {
  test.setTimeout(120_000)
  const server = await startEchoServer()
  try {
    const url = server.localhostUrl('/a')
    await overlayShowing(page, env, url)
    await page.locator(OVERLAY.external).click()

    await expect
      .poll(() => [...readExternalOpens(env), ...readOpenCalls(env)], { timeout: 20_000 })
      .toEqual([url])
  } finally {
    await server.close()
  }
})

// BB-13 — a second landing replaces the page in place, which is what keeps the guest's
// own history: Back returns to the page that was replaced.
test('BB-13: a second landing replaces the page; Back returns to the first', async ({
  page,
  env
}) => {
  test.setTimeout(120_000)
  const server = await startEchoServer()
  try {
    await overlayShowing(page, env, server.localhostUrl('/a'))
    dropOpenRequest(env, { tabId: 'koloft-e2e-closed-tab-2', url: server.localhostUrl('/b') })
    await expect.poll(() => overlayUrl(page), { timeout: 30_000 }).toContain('/b')
    // it replaced the page rather than opening a second surface
    await expect(page.locator(OVERLAY.root)).toHaveCount(1)

    await page.locator(OVERLAY.back).click()
    await expect.poll(() => overlayUrl(page), { timeout: 30_000 }).toContain('/a')
  } finally {
    await server.close()
  }
})

// BB-14 — a popup from an overlay page stays in the overlay. It must NEVER become a tab
// in some session's strip: that pollution is exactly what R1 exists to prevent.
test('BB-14: window.open inside the overlay navigates in place, never into a strip', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  try {
    await runningSession(page) // a strip exists and must stay untouched
    await overlayShowing(page, env, server.url('/popup?target=/next'))
    const guest = await guestByUrl(app, '/popup')
    await guest.locator('#open-popup').click()

    // the exact url, not a substring: `/popup?target=/next` contains "/next" too, and an
    // assertion that cannot fail is worse than no assertion
    await expect.poll(() => overlayUrl(page), { timeout: 30_000 }).toBe(server.url('/next'))
    expect(await page.locator(OVERLAY.root).count()).toBe(1)
    // the session's own strip gained nothing: no closable tab at all (the pinned `files`
    // tab is always there and is not one)
    expect(await openTabs(page).count()).toBe(0)
    expect(readExternalOpens(env)).toEqual([])
  } finally {
    await server.close()
  }
})

// BB-15 — the page's alert is drawn on the overlay itself. The Browser pane where that
// modal normally lives belongs to a session and may not be mounted at all, which would
// leave the asking page blocked for good.
test('BB-15: an overlay page’s alert is answered on the overlay’s own modal', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(120_000)
  const server = await startEchoServer()
  try {
    await overlayShowing(page, env, server.url('/dialogs'))
    const guest = await guestByUrl(app, '/dialogs')
    void guest.locator('#do-alert').click() // the page is blocked until it is answered

    await expect(page.locator(OVERLAY.modal)).toBeVisible({ timeout: 30_000 })
    expect(await page.locator(BROWSER.modal).count()).toBe(1) // only the overlay's copy
    await page.locator(OVERLAY.modal).getByRole('button', { name: 'OK' }).click()
    await expect(guest.locator('#result')).toHaveText('alert-returned', { timeout: 20_000 })
  } finally {
    await server.close()
  }
})

// BB-16 — the overlay is a temporary landing surface, not a browser someone keeps things
// in: every page permission is refused outright, and no prompt bar is raised.
test('BB-16: page permissions in the overlay are refused, with no prompt bar', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(120_000)
  const server = await startEchoServer()
  try {
    await overlayShowing(page, env, server.url('/permission'))
    const guest = await guestByUrl(app, '/permission')

    await guest.locator('#ask-mic').click()
    await expect(guest.locator('#mic')).toContainText('denied:', { timeout: 30_000 })
    await guest.locator('#ask-notify').click()
    await expect(guest.locator('#notify')).toHaveText('denied', { timeout: 30_000 })
    expect(await page.locator(BROWSER.permissionBar).count()).toBe(0)
  } finally {
    await server.close()
  }
})

// BB-17 — downloads are a partition-level pipeline, so the overlay inherits them whole:
// the file lands in Koloft's download dir and the toast says so.
test('BB-17: a download from the overlay lands in Koloft’s download dir', async ({ page, env }) => {
  test.setTimeout(120_000)
  const server = await startEchoServer()
  try {
    await overlayShowing(page, env, server.url('/a'))
    dropOpenRequest(env, {
      tabId: 'koloft-e2e-closed-tab-2',
      url: server.url('/download?name=overlay.txt')
    })

    await expect.poll(() => downloadedFiles(env), { timeout: 40_000 }).toContain('overlay.txt')
    expect(readExternalOpens(env)).toEqual([])
  } finally {
    await server.close()
  }
})

// BB-18 — mailto: is the OS's job, and the whitelist door is untouched by R1: the
// overlay's refusal of page permissions must not swallow the user's own click.
test('BB-18: a mailto: link in the overlay is handed to the OS', async ({ app, page, env }) => {
  test.setTimeout(120_000)
  const server = await startEchoServer()
  try {
    await overlayShowing(page, env, server.url('/link?href=mailto:someone@example.com'))
    const guest = await guestByUrl(app, '/link')
    await guest.locator('#link').click()

    await expect
      .poll(() => readExternalOpens(env).join('\n'), { timeout: 30_000 })
      .toContain('mailto:someone@example.com')
  } finally {
    await server.close()
  }
})

// BB-67 — the z ceiling: a confirmation raised while the overlay is up must be on top of
// it and actually clickable (z 130 over 110). Driven through the real product channel.
test('BB-67: a confirmation layer sits ABOVE the overlay and takes the click', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(120_000)
  const server = await startEchoServer()
  try {
    await overlayShowing(page, env, server.url('/a'))
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.send('ext:permission-request', {
        kind: 'permission',
        id: 'koloft-e2e-ask',
        name: 'Koloft probe',
        permissions: ['tabs'],
        origins: []
      })
    })

    const confirm = page.locator('.ext-confirm')
    await expect(confirm).toBeVisible({ timeout: 20_000 })
    // "on top" as the user meets it: the point at its centre belongs to the confirm,
    // not to the overlay underneath
    const box = await confirm.boundingBox()
    expect(box).not.toBeNull()
    const onTop = await page.evaluate(
      ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('.ext-confirm'),
      { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 }
    )
    expect(onTop).toBe(true)
    await expect(page.locator(OVERLAY.root)).toBeVisible()
  } finally {
    await server.close()
  }
})
