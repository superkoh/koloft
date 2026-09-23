import fs from 'fs'
import path from 'path'
import { test, expect, launchApp } from './helpers/app'
import type { ElectronApplication, Page } from '@playwright/test'
import {
  centerTerm,
  clickAppMenuItem,
  openSessionTerminal,
  panelTerm,
  runIn,
  seedJsonl,
  sendShortcut,
  startSessionIn,
  waitForCalls
} from './helpers/p1'
import { addressField, guestByUrl, newWebTab, typeInAddressBar } from './helpers/browser'
import { startEchoServer } from './helpers/fixtureServer'
import {
  answerFileDialog,
  cancelFileDialog,
  pendingFileDialogAnswers,
  appRegion,
  persistedTabsOnDisk,
  WORKBENCH,
  seedWorkbench,
  wbActiveTab,
  wbTabByTitle,
  wbTabTitles,
  wbTabs,
  wbUnreadTabs,
  workbenchPanel
} from './helpers/workbench'

/**
 * Workbench · tab lifecycle.
 *
 * The subject is the asymmetry the merge introduced. Before it, "an agent's `open` lands a
 * background tab plus an unread mark" was one rule; now it forks by TARGET — a web url
 * still lands a background tab (FR-13), a file lands nothing at all (FR-14) — and forks
 * again by SOURCE, since the user's own `open` from a shell must land visibly (FR-57).
 * (moved that shell out of the former global terminal island and into the session's
 * own panel; the fork itself is unchanged.) Four combinations, each with a different visible outcome, is exactly
 * the shape that rots without tests.
 *
 * The centre TUI runs fake-claude, not a shell, so an AGENT action is driven by its
 * sentinels (`/open <target>` spawns the open shim from inside the session's own pty;
 * `/write <rel>` writes a file mid-turn). A USER action is driven from the island's real
 * shell, which is the only shell the product has.
 */

/** ⌘W / ⌘T reach the panel only while the panel holds the focus (FR-20), so every
 *  accelerator case clicks into the panel first and then sends the menu item — the
 *  house convention for native accelerators (test/CLAUDE.md). */
async function focusPanel(page: Page): Promise<void> {
  await workbenchPanel(page).click({ position: { x: 5, y: 5 } })
}

/** ⌘W travels the menu's `close-tab` accelerator, which App arbitrates by focus — so the
 *  same key closes a TAB inside the panel and the SESSION outside it (FR-17/20). */
async function closeTab(app: ElectronApplication): Promise<void> {
  await sendShortcut(app, 'shortcut:close-tab')
}

/** ⌘T is bound to NO menu accelerator on purpose (menu.ts leaves the key free so the
 *  terminal island can own it while IT holds the focus), so unlike every other key here
 *  it is a real renderer keydown caught in App's capture-phase listener. */
async function newTab(page: Page): Promise<void> {
  await page.keyboard.press('Meta+t')
}

/** An AGENT open: fake-claude's `/open` spawns the shim from inside the session's own
 *  pty, which is what makes main read it as agent-source rather than user-source. */
async function agentOpen(page: Page, target: string): Promise<void> {
  await runIn(page, centerTerm(page), `/open ${target}`)
}

// WB-T02 (FR-13, FR-16) — the agent's web open: a background tab with an unread mark, no
// focus steal, no panel expansion, and NOT loaded (the title stays the pre-load
// host/last-segment form rather than becoming a page title).
test('WB-T02: an agent web open lands a background, unread, unloaded tab', async ({ page }) => {
  await startSessionIn(page, 'ws-a')
  await expect(wbTabs(page)).toHaveCount(1) // the pinned files tab alone

  await agentOpen(page, 'http://127.0.0.1:1/alpha')
  await agentOpen(page, 'http://127.0.0.1:1/beta')

  await expect(wbTabs(page)).toHaveCount(3)
  await expect(wbUnreadTabs(page)).toHaveCount(2)
  // the active tab never moved: taking the current tab away is the invariant an agent
  // action may not breach
  await expect(wbActiveTab(page)).toHaveClass(/pinned/)
  // …and neither page ran, so both carry the derived label, not a page title
  const titles = await wbTabTitles(page)
  expect(titles.slice(1)).toEqual(['127.0.0.1:1/alpha', '127.0.0.1:1/beta'])
})

// WB-T03 (FR-15) — an agent RE-open of a url it already opened: no second tab, no focus
// steal, only the mark re-lights. The user having already read it is what makes the
// re-light observable.
test('WB-T03: an agent re-open only re-lights the mark', async ({ page }) => {
  await startSessionIn(page, 'ws-a')
  await agentOpen(page, 'http://127.0.0.1:1/alpha')
  await expect(wbTabs(page)).toHaveCount(2)

  // the user reads it once (which clears the mark, FR-16) and goes back to Files
  await wbTabs(page).nth(1).click()
  await expect(wbUnreadTabs(page)).toHaveCount(0)
  await wbTabs(page).nth(0).click()

  await agentOpen(page, 'http://127.0.0.1:1/alpha')

  await expect(wbTabs(page)).toHaveCount(2) // no second tab
  await expect(wbUnreadTabs(page)).toHaveCount(1) // re-lit
  await expect(wbActiveTab(page)).toHaveClass(/pinned/) // still no focus steal
})

// WB-T04 / WB-T05 (FR-16) — a mark clears ONLY on activation. Expanding the panel never
// batch-clears, which is the difference between "I have seen this" and "I have seen that
// there is something".
test('WB-T04/T05: expanding never batch-clears; only activation clears one mark', async ({
  app,
  page
}) => {
  await startSessionIn(page, 'ws-a')
  await clickAppMenuItem(app, page, 'toggle-browser') // collapse to T1
  await agentOpen(page, 'http://127.0.0.1:1/alpha')
  await agentOpen(page, 'http://127.0.0.1:1/beta')

  await clickAppMenuItem(app, page, 'toggle-browser') // expand to T2
  await expect(workbenchPanel(page)).toBeVisible()
  await expect(wbUnreadTabs(page)).toHaveCount(2) // both survived the expansion

  await wbTabs(page).nth(1).click()
  await expect(wbUnreadTabs(page)).toHaveCount(1) // exactly the one that was activated
})

// WB-T22 (FR-14, FR-51) — the agent's FILE open, which is the half the merge changed: no
// tab, and while collapsed no signal of any kind. The positive barrier matters as much as
// the negative one — a user open of the same file right afterwards must still land
// normally, or "no signal" would be indistinguishable from "the route is broken".
test('WB-T22: an agent file open makes no tab and no signal, and does not block the user', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await startSessionIn(page, 'ws-a')
  // the shell this case needs is a tab of this session's panel, and opening it is
  // what expands the panel — so it is opened FIRST and counted into `before`, then the
  // panel is collapsed for the agent half.
  await openSessionTerminal(app, page)
  const before = await wbTabs(page).count()
  await clickAppMenuItem(app, page, 'toggle-browser') // T1
  await expect(workbenchPanel(page)).toBeHidden()

  const rel = 'agent-note.md'
  const abs = path.join(env.workspaces.a, rel)
  await runIn(page, centerTerm(page), `/write ${rel}`)
  await expect.poll(() => fs.existsSync(abs), { timeout: 30_000 }).toBe(true)
  await agentOpen(page, abs)

  // nothing happened that a user could see
  await expect(wbTabs(page)).toHaveCount(before)
  await expect(workbenchPanel(page)).toBeHidden()

  // …and the route is nonetheless alive: the SAME file, opened by the user from a shell,
  // lands visibly (FR-57) and brings the collapsed panel back up.
  //
  // The `sleep 3` and the second collapse are what keep that last clause testable. A shell
  // can only be reached while the panel is open (R8), so the request is fired and the
  // panel pulled out from under it inside the sleep window.
  await clickAppMenuItem(app, page, 'toggle-browser') // back to T2 to reach the shell
  await expect(workbenchPanel(page)).toBeVisible()
  await runIn(page, panelTerm(page), `sleep 3; open ${abs}`)
  await clickAppMenuItem(app, page, 'toggle-browser') // T1 again, request still in flight
  await expect(workbenchPanel(page)).toBeHidden()
  await expect(workbenchPanel(page)).toBeVisible({ timeout: 30_000 })
  await expect(wbActiveTab(page)).toHaveClass(/pinned/) // the files tab, not a new one
  await expect(wbTabs(page)).toHaveCount(before) // still no tab was made (FR-10)
  // WB-T21's actual claim, and the one assertion here that fails ONLY in the broken
  // state: the file has to be READ, not merely routed. "Panel visible + pinned tab
  // active" holds just as well when the file lands in the half of the tab that is not on
  // screen — the reading area belongs to Browse (FR-10), so a user open must bring Browse
  // with it. Everything above this line passed while the file was invisible.
  await expect(page.locator('.wb-panel .fv')).toHaveAttribute('data-view', 'browse')
  await expect(page.locator('.wb-panel .fv-artifact-hd .wb-title')).toContainText(rel)
})

// WB-T20 (FR-57) — the user's own `open <url>` from a shell: foreground, loaded, and it
// expands a collapsed panel. The contrast with WB-T02 is the whole point.
//
// the shell is a terminal tab of this session's panel, so it counts as a tab (three
// now, not two) and it can only be typed into while the panel is open. Firing the open
// behind a `sleep 3` and collapsing inside that window is what keeps the expand clause a
// real observation instead of a foregone one.
test('WB-T20: a user web open from a shell loads in the foreground and expands the panel', async ({
  app,
  page
}) => {
  test.setTimeout(180_000)
  await startSessionIn(page, 'ws-a')
  await openSessionTerminal(app, page)
  await runIn(page, panelTerm(page), 'sleep 3; open http://127.0.0.1:1/gamma')
  await clickAppMenuItem(app, page, 'toggle-browser') // T1
  await expect(workbenchPanel(page)).toBeHidden()

  await expect(workbenchPanel(page)).toBeVisible({ timeout: 30_000 })
  await expect(wbTabs(page)).toHaveCount(3)
  // it is the ACTIVE tab and carries no unread mark: the user is already looking at it
  await expect(wbActiveTab(page)).not.toHaveClass(/pinned/)
  await expect(wbUnreadTabs(page)).toHaveCount(0)
})

// WB-T01 / WB-T07 (FR-02, FR-17, FR-18, FR-19) — the pinned tab's three exemptions, and
// where focus goes when an ordinary tab closes.
test('WB-T01/T07: files is unclosable and ⌘W walks right, then left', async ({ app, page }) => {
  await startSessionIn(page, 'ws-a')
  await agentOpen(page, 'http://127.0.0.1:1/a')
  await agentOpen(page, 'http://127.0.0.1:1/b')
  await agentOpen(page, 'http://127.0.0.1:1/c')
  await expect(wbTabs(page)).toHaveCount(4)

  // FR-02: no ✕ on the pinned tab, and it sits in slot 0
  await expect(wbTabs(page).nth(0)).toHaveClass(/pinned/)
  await expect(wbTabs(page).nth(0).locator('.x')).toHaveCount(0)

  // FR-18: ⌘W on files does nothing at all — not a close, not a collapse
  await wbTabs(page).nth(0).click()
  await focusPanel(page)
  await closeTab(app)
  await expect(wbTabs(page)).toHaveCount(4)
  await expect(workbenchPanel(page)).toBeVisible()

  // FR-19: closing the active middle tab moves focus to its RIGHT neighbour
  await wbTabs(page).nth(2).click() // the 'b' tab
  await focusPanel(page)
  await closeTab(app)
  await expect(wbTabs(page)).toHaveCount(3)
  await expect(wbActiveTab(page)).toHaveText(/c/)

  // …and closing the LAST tab falls back to the left
  await focusPanel(page)
  await closeTab(app)
  await expect(wbTabs(page)).toHaveCount(2)
  await expect(wbActiveTab(page)).toHaveText(/a/)
})

// WB-K01 (FR-20) — the blanket. With the panel UNFOCUSED every focus-scoped key keeps
// exactly today's meaning: ⌘W acts on the SESSION, never on the panel's tab set. An idle
// session closes outright (the confirm dialog is reserved for a session that is working
// or sitting on a permission prompt — closeSession.ts), so "the session went away while
// the strip was never touched" is the observable that separates the two readings.
test('WB-K01: with the panel unfocused ⌘W is still the session’s, not the panel’s', async ({
  app,
  page
}) => {
  await startSessionIn(page, 'ws-a')
  await agentOpen(page, 'http://127.0.0.1:1/a')
  await expect(wbTabs(page)).toHaveCount(2)
  await expect(centerTerm(page)).toBeVisible()

  await centerTerm(page).click() // focus the TUI, not the panel
  await closeTab(app)

  // the SESSION closed — the centre falls back to the welcome panel. Had ⌘W been routed
  // to the panel it would have closed the web tab and left the session standing.
  await expect(page.locator('.w-empty')).toBeVisible({ timeout: 20_000 })
})

// WB-K01b (FR-17/20) — the other side of the same blanket: the identical key, with the
// panel focused, closes a TAB and leaves the session alone.
test('WB-K01b: with the panel focused the same ⌘W closes a tab and spares the session', async ({
  app,
  page
}) => {
  await startSessionIn(page, 'ws-a')
  await agentOpen(page, 'http://127.0.0.1:1/a')
  await expect(wbTabs(page)).toHaveCount(2)

  await wbTabs(page).nth(1).click()
  await focusPanel(page)
  await closeTab(app)

  await expect(wbTabs(page)).toHaveCount(1)
  await expect(centerTerm(page)).toBeVisible() // the session is untouched
})

// WB-K02 (FR-52, FR-03, FR-11, FR-30) — ⌘T creates a tab of the SAME KIND as the active
// one, and the ＋ dropdown on `files` holds exactly the kinds a user can make. The .html
// branch is the interesting one: a page renders only inside a guest, so the picker's html
// choice routes to a `web` tab rather than a `file` one.
//
// FLIPPED by R2. The dropdown used to hold exactly TWO items and this case asserted
// it never mentioned a terminal — the shell was a global island back then, unreachable
// from the panel. A terminal is the panel's fourth tab kind now, so "New terminal" belongs
// in the menu and the count is three. Only that clause moved; the .ts / cancel / .html
// branches below are untouched.
test('WB-K02: ⌘T creates same-kind, and an .html pick routes to a web tab', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await startSessionIn(page, 'ws-a')
  const tsFile = path.join(env.workspaces.a, 'k02.ts')
  const htmlFile = path.join(env.workspaces.a, 'k02.html')
  fs.writeFileSync(tsFile, 'export const a = 1\n')
  fs.writeFileSync(htmlFile, '<!doctype html><title>K02</title><p>hi\n')

  // on `files`, ⌘T opens the ＋ dropdown — exactly the three kinds a user can create
  await focusPanel(page)
  await newTab(page)
  const menu = page.locator('.wb-newmenu')
  await expect(menu).toBeVisible()
  await expect(menu.locator('.mi')).toHaveCount(3)
  await expect(menu).toContainText('New web tab')
  await expect(menu).toContainText('Open file…')
  await expect(menu).toContainText(/terminal/i)
  await page.keyboard.press('Escape')

  // "Open file…" with a .ts pick makes a `file` tab and activates it
  answerFileDialog(env, tsFile)
  await focusPanel(page)
  await newTab(page)
  await menu.locator('.mi', { hasText: 'Open file…' }).click()
  await expect(wbTabs(page)).toHaveCount(2)
  await expect(wbActiveTab(page)).toHaveText(/k02\.ts/)
  await expect.poll(() => pendingFileDialogAnswers(env)).toEqual([])

  // ⌘T on that `file` tab raises the picker again — cancelling makes no tab (FR-52)
  cancelFileDialog(env)
  await focusPanel(page)
  await newTab(page)
  await expect(wbTabs(page)).toHaveCount(2)

  // …and an .html pick routes per FR-11 into a `web` tab, never a `file` one
  answerFileDialog(env, htmlFile)
  await focusPanel(page)
  await newTab(page)
  await expect(wbTabs(page)).toHaveCount(3)
  await expect(page.locator('.wb-panel')).toHaveAttribute('data-kind', 'web')
})

// WB-T09 / WB-P01 (FR-21) — drag reorder survives, and the ORDER is what reaches disk
// (unlike the selection, which does not).
test('WB-T09: dragging reorders the strip and the new order is what persists', async ({ page }) => {
  await startSessionIn(page, 'ws-a')
  await agentOpen(page, 'http://127.0.0.1:1/a')
  await agentOpen(page, 'http://127.0.0.1:1/b')
  await expect(wbTabs(page)).toHaveCount(3)
  expect((await wbTabTitles(page)).slice(1)).toEqual(['127.0.0.1:1/a', '127.0.0.1:1/b'])

  const from = wbTabs(page).nth(2)
  const to = wbTabs(page).nth(1)
  await from.dragTo(to)

  await expect
    .poll(async () => (await wbTabTitles(page)).slice(1))
    .toEqual(['127.0.0.1:1/b', '127.0.0.1:1/a'])
  // the pinned tab never moved out of slot 0
  await expect(wbTabs(page).nth(0)).toHaveClass(/pinned/)
})

// ---- D8: the panel belongs to the conversation tab, not to the Claude session id ----

/** One loaded `web` tab on `url` — the panel opens on the pinned `files` tab, whose kind
 *  bar has no address field at all, so the ＋'s "New web tab" is what makes a url
 *  typeable in the first place (FR-52). */
async function webTabOn(page: Page, url: string): Promise<void> {
  await newWebTab(page)
  await expect(addressField(page)).toBeVisible({ timeout: 20_000 })
  await typeInAddressBar(page, url)
}

// T-GT-11 (FLIPPED by D8/R11) — an in-TUI `/resume` is a session switch, and until
// now the whole panel was rebuilt from the TARGET session's stored entry: its open flag,
// its tab set, its guests. D8 turns that around. The panel hangs off the conversation
// TAB, so a `/resume` changes nothing the user can see — and the id is only ever the key
// for the NEXT write, which lands under the target and overwrites whatever it held.
//
// The request count is the assertion carrying the "nothing moved" half: a rebuild that
// happened to produce the same labels would still have thrown the live guest away and
// refetched it, and a title list cannot tell those two apart.
test('T-GT-11: an in-TUI /resume leaves the panel untouched and writes the next save under the target id', async ({
  env
}) => {
  test.setTimeout(300_000)
  const targetId = seedJsonl(env, env.workspaces.a, { summary: 'Resume target session' })
  // the target's OWN stored panel — collapsed, with a tab of its own. R11 adopts NONE of
  // it: not the collapse, not the tab. A panel that merely stayed put by accident cannot
  // pass, because this state is visibly different from the origin's.
  seedWorkbench(env, targetId, {
    open: false,
    tabs: [{ kind: 'web', title: 'target-page', url: 'http://127.0.0.1:1/target-page' }]
  })

  const srv = await startEchoServer()
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(page.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
    await startSessionIn(page, 'ws-a')
    const [origin] = await waitForCalls(env, 1)

    await webTabOn(page, srv.url('/origin'))
    await guestByUrl(app, '/origin')
    await expect.poll(() => srv.count('/origin'), { timeout: 20_000 }).toBe(1)
    const titlesBefore = await wbTabTitles(page)
    // the origin's entry really reached disk before the switch (the write is debounced in
    // main), which is what makes the "frozen at the switch" check below mean anything
    await expect
      .poll(() => persistedTabsOnDisk(env, origin.sessionId).map((t) => t.url), {
        timeout: 30_000
      })
      .toEqual([srv.url('/origin')])

    await runIn(page, centerTerm(page), `/resume ${targetId}`)
    await expect(centerTerm(page)).toContainText(`resumed session ${targetId}`, {
      timeout: 30_000
    })

    // nothing on screen moved: still expanded, same tabs, same live guest
    await expect(workbenchPanel(page)).toBeVisible()
    await page.waitForTimeout(5000)
    expect(await wbTabTitles(page)).toEqual(titlesBefore)
    expect(srv.count('/origin')).toBe(1)
    await expect(wbTabByTitle(page, /target-page/)).toHaveCount(0)

    // …and the NEXT save lands under the target id, overwriting what it had stored —
    // R11's "no merge": the target's own old tab is gone, never added to the strip
    await webTabOn(page, srv.url('/after'))
    await expect
      .poll(() => persistedTabsOnDisk(env, targetId).map((t) => t.url), { timeout: 30_000 })
      .toEqual([srv.url('/origin'), srv.url('/after')])
    // the id the tab moved AWAY from stops at the moment of the switch
    expect(persistedTabsOnDisk(env, origin.sessionId).map((t) => t.url)).toEqual([
      srv.url('/origin')
    ])
  } finally {
    await app.close().catch(() => {})
    await srv.close()
  }
})

// WB-T23 (R1) — ⇧⌘R swaps a fresh claude pty into the SAME conversation-tab slot.
// The panel's state travels with the slot, so a restart is invisible on the right-hand
// side: the collapse the user chose is still in force, the tab set is the same one, and
// the guest behind it was never reloaded.
//
// Collapsed on purpose: the open flag is the half a rebuild-from-disk would get wrong
// most quietly, since the session's stored entry says "open" and only the live tab knows
// better.
test('WB-T23: ⇧⌘R leaves the panel’s open state, tabs and live guest untouched', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(300_000)
  const srv = await startEchoServer()
  try {
    await startSessionIn(page, 'ws-a')
    const [first] = await waitForCalls(env, 1)
    await webTabOn(page, srv.url('/restart'))
    await guestByUrl(app, '/restart')
    await expect.poll(() => srv.count('/restart'), { timeout: 20_000 }).toBe(1)
    const titlesBefore = await wbTabTitles(page)

    // the user collapses the panel, then restarts the session
    await clickAppMenuItem(app, page, 'toggle-browser')
    await expect(workbenchPanel(page)).toBeHidden()
    await sendShortcut(app, 'shortcut:restart-session')
    const calls = await waitForCalls(env, 2)
    expect(calls[1].argv[calls[1].argv.indexOf('--resume') + 1]).toBe(first.sessionId)

    // still collapsed…
    await page.waitForTimeout(5000)
    await expect(workbenchPanel(page)).toBeHidden()
    // …and expanding finds the same strip over the same, never-refetched guest
    await clickAppMenuItem(app, page, 'toggle-browser')
    await expect(workbenchPanel(page)).toBeVisible()
    expect(await wbTabTitles(page)).toEqual(titlesBefore)
    expect(srv.count('/restart')).toBe(1)
  } finally {
    await srv.close()
  }
})

// WB-T24 — a tab's ✕ closes on the first real click. Both things that ate it live below
// the synthetic event layer (Electron's window drag mask, Chromium's native drag start),
// so the shape is what can be pinned: the strip is not a drag region (WB-L02 pins that
// its empty run is), the handle comes after every tab so none can grow into its rect, and
// the ✕'s mousedown is cancelled so no tab drag can start from it.
test('WB-T24: no tab sits inside a window drag region, and the ✕ never starts a tab drag', async ({
  page
}) => {
  test.setTimeout(120_000)
  await startSessionIn(page, 'ws-a')
  await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
  await newWebTab(page)
  await expect(wbTabs(page)).toHaveCount(2, { timeout: 20_000 })

  expect(await appRegion(page, WORKBENCH.tabStrip)).not.toBe('drag')
  const shape = await page.evaluate((sel) => {
    const handle = document.querySelector(sel.dragHandle)!
    const x = document.querySelector(`${sel.tab}:not(.pinned) ${sel.tabCloseIn}`)!
    return {
      handleLast: [...document.querySelectorAll(sel.tab)].every((t) =>
        Boolean(t.compareDocumentPosition(handle) & Node.DOCUMENT_POSITION_FOLLOWING)
      ),
      // `dispatchEvent` answers false when a listener called preventDefault
      dragCancelled: !x.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true })
      )
    }
  }, WORKBENCH)
  expect(shape.handleLast).toBe(true)
  expect(shape.dragCancelled).toBe(true)
})
