import fs from 'fs'
import path from 'path'
import { test, expect } from './helpers/app'
import type { ElectronApplication, Page } from '@playwright/test'
import {
  centerTerm,
  clickAppMenuItem,
  focusOwner,
  islandBorderColors,
  litIsland,
  openSessionTerminal,
  panelTerm,
  startSessionIn
} from './helpers/p1'
import {
  BROWSER_MENU_IDS,
  addressField,
  guestByUrl,
  newWebTab,
  rendererZoomFactor,
  typeInAddressBar
} from './helpers/browser'
import { WORKBENCH, openFileTab, wbActiveTab, workbenchPanel } from './helpers/workbench'
import { startEchoServer, type FixtureServer } from './helpers/fixtureServer'

/**
 * Workbench · the focus ring and the keys that follow it (D5–D7 / R13–R17,
 *) §04's
 * three-state table).
 *
 * One rule, asserted from every side: the keys belong to whichever island is LIT, and an
 * island is lit exactly when the keyboard focus is inside it. Before the web keys
 * went by what was on SCREEN ("a guest is visible, so ⌘R is the guest's"), which meant a
 * ⌘R aimed at the conversation reloaded a page the user was not looking at.
 *
 * Nothing here trusts `document.hasFocus()` — offscreen (KOLOFT_TEST_BACKGROUND=1) it
 * reports true in three places at once. The oracles are `document.activeElement`, the
 * computed border colour of the two islands, and the fixture server's request count.
 */

let server: FixtureServer

test.beforeAll(async () => {
  server = await startEchoServer()
})

test.afterAll(async () => {
  await server?.close()
})

/** ⇧⌘B — Toggle Workbench, through its menu item (the accelerator itself is unreachable
 *  from Playwright's synthetic keys). The command id stayed `toggle-browser`. */
async function toggleWorkbench(app: ElectronApplication, page: Page): Promise<void> {
  await clickAppMenuItem(app, page, 'toggle-browser')
}

/** ⌘⏎ — Focus Mode, i.e. the panel taking the whole row and giving it back. */
async function toggleFull(app: ElectronApplication, page: Page): Promise<void> {
  await clickAppMenuItem(app, page, 'toggle-focus-mode')
}

/** Given: a live session with one loaded `web` tab in its panel. */
async function sessionWithWebTab(page: Page, url: string): Promise<void> {
  await startSessionIn(page, 'ws-a')
  await newWebTab(page)
  await expect(addressField(page)).toBeVisible({ timeout: 20_000 })
  await typeInAddressBar(page, url)
}

/** The tag name of whatever holds the focus right now. */
function activeTag(page: Page): Promise<string> {
  return page.evaluate(() => (document.activeElement as HTMLElement | null)?.tagName ?? 'NONE')
}

// T-FX-01 (§07's one unverified assumption) — RUN THIS FIRST. Everything else in this
// file rests on it: a click inside a guest has to make the <webview> element the HOST
// document's activeElement, because that is what the focus test behind the web keys (D6)
// reads.
//
// MEASURED, and it did not come out the way §07 guessed. The design assumed the same
// `activeElement` would satisfy `:focus-within` and light the ring for free, with "toggle a
// class from the guest's focus/blur events" as the fallback if it did not. What the build
// actually does:
//   - `<webview>` DOES become the host document's activeElement. That half held.
//   - It matches NO `:focus-within` and fires NO focus event in the host. So the CSS-only
//     ring of R13 cannot see a focused guest at all, and the fallback as written could not
//     have worked either — there is no event to hang it on.
//   - The fix in the build is neither: App re-reads `document.activeElement` after focus
//     events and puts a `caret` class on the island that owns it. The ring is that class,
//     not `:focus-within` alone.
// Both halves are asserted below, which is why this case checks `litIsland` and not just
// the tag: the tag passing while the ring stays dark is exactly the state that was found.
test('T-FX-01: a click inside a guest makes the <webview> the host’s activeElement and lights the panel', async ({
  app,
  page
}) => {
  test.setTimeout(240_000)
  const url = server.page('/fx01', '<!doctype html><title>FX01</title><p id="p">hello')
  await sessionWithWebTab(page, url)
  const guest = await guestByUrl(app, '/fx01')

  await guest.locator('#p').click({ timeout: 20_000 })

  expect(await activeTag(page)).toBe('WEBVIEW')
  expect(await litIsland(page)).toBe('panel')
})

// T-FX-02 (D5/R13) — the ring simply follows the focus, and only one island ever wears
// it. The colour comparison is the assertion carrying the case: "the panel has a border"
// is true in every state, so only "this border IS the accent colour AND the other one is
// not" can fail in the broken state.
test('T-FX-02: the accent ring follows the focus — conversation, then panel, then neither', async ({
  app,
  page
}) => {
  test.setTimeout(240_000)
  await startSessionIn(page, 'ws-a')

  // the conversation. The TUI has had no frame (it sits on the bare
  // ground), so there is no ring for it to wear: the caret in the conversation reads as
  // NO island lit. `focusOwner` carries the positive half — 'none' alone would also
  // pass a caret that landed nowhere.
  await centerTerm(page).click()
  await expect.poll(() => focusOwner(page), { timeout: 15_000 }).toBe('tui')
  await expect.poll(() => litIsland(page), { timeout: 15_000 }).toBe('none')
  const onTui = await islandBorderColors(page)
  expect(onTui.panel).not.toBe(onTui.accent)

  // ⇧⌘B collapses (focus back to the conversation, R15) and then expands, taking the
  // focus into the panel with it
  await toggleWorkbench(app, page)
  await expect(workbenchPanel(page)).toBeHidden()
  await toggleWorkbench(app, page)
  await expect(workbenchPanel(page)).toBeVisible()
  await expect.poll(() => litIsland(page), { timeout: 15_000 }).toBe('panel')
  const onPanel = await islandBorderColors(page)
  expect(onPanel.panel).toBe(onPanel.accent)
  expect(onPanel.tui).not.toBe(onPanel.accent)

  // the sidebar is neither island: clicking there leaves both dark (R13). The probe is
  // the head's FOLD ICON, not the head itself: since D7 a head click picks that
  // workspace, which would drop the session this case still needs selected. The icon is
  // just as good a probe — a plain span that takes no focus — and folding an empty group
  // changes nothing else on screen.
  await page.locator('.ws-head', { hasText: 'ws-b' }).locator('.fico').click()
  await expect.poll(() => litIsland(page), { timeout: 15_000 }).toBe('none')

  // …and the same leaving a GUEST, which is the harder direction. A guest holds the focus
  // through a mechanism of its own (T-FX-01: no host focus event, no `:focus-within`), so
  // the ring is only as good as whatever notices the focus LEAVING it. A workspace header's fold
  // icon is the sharp probe: it is a plain span, so it takes no focus itself and produces no
  // "some other island lit up" event to ride on — a build that only turns the ring off when
  // another island turns it on stays lit here.
  const url = server.page('/fx02', '<!doctype html><title>FX02</title><p id="p">hi')
  await newWebTab(page)
  await typeInAddressBar(page, url)
  const guest = await guestByUrl(app, '/fx02')
  await guest.locator('#p').click({ timeout: 20_000 })
  await expect.poll(() => litIsland(page), { timeout: 15_000 }).toBe('panel')

  await page.locator('.ws-head', { hasText: 'ws-b' }).locator('.fico').click()
  await expect.poll(() => litIsland(page), { timeout: 15_000 }).toBe('none')
})

// T-FX-02b (R17) — the documented way OUT of a shell or a guest, which the Esc ladder
// cannot reach on its own: Esc pressed inside either one belongs to it (R6), so the route
// the design gives the user is ⌘⌥←/→ to a tab that is not a shell or a guest, and Esc
// from there.
//
// The tab switch has to CARRY THE CARET for that route to exist at all. If the caret stays
// behind in the shell after the strip moves on, the Esc goes to a shell the user can no
// longer see and the ladder never runs — the user is stuck in the panel with no keyboard
// way back, which is the failure R17 exists to prevent.
test('T-FX-02b: ⌘⌥→ off a shell carries the caret, so the next Esc reaches the ladder', async ({
  app,
  page
}) => {
  test.setTimeout(300_000)
  await startSessionIn(page, 'ws-a')
  await openSessionTerminal(app, page)
  await panelTerm(page).click()
  await expect.poll(() => litIsland(page), { timeout: 15_000 }).toBe('panel')

  // onto the pinned Files tab — a tab whose Esc belongs to the ladder, not to a shell.
  // ⌘⌥←/→ is a renderer keydown, not one of the forwarded menu accelerators, so it is
  // pressed for real (WB-K03's mechanism).
  await page.keyboard.press('Meta+Alt+ArrowRight')
  await expect(wbActiveTab(page)).toHaveClass(/pinned/, { timeout: 20_000 })
  // the caret came along: still the panel, and no longer inside the shell's textarea
  await expect.poll(() => focusOwner(page), { timeout: 15_000 }).toBe('panel')
  expect(await page.evaluate(() => document.activeElement?.closest('.wb-term') !== null)).toBe(
    false
  )

  // …so the ladder sees this Esc and hands the caret home, panel still open
  await page.keyboard.press('Escape')
  await expect.poll(() => focusOwner(page), { timeout: 15_000 }).toBe('tui')
  await expect(workbenchPanel(page)).toBeVisible()
})

// T-FX-03 (D6/R14) — the key this whole rework exists for. With the conversation lit, ⌘R
// must do NOTHING, even though a loaded guest is right there on screen; with the panel
// lit it reloads that guest. The server's request count is the only honest oracle: a
// guest that "looks the same" tells you nothing about whether it was fetched again.
test('T-FX-03: ⌘R reloads the guest only while the panel is lit', async ({ app, page }) => {
  test.setTimeout(300_000)
  const url = server.page('/fx03', '<!doctype html><title>FX03</title><p id="p">hi')
  await sessionWithWebTab(page, url)
  await guestByUrl(app, '/fx03')
  await expect.poll(() => server.count('/fx03'), { timeout: 20_000 }).toBe(1)

  // ① the conversation holds the focus (frameless TUI: no island lit, see T-FX-02)
  await centerTerm(page).click()
  await expect.poll(() => focusOwner(page), { timeout: 15_000 }).toBe('tui')
  await expect.poll(() => litIsland(page), { timeout: 15_000 }).toBe('none')
  await clickAppMenuItem(app, page, BROWSER_MENU_IDS.reload)
  // hold it: a reload that is merely LATE would still be a reload
  await page.waitForTimeout(5000)
  expect(server.count('/fx03')).toBe(1)

  // ② the panel holds it (⇧⌘B out and back in — R15 brings the focus with it)
  await toggleWorkbench(app, page)
  await toggleWorkbench(app, page)
  await expect.poll(() => litIsland(page), { timeout: 15_000 }).toBe('panel')
  await clickAppMenuItem(app, page, BROWSER_MENU_IDS.reload)
  await expect.poll(() => server.count('/fx03'), { timeout: 20_000 }).toBe(2)
})

// T-FX-04 (R14) — lit is necessary, not sufficient: the web keys also need the active tab
// to BE a web tab. On the pinned Files tab ⌘R does nothing at all, and ⌘± falls back to
// its whole-window meaning. Both halves are asserted on the same guest, which is alive
// and one tab away the entire time.
test('T-FX-04: with the panel lit on a non-web tab, ⌘R is inert and ⌘± zooms the window', async ({
  app,
  page
}) => {
  test.setTimeout(300_000)
  const url = server.page('/fx04', '<!doctype html><title>FX04</title><p id="p">hi')
  await sessionWithWebTab(page, url)
  await guestByUrl(app, '/fx04')
  await expect.poll(() => server.count('/fx04'), { timeout: 20_000 }).toBe(1)
  expect(await rendererZoomFactor(app)).toBe(1)

  // back to the pinned Files tab, with the focus inside the panel
  await page.locator(WORKBENCH.tabFiles).click()
  await workbenchPanel(page).click({ position: { x: 5, y: 5 } })
  await expect.poll(() => litIsland(page), { timeout: 15_000 }).toBe('panel')

  await clickAppMenuItem(app, page, BROWSER_MENU_IDS.reload)
  await page.waitForTimeout(5000)
  expect(server.count('/fx04')).toBe(1)

  await clickAppMenuItem(app, page, BROWSER_MENU_IDS.zoomIn)
  // The WINDOW zoom moving is the discriminating oracle, and the only one: an embedded
  // webview inherits its embedder's zoom (measured — window and guest go 1 → 1.0954
  // together), so "the guest did not move" is unobservable in Electron and would pin a
  // Chromium fact rather than ours. BB-C68 holds the other side: routed to the GUEST,
  // the same key leaves the window at 1.
  await expect.poll(() => rendererZoomFactor(app), { timeout: 20_000 }).not.toBe(1)
})

// T-FX-05 (R15) — ⇧⌘B carries the caret both ways, and where it LANDS depends on the
// active tab's kind: a web tab's guest, the panel root for Files, the shell for a
// terminal tab. Each landing is asserted on its own, because "the panel is lit" is true
// for all three and would hide two of the three being wrong.
test('T-FX-05: ⇧⌘B lands the caret per kind on the way in, and back in the conversation on the way out', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(420_000)
  const url = server.page('/fx05', '<!doctype html><title>FX05</title><p id="p">hi')
  await sessionWithWebTab(page, url)
  await guestByUrl(app, '/fx05')

  const roundTrip = async (): Promise<void> => {
    await toggleWorkbench(app, page)
    await expect(workbenchPanel(page)).toBeHidden()
    await expect.poll(() => focusOwner(page), { timeout: 15_000 }).toBe('tui')
    await toggleWorkbench(app, page)
    await expect(workbenchPanel(page)).toBeVisible()
  }

  // ① a web tab → inside the guest, AND the panel's ring lights. The ring is App's own
  // sampling, one frame after the pane's deferred focus (a focused guest fires no host
  // focus event, so nothing else would ever light it) — the ordering a commit slipped in
  // between the two would silently break.
  await roundTrip()
  await expect.poll(() => activeTag(page), { timeout: 15_000 }).toBe('WEBVIEW')
  await expect.poll(() => litIsland(page), { timeout: 15_000 }).toBe('panel')

  // ② the pinned Files tab → the panel root (a real element, not the guest)
  await page.locator(WORKBENCH.tabFiles).click()
  await roundTrip()
  await expect.poll(() => focusOwner(page), { timeout: 15_000 }).toBe('panel')
  expect(await activeTag(page)).not.toBe('WEBVIEW')

  // ③ a `file` tab behaves like Files — the panel root again
  const doc = path.join(env.workspaces.a, 'fx05.md')
  fs.writeFileSync(doc, '# FX05\n\nbody\n')
  await openFileTab(page, env, doc)
  await roundTrip()
  await expect.poll(() => focusOwner(page), { timeout: 15_000 }).toBe('panel')

  // ④ a terminal tab → inside the shell's own input layer
  await openSessionTerminal(app, page)
  await roundTrip()
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const el = document.activeElement as HTMLElement | null
          return !!el && el.tagName === 'TEXTAREA' && el.closest('.wb-term') !== null
        }),
      { timeout: 15_000 }
    )
    .toBe(true)

  // …and the last collapse hands the caret back to the conversation
  await toggleWorkbench(app, page)
  await expect.poll(() => focusOwner(page), { timeout: 15_000 }).toBe('tui')
})

// T-FX-06 (R16) — ⌘⏎ hides the conversation entirely, so the caret cannot stay there: a
// hidden island holding the focus IS a lost caret. Coming back to side-by-side leaves it
// in the panel, which is the half that is easy to get wrong by "restoring" the focus.
test('T-FX-06: ⌘⏎ moves the caret into the panel and leaves it there on the way back', async ({
  app,
  page
}) => {
  test.setTimeout(240_000)
  await startSessionIn(page, 'ws-a')
  await centerTerm(page).click()
  await expect.poll(() => focusOwner(page), { timeout: 15_000 }).toBe('tui')

  await toggleFull(app, page)
  await expect(page.locator(WORKBENCH.panel)).toHaveClass(/full/)
  await expect.poll(() => focusOwner(page), { timeout: 15_000 }).toBe('panel')

  await toggleFull(app, page)
  await expect(page.locator(WORKBENCH.panel)).not.toHaveClass(/full/)
  await expect.poll(() => focusOwner(page), { timeout: 15_000 }).toBe('panel')
  expect(await litIsland(page)).toBe('panel')
})

// T-FX-07 (R6) — inside a guest, Esc is the PAGE's and never reaches the panel's ladder.
//
// The ladder's own last rung (R17: one more Esc hands the caret back to the conversation
// without collapsing the panel or closing a tab) is one step appended to
// workbench-chrome.spec.ts WB-K05b, which already walks the whole ladder down from T3.
// Building that setup a second time here is what §08 asked to avoid.
test('T-FX-07: Esc inside a guest belongs to the page, not to the panel’s ladder', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(300_000)
  await startSessionIn(page, 'ws-a')

  // a guest keeps its own Esc: the page sees the key and the panel does not move
  const url = server.page(
    '/fx07',
    '<!doctype html><title>FX07</title><p id="p">hi</p>' +
      '<script>window.__esc=false;addEventListener("keydown",e=>{if(e.key==="Escape")window.__esc=true})</script>'
  )
  await newWebTab(page)
  await typeInAddressBar(page, url)
  const guest = await guestByUrl(app, '/fx07')
  await guest.locator('#p').click({ timeout: 20_000 })
  await guest.keyboard.press('Escape')

  await expect
    .poll(() => guest.evaluate(() => (window as unknown as { __esc: boolean }).__esc), {
      timeout: 15_000
    })
    .toBe(true)
  await expect(workbenchPanel(page)).toBeVisible()
  await expect(page.locator(WORKBENCH.panel)).not.toHaveClass(/full/)
})
