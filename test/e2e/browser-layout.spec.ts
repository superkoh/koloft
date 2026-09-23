import fs from 'fs'
import path from 'path'
import type { Locator, Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import type { E2EEnv } from './helpers/env'
import {
  BROWSER,
  BROWSER_MENU_IDS,
  activeKind,
  addressField,
  browserSurface,
  globeIcon,
  guestByUrl,
  guestContents,
  newWebTab,
  openBrowser,
  openTabs,
  pinnedTab,
  rendererZoomFactor,
  typeInAddressBar
} from './helpers/browser'
import { WORKBENCH, openInBrowse, wbActiveTab } from './helpers/workbench'
import {
  clickAppMenuItem,
  gitCommitAll,
  gitInit,
  processAlive,
  sendShortcut,
  startSessionIn,
  waitForCalls,
  wsRows
} from './helpers/p1'
import { startEchoServer } from './helpers/fixtureServer'

/**
 * The Workbench's LAYOUT + KEYBOARD cluster (the case ids are the original
 * case list's, and the spec carrying an id IS its contract):
 * one panel holding two kinds without losing either one's state (BB-M12), the panel
 * mounting with the session rather than with a file (BB-C48), the two width boundaries
 * (BB-C55 window minimum, BB-C56 panel minimum), T2↔T3 (BB-C67), and the keyboard
 * arbitration that has to reach the right island: ⌘T (BB-C35), ⌘W (BB-C36), ⌘R
 * (BB-C37), ⌘F (BB-C60), ⌘±/⌘0 (BB-C68).
 *
 * Nothing in this file imports from src/ — the observables are the panel's own seams
 * (`data-surface` / `data-kind`, its markup, BROWSER_MENU_IDS, the persisted width key)
 * plus what the running app renders.
 *
 * Offscreen (KOLOFT_TEST_BACKGROUND=1) `document.hasFocus()` reports true in three
 * places at once, so kind arbitration is read from `data-kind` and focus from
 * `document.activeElement` — never from hasFocus.
 */

/**
 * Given: one bound session in ws-a with the panel showing.
 *
 * `openBrowser` chooses T1 vs T2 now rather than a surface, and the panel is open by
 * DEFAULT after the merge (`workbench.defaultOpen`, FR-06), so it is usually a no-op.
 */
async function sessionWithWorkbench(page: Page, env: E2EEnv): Promise<void> {
  gitInit(env.workspaces.a)
  await startSessionIn(page, 'ws-a')
  // bounded on purpose: a missing icon fails in seconds rather than burning the whole
  // test timeout inside an unbounded wait
  await expect(globeIcon(page)).toBeVisible({ timeout: 20_000 })
  await openBrowser(page)
}

/**
 * …plus one `web` tab on `url`, loaded — the Given of every keyboard case below. FR-52:
 * the panel opens on the pinned `files` tab, whose kind bar has no address field at all,
 * so the ＋'s "New web tab" is what makes a url typeable in the first place.
 */
async function sessionWithWebTab(page: Page, env: E2EEnv, url: string): Promise<void> {
  await sessionWithWorkbench(page, env)
  await newWebTab(page)
  await expect(addressField(page)).toBeVisible({ timeout: 20_000 })
  await typeInAddressBar(page, url)
}

/** Is the keyboard focus inside `selector`? (activeElement, never hasFocus — R7/TEST-8) */
function focusInside(page: Page, selector: string): Promise<boolean> {
  return page.evaluate((sel) => {
    const el = document.activeElement as HTMLElement | null
    return !!el && (el.matches(sel) || el.closest(sel) !== null)
  }, selector)
}

/** total matches the visible find bar reports (`1/3` → 3, `0/0` and blank → 0) */
async function findTotal(page: Page): Promise<number> {
  const txt = (await page.locator('.find-bar:visible .find-count').innerText()).trim()
  const m = txt.match(/(\d+)\s*\/\s*(\d+)/)
  return m ? Number(m[2]) : 0
}

async function searchWith(page: Page, query: string): Promise<void> {
  await page.locator('.find-bar:visible .find-input').fill(query)
}

/** zoom factor of the guest whose url contains `urlPart` (0 when it is gone) */
async function guestZoom(
  app: Parameters<typeof guestContents>[0],
  urlPart: string
): Promise<number> {
  const hit = (await guestContents(app)).find((g) => g.url.includes(urlPart))
  return hit ? hit.zoomFactor : 0
}

// BB-M12 — RETARGETED by the merge. "The Eye and the Globe are mutually exclusive" retired
// with the two-pane aux column (FR-55: one icon, one panel), but the invariant it existed
// to protect did NOT: the two surfaces still take turns on one column, and coming back to
// the reading area has to bring the SAME preview, scroll position included — the panel
// hides a surface with `visibility`, never `display:none`, so nothing is ever rebuilt
// (NFR-03). The kind switch inside the one strip is what performs the turn now.
test('BB-M12: swapping the panel between the Files tab and a web tab rebuilds neither', async ({
  page,
  env
}) => {
  test.setTimeout(240_000)
  gitInit(env.workspaces.a)
  await startSessionIn(page, 'ws-a')

  // A long file so the reading area has a scroll position that can be lost — committed,
  // because an UNTRACKED file is all-additions to git, and the pane then legitimately
  // swaps the highlighted code view for the inline diff the moment that parse lands. The
  // Given wants a file open, not a diff (measured: without this the swap removes
  // `.code-body` mid-test, so the scroll oracle asserts on an element that is gone).
  fs.writeFileSync(
    path.join(env.workspaces.a, 'long.txt'),
    Array.from({ length: 400 }, (_, i) => `line ${i + 1}`).join('\n') + '\n'
  )
  gitCommitAll(env.workspaces.a)
  await openInBrowse(page, path.join(env.workspaces.a, 'long.txt'))
  const codeBody = page.locator(`${BROWSER.surface} .code-body`).first()
  await expect(codeBody).toBeVisible({ timeout: 20_000 })
  await codeBody.evaluate((el) => {
    el.scrollTop = 1200
  })
  await expect.poll(() => codeBody.evaluate((el) => el.scrollTop)).toBe(1200)
  // a user open activates the pinned tab and expands the panel (FR-57)
  await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('files')
  await expect(pinnedTab(page)).toHaveClass(/\bon\b/)

  // a `web` tab takes the panel over — one surface at a time, exactly as before
  await newWebTab(page)
  await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('web')
  await expect(pinnedTab(page)).not.toHaveClass(/\bon\b/)
  // the reading area is hidden, not gone: its scroller is still in the document
  await expect(codeBody).toHaveCount(1)

  // …and the pinned tab takes it back, with the preview exactly as it was left
  await pinnedTab(page).click({ timeout: 30_000 })
  await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('files')
  await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('long.txt')
  await expect.poll(() => codeBody.evaluate((el) => el.scrollTop)).toBe(1200)
})

// BB-C48 — IMPL-8: the aux column used to exist only while some tab had a file open, so a
// Browser with no file open had nowhere to render. After the merge the panel belongs to the
// SESSION (FR-04), not to an open file — but the failure mode the case guards is unchanged
// and still reachable through the collapse/expand cycle: expanding must bring the panel AND
// its drag gutter back with no file ever having been opened.
test('BB-C48: expanding the panel when no file is open still mounts it and its gutter', async ({
  page,
  env
}) => {
  test.setTimeout(240_000)
  gitInit(env.workspaces.a)
  await startSessionIn(page, 'ws-a')
  await expect(globeIcon(page)).toBeVisible({ timeout: 20_000 })

  // Given: no file has ever been opened, and the panel is collapsed (T1). The reading
  // area's header exists only while a file IS open, which is what makes the count the
  // Given rather than a tautology — the former `.file-pane-title` it replaces matches
  // nothing at all now, so it would have read 0 either way.
  await expect(page.locator(WORKBENCH.readingTitle)).toHaveCount(0)
  await globeIcon(page).click({ timeout: 30_000 })
  await expect(browserSurface(page)).toBeHidden({ timeout: 20_000 })
  await expect(page.locator('.center-row .gutter-v')).toHaveCount(0)

  await globeIcon(page).click({ timeout: 30_000 })

  await expect(browserSurface(page)).toBeVisible({ timeout: 20_000 })
  await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('files')
  await expect(page.locator('.center-row .gutter-v')).toHaveCount(1)
  // …and still no file was opened to get there
  await expect(page.locator(WORKBENCH.readingTitle)).toHaveCount(0)
})

// BB-C55 — B1/§01C: the window minimum goes 900 → 1020 so the Browser can always get
// its 440. The upgrade cost must not be paid by existing users, whose saved 900-wide
// geometry has to come back as 900 rather than being clamped up on restore.
test('BB-C55: the window minimum width is 1020, and an old 900-wide bounds is not clamped on restore', async ({
  env
}) => {
  test.setTimeout(240_000)

  const app1 = await launchApp(env)
  try {
    const page1 = await app1.firstWindow()
    await page1.waitForLoadState('domcontentloaded')
    // the user drags the window narrower than the minimum
    await app1.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setBounds({ x: 100, y: 100, width: 700, height: 800 })
    })
    const width = await app1.evaluate(
      ({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds().width
    )
    expect(width).toBeGreaterThanOrEqual(1020)
  } finally {
    await app1.close().catch(() => {})
  }

  // …now an upgrading user's persisted geometry: 900 wide, saved by a build whose
  // minimum still was 900. Written after the first app closed, so its own save cannot
  // overwrite the fixture.
  fs.writeFileSync(
    path.join(env.userData, 'window-state.json'),
    JSON.stringify({ bounds: { x: 60, y: 60, width: 900, height: 700 } })
  )
  const app2 = await launchApp(env)
  try {
    const page2 = await app2.firstWindow()
    await page2.waitForLoadState('domcontentloaded')
    const bounds = await app2.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].getBounds()
    )
    expect(bounds.width).toBe(900)
  } finally {
    await app2.close().catch(() => {})
  }
})

// BB-C56 — D2/FR-08: the floor of 440 (below that a guest hits most sites' mobile
// breakpoint) is the merged panel's now, under the merged width key `workbenchWidth`; the
// TUI keeps its own 380 floor beside it.
test('BB-C56: the Workbench panel cannot be dragged narrower than 440px', async ({ page, env }) => {
  test.setTimeout(240_000)
  await sessionWithWorkbench(page, env)

  const paneWidthOnDisk = (): number | undefined => {
    const file = path.join(env.userData, 'settings.json')
    if (!fs.existsSync(file)) return undefined
    return (JSON.parse(fs.readFileSync(file, 'utf8')) as { workbenchWidth?: number }).workbenchWidth
  }

  const gutter = page.locator('.center-row .gutter-v')
  await expect(gutter).toHaveCount(1)
  const grip = (await gutter.boundingBox())!
  const winW = await page.evaluate(() => window.innerWidth)
  const y = grip.y + grip.height / 2
  // one hand-paced gesture dragging the divider RIGHT, far past the 440 floor
  await page.mouse.move(grip.x + 2, y)
  await page.mouse.down()
  for (let i = 1; i <= 10; i++) {
    await page.mouse.move(grip.x + ((winW - 20 - grip.x) * i) / 10, y)
    await page.waitForTimeout(60)
  }
  await page.mouse.up()

  await expect.poll(paneWidthOnDisk, { timeout: 20_000 }).toBe(440)
  // …and the TUI beside it never dropped through its own floor
  const tui = (await page.locator('.term-island').boundingBox())!
  expect(tui.width).toBeGreaterThanOrEqual(380)
})

// BB-C67 — D2/D9/G0-6 / FR-05/FR-07: ⌘⏎ trades the three-column layout for width (T2→T3),
// and T3 is a global transient state: switching sessions must drop it on its own, or the
// target session's TUI would be buried under a full-width page.
test('BB-C67: ⌘⏎ Focus fills the center-row, and switching sessions exits Focus automatically', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(420_000)
  gitInit(env.workspaces.a)
  gitInit(env.workspaces.b)
  await startSessionIn(page, 'ws-a')
  await startSessionIn(page, 'ws-b')

  await wsRows(page, 'ws-a').first().click()
  await expect(globeIcon(page)).toBeVisible({ timeout: 20_000 })
  await openBrowser(page)

  const centerRow = page.locator('.center-row')
  const tui = page.locator('.term-island')
  await expect(tui).toBeVisible()

  // ⌘⏎ — the panel fills the center row, the TUI gets out of the way
  await clickAppMenuItem(app, page, BROWSER_MENU_IDS.focusMode)
  await expect(tui).toBeHidden({ timeout: 20_000 })
  const rowBox = (await centerRow.boundingBox())!
  const panelBox = (await browserSurface(page).boundingBox())!
  expect(panelBox.width).toBeGreaterThan(rowBox.width * 0.9)

  // the ⤢ affordance is present in the kind bar and invoking it restores the columns. Its
  // label names the action it will perform and carries the accelerator ("Restore ⌘⏎" in
  // T3, "Full width ⌘⏎" in T2), so both states are located by prefix — and `aria-pressed`
  // is asserted beside it, since that is what carries the position rather than the name.
  const restore = browserSurface(page).locator('[aria-label^="Restore"]').first()
  await expect(restore).toBeVisible({ timeout: 20_000 })
  await expect(restore).toHaveAttribute('aria-pressed', 'true')
  await restore.click({ timeout: 30_000 })
  await expect(tui).toBeVisible({ timeout: 20_000 })
  await expect(browserSurface(page)).toBeVisible()
  const expand = browserSurface(page).locator('[aria-label^="Full width"]').first()
  await expect(expand).toBeVisible({ timeout: 20_000 })
  await expect(expand).toHaveAttribute('aria-pressed', 'false')

  // back into Focus, then switch sessions: T3 leaves on its own
  await clickAppMenuItem(app, page, BROWSER_MENU_IDS.focusMode)
  await expect(tui).toBeHidden({ timeout: 20_000 })
  await wsRows(page, 'ws-b').first().click()
  await expect(tui).toBeVisible({ timeout: 30_000 })
})

// BB-C35 — D9/IMPL-4: ⌘T is a renderer keydown that never reaches the guest's render
// process, so with the focus inside a guest it has to travel the before-input-event
// pipeline. Pre-impl ⌘T opens nothing at all (T-AUX-04a).
test('BB-C35: ⌘T opens a new Browser tab when the Browser is focused', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(240_000)
  const server = await startEchoServer()
  try {
    await sessionWithWebTab(page, env, server.url('/a'))
    const guest = await guestByUrl(app, server.url('/a'))
    const before = await openTabs(page).count()

    // a REAL click into the guest first (R7): that is what puts the focus inside it
    await guest.locator('#page-a').click({ timeout: 20_000 })
    await guest.keyboard.press('Meta+t')

    // FR-52: ⌘T makes a tab of the SAME KIND as the active one, so a focused guest gets a
    // blank `web` tab straight away rather than the ＋'s dropdown
    await expect(openTabs(page)).toHaveCount(before + 1, { timeout: 20_000 })
    await expect.poll(() => focusInside(page, BROWSER.addressBar), { timeout: 20_000 }).toBe(true)
  } finally {
    await server.close()
  }
})

// BB-C36 — D9/§05B row 14, RETARGETED by FR-18/19: ⌘W still belongs to whichever island
// holds the focus and still closes the panel's current tab — but "the last tab takes the
// surface down with it" retired outright. `files` is pinned and unclosable, so there IS no
// last tab: the panel never collapses from a close, and ⌘W on the pinned tab is the
// panel's own no-op rather than a fall-through that would close the session behind it.
test('BB-C36: ⌘W closes the current tab, and on the pinned Files tab it does nothing', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(240_000)
  const server = await startEchoServer()
  try {
    await sessionWithWebTab(page, env, server.url('/a'))
    const [session] = await waitForCalls(env, 1)
    await newWebTab(page)
    await typeInAddressBar(page, server.url('/b'))
    await expect(openTabs(page)).toHaveCount(2, { timeout: 20_000 })

    await clickAppMenuItem(app, page, BROWSER_MENU_IDS.closeTab)
    await expect(openTabs(page)).toHaveCount(1, { timeout: 20_000 })

    await clickAppMenuItem(app, page, BROWSER_MENU_IDS.closeTab)
    // FR-19: the last web tab closing falls back to `files`, and the panel stays up
    await expect(openTabs(page)).toHaveCount(0, { timeout: 20_000 })
    await expect(browserSurface(page)).toBeVisible()
    await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('files')

    // FR-18: and one more ⌘W on the pinned tab changes nothing — not the panel, not the
    // tab count, and above all not the session behind it. This half rides the REAL ⌘W
    // (`shortcut:close-tab`, arbitrated on the focus) rather than the Browser submenu's
    // item, because only the real key can prove the last clause: the submenu item has
    // nowhere else to go, while ⌘W does — it is the session's close key everywhere the
    // panel is not focused, and a panel that declined it would hand it straight there.
    await pinnedTab(page).click({ timeout: 20_000 })
    await expect.poll(() => focusInside(page, BROWSER.surface), { timeout: 20_000 }).toBe(true)
    await sendShortcut(app, 'shortcut:close-tab')
    await page.waitForTimeout(1500)
    await expect(browserSurface(page)).toBeVisible()
    await expect(page.locator(BROWSER.tab)).toHaveCount(1)
    expect(processAlive(session.pid)).toBe(true)
  } finally {
    await server.close()
  }
})

// F5 — BB-C36's other half, and the one the live round caught: ⌘W is the REAL keystroke
// (the unbound-id 'Close Tab' item, not the Browser submenu's own), and it is arbitrated
// by the focus. Clicking a tab in the strip is interacting with the panel as much as
// clicking the page is, so the key has to stop at the panel's own tab — a strip click
// that leaves the focus outside the panel sends ⌘W to the SESSION instead, killing it.
test('F5: a click in the tab strip alone gives ⌘W to the Workbench, not to the session', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(240_000)
  const server = await startEchoServer()
  try {
    await sessionWithWebTab(page, env, server.url('/a'))
    const [session] = await waitForCalls(env, 1)
    const row = wsRows(page, 'ws-a').first()
    // a waiting session is the sharp case: ⌘W landing on it closes it outright, with no
    // confirm to catch the mistake (T-KEY-06)
    await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 40_000 })

    await newWebTab(page)
    await typeInAddressBar(page, server.url('/b'))
    await expect(openTabs(page)).toHaveCount(2, { timeout: 20_000 })

    // the ONLY interaction with the panel: a click on the strip. Never into the guest.
    await openTabs(page).first().click({ timeout: 20_000 })
    await expect.poll(() => focusInside(page, BROWSER.surface), { timeout: 20_000 }).toBe(true)

    await sendShortcut(app, 'shortcut:close-tab')
    await expect(openTabs(page)).toHaveCount(1, { timeout: 20_000 })
    expect(processAlive(session.pid)).toBe(true)
    await expect(row).not.toHaveClass(/\bcold\b/)
    await expect(page.locator('.modal-backdrop')).toHaveCount(0)

    // …and the address bar counts as inside too: ⌘W while typing an address is Chrome's
    // close-the-tab, not close-the-session. FR-18/19 changed only what is LEFT afterwards —
    // the panel stays up on the pinned `files` tab instead of collapsing.
    await addressField(page).click({ timeout: 20_000 })
    await sendShortcut(app, 'shortcut:close-tab')
    await expect(openTabs(page)).toHaveCount(0, { timeout: 20_000 })
    await expect(browserSurface(page)).toBeVisible()
    await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('files')
    expect(processAlive(session.pid)).toBe(true)
  } finally {
    await server.close()
  }
})

// BB-C37 — D9/Q2/R3: ⌘R is an Electron `role` today, so with the Browser focused it would
// reload the whole Koloft renderer and take every live xterm down with it. The guest must
// be the only thing that reloads. `window.__koloftTerms` is the regression oracle (TEST-6):
// the very same xterm instances have to still be there afterwards.
//
// D6/R14 narrowed the GIVEN, not this case: ⌘R goes to the guest only while the panel
// is LIT, where it used to be enough that a web tab was on screen. The run below leaves the
// caret in the panel, so it reads the same either way. The other half of that new rule —
// the panel visible but NOT lit, where ⌘R must do nothing — is workbench-focus.spec.ts
// T-FX-03's, and is deliberately not duplicated here.
test('BB-C37: ⌘R with the Browser focused reloads only the guest, not the whole Koloft renderer', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(240_000)
  const server = await startEchoServer()
  try {
    await sessionWithWebTab(page, env, server.url('/a'))
    await guestByUrl(app, server.url('/a'))
    await expect.poll(() => server.count('/a'), { timeout: 20_000 }).toBe(1)

    // stamp the renderer context AND every live xterm instance: a renderer reload
    // wipes both, a guest-only reload leaves both standing
    const termIds = await page.evaluate(() => {
      const w = window as unknown as {
        __koloftTerms: Record<string, { __bbMark?: boolean }>
        __bbRendererMark?: boolean
      }
      w.__bbRendererMark = true
      for (const t of Object.values(w.__koloftTerms)) t.__bbMark = true
      return Object.keys(w.__koloftTerms)
    })
    expect(termIds.length).toBeGreaterThan(0)

    await clickAppMenuItem(app, page, BROWSER_MENU_IDS.reload)

    await expect.poll(() => server.count('/a'), { timeout: 20_000 }).toBe(2)
    const after = await page.evaluate(() => {
      const w = window as unknown as {
        __koloftTerms: Record<string, { __bbMark?: boolean }>
        __bbRendererMark?: boolean
      }
      return {
        rendererAlive: w.__bbRendererMark === true,
        ids: Object.keys(w.__koloftTerms),
        allMarked: Object.values(w.__koloftTerms).every((t) => t.__bbMark === true)
      }
    })
    expect(after.rendererAlive).toBe(true)
    expect(after.ids).toEqual(termIds)
    expect(after.allMarked).toBe(true)
  } finally {
    await server.close()
  }
})

// BB-C60 — §08 P2②/R8, now FR-35: ⌘F follows the ACTIVE TAB'S KIND rather than the former
// aux column's mode. It searches the guest while a `web` tab is active and retargets to the
// reading area's DOM the moment the pinned `files` tab takes the panel back — the two never
// cross, and only ever ONE bar is on screen.
test('BB-C60: find-in-page (⌘F) is arbitrated to the active tab’s kind and does not cross kinds', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(300_000)
  const server = await startEchoServer()
  try {
    gitInit(env.workspaces.a)
    await startSessionIn(page, 'ws-a')

    // reading-area side: a file whose text exists nowhere else
    fs.writeFileSync(
      path.join(env.workspaces.a, 'findable.md'),
      '# findable\n\npreviewonlymarker lives in the file pane\n'
    )
    await openInBrowse(page, path.join(env.workspaces.a, 'findable.md'))
    await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('findable.md', {
      timeout: 20_000
    })

    // web side: a page whose text exists nowhere else
    const findUrl = server.page(
      '/find',
      '<!doctype html><html><head><meta charset="utf-8"><title>Find</title></head>' +
        '<body><h1 id="find-target">guestonlymarker</h1></body></html>'
    )
    await expect(globeIcon(page)).toBeVisible({ timeout: 20_000 })
    await openBrowser(page)
    await newWebTab(page)
    await typeInAddressBar(page, findUrl)
    await guestByUrl(app, findUrl)
    expect(await activeKind(page)).toBe('web')

    // FR-35: ⌘F reaches the panel only while the panel holds the focus, so the strip click
    // is part of the gesture, not scaffolding — with the focus in the TUI the key keeps
    // today's meaning instead (which is what FR-20's blanket says).
    await wbActiveTab(page).click({ timeout: 20_000 })
    await clickAppMenuItem(app, page, BROWSER_MENU_IDS.findInPage)
    await expect(page.locator('.find-bar:visible')).toHaveCount(1, { timeout: 20_000 })
    await searchWith(page, 'guestonlymarker')
    await expect.poll(() => findTotal(page), { timeout: 20_000 }).toBeGreaterThan(0)
    await searchWith(page, 'previewonlymarker')
    await expect.poll(() => findTotal(page), { timeout: 20_000 }).toBe(0)

    // hand the panel back to the pinned tab: ⌘F retargets with it, and the web tab's bar
    // is gone rather than joined by a second one (FR-35: one find bar at a time)
    await pinnedTab(page).click({ timeout: 30_000 })
    await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('files')
    await clickAppMenuItem(app, page, BROWSER_MENU_IDS.findInPage)
    await expect(page.locator('.find-bar:visible')).toHaveCount(1, { timeout: 20_000 })
    await searchWith(page, 'previewonlymarker')
    await expect.poll(() => findTotal(page), { timeout: 20_000 }).toBeGreaterThan(0)
  } finally {
    await server.close()
  }
})

// BB-C68 — §05C/Q2/R3: ⌘±/⌘0 are Electron `role`s today, so they zoom Koloft itself. With
// the Browser FOCUSED they must reach the guest instead and leave the host renderer at 1.
// The zoom STEP is deliberately not pinned — the contract is the arbitration.
//
// D6/R14 narrowed the Given the same way BB-C37's was: the arbitration is on the lit
// island now, not on a visible web tab. The run below keeps the caret in the panel, so it
// stands unchanged; the "panel lit but NOT on a web tab, so ⌘± zooms the WINDOW" cell is
// workbench-focus.spec.ts T-FX-04's.
test('BB-C68: ⌘±/⌘0 page zoom applies to the guest, not to the Koloft renderer', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(240_000)
  const server = await startEchoServer()
  try {
    await sessionWithWebTab(page, env, server.url('/a'))
    await guestByUrl(app, server.url('/a'))
    expect(await rendererZoomFactor(app)).toBe(1)

    await clickAppMenuItem(app, page, BROWSER_MENU_IDS.zoomIn)
    await expect.poll(() => guestZoom(app, '/a'), { timeout: 20_000 }).not.toBe(1)
    expect(await rendererZoomFactor(app)).toBe(1)

    await clickAppMenuItem(app, page, BROWSER_MENU_IDS.zoomReset)
    await expect.poll(() => guestZoom(app, '/a'), { timeout: 20_000 }).toBe(1)
    expect(await rendererZoomFactor(app)).toBe(1)
  } finally {
    await server.close()
  }
})
