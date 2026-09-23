import { test, expect, launchApp } from './helpers/app'
import type { Page } from '@playwright/test'
import { startEchoServer, type FixtureServer } from './helpers/fixtureServer'
import {
  centerTerm,
  killSession,
  runIn,
  sendShortcut,
  startSessionIn,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'
import { setGuestLimit } from './helpers/env'
import {
  waitPanelAttached,
  wbActiveTab,
  wbFrozenTabs,
  wbTabs,
  workbenchPanel
} from './helpers/workbench'

/**
 * Workbench · guests, the caps, and the keys a focused page would otherwise swallow
 * (WB-W04, WB-T10, WB-T13, WB-K04).
 *
 * Everything here exists because the merge put live `<webview>` guests and an ordinary tab
 * strip in the same container. Two consequences need pinning from the outside:
 *
 *  - a guest must never be torn down by a LAYOUT change (NFR-03). A `<webview>` inside a
 *    `display:none` subtree is detached and reloads on the way back (electron#28677), so
 *    "the form value is still there" is the only honest oracle — a screenshot would look
 *    identical either way.
 *  - the two ceilings are different in kind and must not be confused: the 8-tab cap
 *    really CLOSES a tab (FR-22, unrecoverable, toasted), while the global live-guest cap
 *    only FREEZES one (FR-24, the tab keeps its url and reloads when clicked).
 */

let server: FixtureServer

test.beforeAll(async () => {
  server = await startEchoServer()
})

test.afterAll(async () => {
  await server?.close()
})

/** A page that holds observable state: a form value, a scroll offset. Both survive only
 *  if the guest itself was never torn down and re-created. */
const STATEFUL_PAGE = `<!doctype html><title>Stateful</title>
<input id="f" />
<div style="height:4000px">tall</div>`

async function agentOpen(page: Page, target: string): Promise<void> {
  await runIn(page, centerTerm(page), `/open ${target}`)
}

/** Read something out of the ACTIVE guest. `executeJavaScript` runs inside the guest's own
 *  renderer, which is the only place this state exists. */
async function inGuest<T>(page: Page, expression: string): Promise<T> {
  return page.evaluate(async (expr) => {
    const el = document.querySelector(
      '.wb-panel webview:not([style*="display: none"])'
    ) as unknown as { executeJavaScript(code: string): Promise<unknown> } | null
    if (!el) throw new Error('no live guest')
    return el.executeJavaScript(expr) as Promise<never>
  }, expression) as Promise<T>
}

// WB-W04 (NFR-03, FR-01) — the reliability requirement behind the singleton. A tab switch
// and a SESSION switch both re-lay-out the panel, and neither may cost a guest its state.
// The `display` assertion is the mechanism half: `visibility:hidden` keeps the layout box
// (and the render process), `display:none` would not.
test('WB-W04: a guest keeps its form value and scroll across tab and session switches', async ({
  page
}) => {
  test.setTimeout(240_000)
  await startSessionIn(page, 'ws-a')
  const url = server.page('/stateful', STATEFUL_PAGE)
  await agentOpen(page, url)
  await wbTabs(page).nth(1).click() // the click is what loads it (FR-13)
  await expect.poll(() => server.count('/stateful'), { timeout: 30_000 }).toBeGreaterThan(0)

  await inGuest(page, `document.getElementById('f').value = 'koloft-w04'; scrollTo(0, 900); 1`)
  await expect.poll(() => inGuest<number>(page, 'scrollY')).toBeGreaterThan(0)

  // round trip 1: another tab and back
  await wbTabs(page).nth(0).click()
  await expect(wbActiveTab(page)).toHaveClass(/pinned/)
  await wbTabs(page).nth(1).click()
  expect(await inGuest<string>(page, `document.getElementById('f').value`)).toBe('koloft-w04')
  expect(await inGuest<number>(page, 'scrollY')).toBeGreaterThan(0)

  // round trip 2: another SESSION and back — the harsher one, since the panel swaps which
  // session's whole tab set it shows
  await startSessionIn(page, 'ws-a')
  await expect(page.locator('.ws-tab')).toHaveCount(2, { timeout: 25_000 })
  // a second session in one workspace earns the 'worktree' tip, whose card sits
  // over the row this case clicks; dismiss it the way a person would
  await page
    .locator('.hint-card[data-hint="worktree"]')
    .getByRole('button', { name: 'Got it', exact: true })
    .click()
  await page.locator('.ws-tab').nth(1).click()
  await expect(workbenchPanel(page)).toBeVisible()
  await page.locator('.ws-tab').nth(0).click()

  await expect
    .poll(() => inGuest<string>(page, `document.getElementById('f').value`))
    .toBe('koloft-w04')
  expect(await inGuest<number>(page, 'scrollY')).toBeGreaterThan(0)

  // …and the page was never fetched a second time, which is what "not torn down" MEANS
  expect(server.count('/stateful')).toBe(1)

  // the mechanism: an inactive guest's host is hidden, never display:none
  const displays = await page.evaluate(() =>
    [...document.querySelectorAll('.wb-panel webview')].map(
      (el) => getComputedStyle(el.parentElement ?? el).display
    )
  )
  expect(displays.every((d) => d !== 'none')).toBe(true)
})

// WB-T13 (FR-24, FR-19) — the global live-guest cap FREEZES; it never closes. The
// distinction is the whole case: a frozen tab is still on the strip with its title, and
// clicking it brings the page back.
test('WB-T13: over the global guest cap the least-recently-viewed freezes, and never closes', async ({
  app,
  env
}) => {
  test.setTimeout(240_000)
  // Two live guests is enough to observe the LRU without a dozen renderer processes. The
  // cap VALUE is a product parameter main owns and is deliberately not asserted — only the
  // freezing behaviour past it is (FR-24). The seam is an env var read at launch, so the
  // fixture's already-running app has to be replaced rather than reconfigured.
  await app.close().catch(() => {})
  setGuestLimit(env, 2)
  const relaunched = await launchApp(env)
  const page = await relaunched.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')

  const urls = ['a', 'b', 'c', 'd'].map((n) =>
    server.page(`/t13-${n}`, `<!doctype html><title>T13 ${n}</title><p>${n}`)
  )
  for (const u of urls) await agentOpen(page, u)
  await expect(wbTabs(page)).toHaveCount(5)

  // view them in order, so the least-recently-viewed is unambiguous
  for (let i = 1; i <= 4; i++) {
    await wbTabs(page).nth(i).click()
    await expect.poll(() => server.count(`/t13-${['a', 'b', 'c', 'd'][i - 1]}`)).toBeGreaterThan(0)
  }

  // the overflow is frozen — still listed, still titled, NOT closed
  await expect(wbTabs(page)).toHaveCount(5)
  await expect.poll(() => wbFrozenTabs(page).count()).toBeGreaterThan(0)
  const frozen = wbFrozenTabs(page).first()
  await expect(frozen).toBeVisible()
  await expect(frozen).not.toHaveText('')

  // clicking a frozen tab reloads it and makes it active again
  const label = (await frozen.textContent())?.trim() ?? ''
  await frozen.click()
  await expect(wbActiveTab(page)).toContainText(label.replace(/×$/, '').trim())
  await expect(wbTabs(page)).toHaveCount(5) // still nothing was closed
  await relaunched.close().catch(() => {})
})

// WB-K04 (FR-53, FR-17, FR-35) — the keys a focused PAGE would otherwise swallow. After
// the merge a focused guest is an ordinary place for the focus to be, so ⌘W must close the
// TAB (not raise the session's close dialog) and ⌘F must open Koloft's own find bar.
test('WB-K04: ⌘W and ⌘F still work with the focus inside a guest', async ({ app, page }) => {
  test.setTimeout(240_000)
  await startSessionIn(page, 'ws-a')
  const url = server.page('/k04', '<!doctype html><title>K04</title><p>find me here')
  await agentOpen(page, url)
  await wbTabs(page).nth(1).click()
  await expect.poll(() => server.count('/k04'), { timeout: 30_000 }).toBeGreaterThan(0)

  // put the focus INSIDE the page, not on the panel chrome
  await page.locator('.wb-panel webview').first().click()

  // ⌘F opens Koloft's own in-pane find, not the guest's native one
  await sendShortcut(app, 'shortcut:find')
  await expect(page.locator('.wb-panel .find-bar')).toHaveCount(1)
  await page.keyboard.press('Escape')
  await expect(page.locator('.wb-panel .find-bar')).toHaveCount(0)

  // ⌘W closes THAT TAB — the session behind it is untouched and no dialog appears
  await sendShortcut(app, 'shortcut:close-tab')
  await expect(wbTabs(page)).toHaveCount(1)
  await expect(page.locator('.modal.lifecycle-modal')).toHaveCount(0)
  await expect(centerTerm(page)).toBeVisible()
})

// WB-T10 (FR-22, FR-23) — the OTHER ceiling: the 9th tab of a kind really closes one, and
// the toast names it. Contrast with WB-T13 above, where nothing is ever closed.
test('WB-T10: the 9th web tab evicts the least-recently-viewed and the toast names it', async ({
  page
}) => {
  test.setTimeout(300_000)
  await startSessionIn(page, 'ws-a')

  for (let i = 1; i <= 8; i++) {
    await agentOpen(page, server.page(`/cap-${i}`, `<!doctype html><title>Cap ${i}</title>`))
  }
  await expect(wbTabs(page)).toHaveCount(9) // files + 8

  await agentOpen(page, server.page('/cap-9', '<!doctype html><title>Cap 9</title>'))

  // still 8 web tabs: one was really closed to make room
  await expect(wbTabs(page)).toHaveCount(9)
  // the victim is the least-recently-viewed; none was ever activated, so it is the oldest
  // by creation (FR-22's recency definition)
  await expect(page.locator('.wb-tab', { hasText: 'cap-1' })).toHaveCount(0)
  await expect(page.locator('.wb-tab', { hasText: 'cap-9' })).toHaveCount(1)
  // …and it was said out loud, naming the tab (FR-23)
  await expect(page.locator('.toast')).toContainText('cap-1')
  // the pinned tab is exempt by construction, not by a guard
  await expect(wbTabs(page).nth(0)).toHaveClass(/pinned/)
})

// A session that dies takes everything of itself off the screen (T-LIFE-05), but its tab
// SET is not a screen thing: main persists it, and the resume comes back to it — every
// tab listed, none loaded until it is clicked (FR-25: a guest hangs off a RUNNING session).
test('WB-T14: a session’s tab set survives its death and comes back, unloaded, on resume', async ({
  page,
  env
}) => {
  test.setTimeout(240_000)
  await startSessionIn(page, 'ws-a')
  const [session] = await waitForCalls(env, 1)
  const url = server.page('/cold', '<!doctype html><title>Cold</title><p>page')
  await agentOpen(page, url)
  await wbTabs(page).nth(1).click()
  await expect.poll(() => server.count('/cold'), { timeout: 30_000 }).toBeGreaterThan(0)
  await expect(wbTabs(page)).toHaveCount(2)
  const loads = server.count('/cold')

  // the death: the tab goes with the pty, the row stays, cold (T-LIFE-05 owns the rest)
  killSession(session.pid, env)
  const row = wsRows(page, 'ws-a').first()
  await expect(row).toHaveClass(/\bcold\b/, { timeout: 40_000 })
  await expect(workbenchPanel(page)).not.toBeVisible()

  // the resume brings the strip back as it was, and loads nothing on its own
  await row.click()
  await waitPanelAttached(page)
  await expect(wbTabs(page)).toHaveCount(2, { timeout: 30_000 })
  expect(server.count('/cold')).toBe(loads)
})
