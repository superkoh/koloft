import fs from 'fs'
import path from 'path'
import { test, expect, withOpenPath } from './helpers/app'
import type { Page } from '@playwright/test'
import {
  centerTerm,
  clickAppMenuItem,
  openSessionTerminal,
  panelTerm,
  runIn,
  startSessionIn,
  waitBooted,
  wsRows
} from './helpers/p1'
import { activeKind, wbTabs, workbenchIcon, workbenchPanel, WORKBENCH } from './helpers/workbench'

// `open <file>` inside a Koloft tab: previewable types must render in Koloft's own reading area
// (the whole point — instead of the OS default app/browser), everything else must reach
// the real `open` untouched.
//
// Issue forked the LANDING by source (FR-14 vs FR-57), which is the one behavioural
// change the merge made here:
//  - an AGENT `open <file>` becomes the reading area's SUBJECT but moves nothing on
//    screen: no tab is created, `files` is not activated, a collapsed panel is not
//    expanded, and the Files half is not pulled out of Changes either (FR-51's
//    zero-signal rule and FR-14's explicitly accepted trade-off). FR-14's "never enters
//    Recents" clause is Browse's own list and belongs to WB-B07, which asserts the whole
//    Recents contract (capacity, dedup, user-only) in one place rather than a corner of
//    it here;
//  - a USER `open <file>` from a shell activates `files`, brings Browse with it, renders
//    the file, and expands a collapsed panel to T2. (that shell is a terminal tab in
//    the session's own panel now, not the former global terminal island.)
// Both are asserted below on the cases that already drove those two routes.
//
// The reading area is now `FilesView`'s: Browse's right-hand column under FR-31's
// `.fv-artifact-hd` header, which is what the kit's `readingTitle` / `readingBody` point
// at. The artifact-rendering specs read `artifactBody` (the ACTIVE tab's pane) instead —
// this file cannot, because FR-10 deliberately makes no tab, so "the active tab's pane"
// would be the wrong surface entirely.
//
// That move is why the two agent-source cases changed SHAPE rather than selector, and the
// extra step is the test PAYING for a deliberate silence rather than working around one.
// The reading area lives inside Browse (FilesView.tsx `FilesBody`), and only a USER open
// switches the Files half to it.
//
// FR-14 does not settle that by itself: its silence clause is scoped to the collapsed
// panel — "while the panel is collapsed produces no signal" — and these cases run with it
// expanded. What settles it is the discovery route the same requirement names, echoed in
// CLAUDE.md's authority paragraph: files an agent opens are "undiscoverable until you
// expand the panel and read Changes". Changes is the prescribed way to find agent
// activity, so a route that yanked the reader OUT of Changes to show one file would
// contradict the sentence that sends them there — and the cost is asymmetric, since a
// reader mid-review losing their place is a real harm while a file waiting quietly in
// Browse costs nothing.
//
// So "renders in Koloft, not the OS app" is asserted in two beats: the file is invisible
// right after the open, and it is there the moment the user opens Browse. The second beat
// is also what makes the first one mean anything — it proves `openFiles` was already
// written when the silence was measured, rather than the measurement having landed in the
// window before the open arrived at all.
//
// Agent-source opens run through fake-claude's `/open`, which pins shim-dir + its own dir
// ahead of /usr/bin for the child it spawns (fake-claude.js openEnv) — a session pty is a
// login shell and macOS's path_helper would otherwise hoist the REAL /usr/bin/open,
// launching an actual app on the developer's machine. A command typed into a terminal tab
// is pinned the same way, by `withOpenPath` (helpers/app), for the same reason.

/** The `files` tab's reading area — FR-10's destination for a file. Scoped through the kit
 *  rather than to a bare `.wb-artifact`: the reading area and every visited `file` tab
 *  mount the same component, so only `.fv-read` says which one is meant. */
function readingArea(page: Page): ReturnType<Page['locator']> {
  return page.locator(WORKBENCH.readingBody)
}

function readingTitle(page: Page): ReturnType<Page['locator']> {
  return page.locator(WORKBENCH.readingTitle)
}

/** The Files half's own Changes/Browse switch. Matched through the kind bar's labelled
 *  group rather than by button text alone: Browse's tree renders file rows, and one of
 *  them could carry either word. */
function filesHalf(page: Page, name: 'Changes' | 'Browse'): ReturnType<Page['locator']> {
  return page.locator('.wb-bar .seg[aria-label="Files view"] button', { hasText: name })
}

test('open <previewable file> renders in the Koloft reading area, not the OS app', async ({
  page,
  env
}) => {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  const tabsBefore = await wbTabs(page).count()

  await runIn(page, centerTerm(page), '/open README.md')
  // fake-claude echoes this only after its `open` child has exited, so the shim has run
  // and the request is on its way — the barrier the silence clauses below are measured at
  await expect(centerTerm(page)).toContainText('opened README.md', { timeout: 30_000 })

  // FR-14: an agent open moves NOTHING on screen — no tab, no unread mark, and the Files
  // half is not pulled out of Changes onto the file either. The asymmetry the merge
  // introduced, and the reason a file the agent opened during a collapse is undiscoverable.
  await expect.poll(() => wbTabs(page).count()).toBe(tabsBefore)
  await expect(page.locator(WORKBENCH.tabUnread)).toHaveCount(0)
  await expect(filesHalf(page, 'Changes')).toHaveAttribute('aria-pressed', 'true')
  await expect(readingTitle(page)).toHaveCount(0)

  // …and the file really did land: it is the reading area's subject the moment the user
  // opens Browse, rendered by Koloft. This is the positive half — without it the block above
  // would pass just as happily on a build that dropped the open on the floor. The click is
  // the price of FR-14's silence, not a way around it (see the header).
  await filesHalf(page, 'Browse').click()
  await expect(readingTitle(page)).toHaveText('README.md', { timeout: 15_000 })
  await expect(readingArea(page)).toContainText('koloft-e2e-alpha')

  // and the real open chain was never invoked
  expect(fs.existsSync(env.openCalls)).toBe(false)
})

test('open <unsupported file> passes through to the real open untouched', async ({ page, env }) => {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await runIn(page, centerTerm(page), '/open notes.xyz')

  // the (recorded) real open received exactly the original target
  await expect
    .poll(() => (fs.existsSync(env.openCalls) ? fs.readFileSync(env.openCalls, 'utf8') : ''), {
      timeout: 15_000
    })
    .toContain('notes.xyz')

  // and nothing was rendered: the reading area never took a file
  expect(await readingTitle(page).count()).toBe(0)
})

test('an open fired from a background tab activates that tab and shows the preview', async ({
  page,
  env
}) => {
  test.setTimeout(120_000)
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  // arm an open in session 1 gated on a marker file, so it deterministically fires only
  // AFTER session 2 is active — a fixed sleep would race the second launch on a slow
  // runner (firing while session 1 is still active, then the switch clears the pane)
  await runIn(page, centerTerm(page), '/open-later README.md')
  await expect(centerTerm(page)).toContainText('armed open', { timeout: 30_000 })

  await startSessionIn(page, 'ws-b') // session 2 is now the active one
  fs.writeFileSync(path.join(env.home, 'go-open'), '') // release the armed open

  // the intercepted open must not be dropped: session 1 comes back active, carrying the
  // file. The generous window is what this case actually waits on — two session launches,
  // an armed open released between them, and the panel swapping back to session 1 — which
  // on a machine running the whole suite in parallel is well past the default.
  // Session 1 being active again is a real barrier and has to come FIRST: the Files half
  // is per-session runtime state that resets to Changes on activation, so a Browse click
  // made while session 2 is still on screen would be thrown away by the switch.
  await expect(wsRows(page, 'ws-a').first()).toHaveClass(/\bactive\b/, { timeout: 45_000 })
  // FR-14 again: the switch-back is the agent's doing, so it lands on Changes like any
  // other agent open. Browse is where the file it carried is legible.
  await filesHalf(page, 'Browse').click()
  await expect(readingTitle(page)).toHaveText('README.md', { timeout: 45_000 })
  await expect(readingArea(page)).toContainText('koloft-e2e-alpha')
})

// ---- a session's own terminal tab (D8 amended; entry moved) -------
// A shell used to hand every `open` back to macOS. It is the user's own shell — no agent
// can reach it (interactive claude is hard-blocked there) — so an `open` typed in it is a
// user action and lands in Koloft. moved the shell itself: it is no longer a global
// island but a terminal tab inside the session's own Workbench panel (D1/R2).

// FR-57, collapsed-panel half. WHICH session the file lands in is R12's question and is
// pinned by workbench-terminal.spec.ts T-WT-09 (the rewrite of this case); what is left
// here is the clause T-WT-09 does not carry — a COLLAPSED panel comes back up for the
// request, `files` becomes the active tab, and FR-14 still mints no tab for a file.
//
// The `sleep 3` is load-bearing now. Opening the shell expands the panel by definition
// (R5), so the only way to have the request arrive at a collapsed panel is to fire it and
// collapse inside its window.
test('open <previewable file> in a session terminal reopens the collapsed panel', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await openSessionTerminal(app, page)
  const tabsBefore = await wbTabs(page).count()

  await runIn(
    page,
    panelTerm(page),
    withOpenPath(env, `cd '${env.workspaces.a}'; sleep 3; open README.md`)
  )

  // collapse the panel inside the sleep window (⇧⌘B, driven by its menu id — the
  // accelerator itself is unreachable from Playwright's synthetic keys). The command id
  // stayed `toggle-browser`: it is the wire word `commandTarget` arbitrates on.
  await clickAppMenuItem(app, page, 'toggle-browser')
  await expect(workbenchPanel(page)).toBeHidden()

  // the panel came back for it (T2), `files` is the active tab, and the file is rendered
  await expect(workbenchPanel(page)).toBeVisible({ timeout: 30_000 })
  await expect.poll(() => activeKind(page), { timeout: 20_000 }).toBe('files')
  await expect(readingTitle(page)).toHaveText('README.md', { timeout: 20_000 })
  await expect(readingArea(page)).toContainText('koloft-e2e-alpha')

  // still no tab of its own (FR-10/FR-14), and no unread mark anywhere
  await expect.poll(() => wbTabs(page).count()).toBe(tabsBefore)
  await expect(page.locator(WORKBENCH.tabUnread)).toHaveCount(0)
  await expect(workbenchIcon(page)).not.toHaveClass(/unread/)

  expect(fs.existsSync(env.openCalls)).toBe(false)
})

// RETIRED — "open <page> in the global terminal with no session to show it in".
// rewrote this case to assert the page lands on the app-level overlay rather than
// being forced out to macOS; then took its GIVEN away entirely. A shell only exists
// inside a live session's panel now (D1/R2), so "a shell with no session behind it" cannot
// be built at all, and the case cannot be re-Given from this file.
//
// Neither rule is unpinned by that. "An intercepted open with nowhere in-app to go never
// silently vanishes" is carried by the `open <unsupported file>` case above, which needs no
// shell. The overlay landing itself is's own subject and is pinned in its specs; the
// renderer path both share is `openWebPage`'s no-tab-selected branch, which lands on the
// overlay rather than the OS.
