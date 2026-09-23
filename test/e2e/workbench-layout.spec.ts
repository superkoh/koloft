import fs from 'fs'
import path from 'path'
import { test, expect, launchApp } from './helpers/app'
import type { ElectronApplication, Page } from '@playwright/test'
import type { E2EEnv } from './helpers/env'
import { setupChangeFixture } from './helpers/filesFixture'
import {
  centerTerm,
  clickAppMenuItem,
  seedJsonl,
  layoutOnDisk,
  openSessionTerminal,
  panelTerm,
  runIn,
  sendShortcut,
  setNextSessionTitle,
  settingsOnDisk,
  startSessionIn,
  waitBooted,
  waitForCalls
} from './helpers/p1'
import {
  WORKBENCH,
  seedWorkbench,
  sessionWorkbenchOnDisk,
  waitPanelAttached,
  wbTabs,
  wbUnreadTabs,
  workbenchDefaultOnDisk,
  appRegion,
  workbenchIcon,
  workbenchPanel
} from './helpers/workbench'

/**
 * Workbench · panel and layout.
 *
 * The three layout states are the whole subject: T1 collapsed / T2 right column / T3 the
 * TUI yields. They are NOT a stored enum — the renderer derives them from the session's
 * own persisted `open` plus a global, transient full-width flag. That derivation is
 * exactly why FR-07 ("a session switch dissolves T3 and lands on the TARGET's own open
 * state") has to be pinned from the outside rather than trusted.
 *
 * Accelerator convention (test/CLAUDE.md): native menu accelerators are unreachable from
 * Playwright's synthetic keys, so each is driven by its menu item id — the same path the
 * key itself takes.
 */

/** ⇧⌘B — Toggle Workbench. The command id stayed `toggle-browser` deliberately: it is
 *  the wire word `commandTarget` arbitrates on, and churning it for a label change would
 *  touch the guest-forward path and every test for nothing. */
async function toggleWorkbench(app: ElectronApplication, page: Page): Promise<void> {
  await clickAppMenuItem(app, page, 'toggle-browser')
}

/** ⌘⏎ — Focus Mode, retargeted to T2↔T3 (FR-05). Only the key is reused; the state is new. */
async function toggleFull(app: ElectronApplication, page: Page): Promise<void> {
  await clickAppMenuItem(app, page, 'toggle-focus-mode')
}

/**
 * Which of T1/T2/T3 is on screen, read only from what a user could see: whether the panel
 * is actually painted, and whether the TUI still occupies a box beside it.
 *
 * Measured in one `evaluate` rather than through two locators on purpose — in T3 the TUI
 * island is `display:none`, so a `:visible` locator matches nothing and `boundingBox()`
 * would throw and be retried rather than answering "T3". Reading computed style plus
 * offsetWidth stays black-box (both are exactly what the user sees) while surviving the
 * state whose whole point is that one of the two surfaces is gone.
 */
async function layoutState(page: Page): Promise<'T1' | 'T2' | 'T3'> {
  return page.evaluate(() => {
    const panel = document.querySelector('.wb-panel') as HTMLElement | null
    if (!panel || getComputedStyle(panel).visibility === 'hidden' || panel.offsetWidth === 0) {
      return 'T1' as const
    }
    const tui = document.querySelector('.term-island') as HTMLElement | null
    return tui && tui.offsetWidth > 0 ? ('T2' as const) : ('T3' as const)
  })
}

/** Relaunch against the SAME home — the restart half of every persistence case. */
async function relaunch(
  app: ElectronApplication,
  env: E2EEnv
): Promise<{ app: ElectronApplication; page: Page }> {
  await app.close().catch(() => {})
  const next = await launchApp(env)
  const page = await next.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitBooted(page)
  return { app: next, page }
}

// WB-L01 (FR-06, FR-55) — the accelerator and the titlebar icon are ONE gesture.
//
// FLIPPED by R2/R8. It used to end "…leaving the island alone": FR-09 made the panel
// and the shell two independent surfaces. The shell is a tab INSIDE the panel now, so
// collapsing the panel hides it and expanding brings it back — the opposite statement, and
// the one asserted here. The shell must SURVIVE the round trip all the same (R8: hidden by
// visibility, never unmounted), which is what the reappearing body is for.
test('WB-L01: ⇧⌘B and the titlebar icon both toggle the panel, shell tab and all', async ({
  app,
  page
}) => {
  test.setTimeout(180_000)
  await startSessionIn(page, 'ws-a')
  await openSessionTerminal(app, page)
  await expect(workbenchPanel(page)).toBeVisible()
  // a mark in the shell's SCROLLBACK before the round trip. Main keeps no copy of it, so
  // it is the only thing that tells "hidden" from "unmounted and rebuilt": a fresh shell
  // in a rebuilt xterm answers a new echo perfectly well and has lost this line.
  await runIn(page, panelTerm(page), 'echo WBL01_BEFORE')
  await expect(panelTerm(page)).toContainText('WBL01_BEFORE', { timeout: 25_000 })

  await toggleWorkbench(app, page)
  await expect.poll(() => layoutState(page)).toBe('T1')

  await toggleWorkbench(app, page)
  await expect.poll(() => layoutState(page)).toBe('T2')

  await workbenchIcon(page).click()
  await expect.poll(() => layoutState(page)).toBe('T1')
  await workbenchIcon(page).click()
  await expect.poll(() => layoutState(page)).toBe('T2')

  // the shell rode along and is still the same live one — it was hidden, not killed (R8)
  await expect(panelTerm(page)).toBeVisible()
  await expect(panelTerm(page)).toContainText('WBL01_BEFORE', { timeout: 25_000 })
  await runIn(page, panelTerm(page), 'echo WBL01_ALIVE')
  await expect(panelTerm(page)).toContainText('WBL01_ALIVE', { timeout: 25_000 })
})

// WB-L01b (flat layout,) — the toggle is ONE control in ONE spot. Collapsed,
// it floats at the centre's top-right corner on the bare ground; open, the island rises
// to that corner so the same button sits on the right end of the panel's own tab strip,
// beside the ＋ — which is how the panel is closed from inside itself. The two boxes
// have to agree to the pixel, or the pointer chases the button across the toggle.
test('WB-L01b: the toggle keeps its spot, on the strip when open and on the ground when collapsed', async ({
  page
}) => {
  test.setTimeout(120_000)
  await startSessionIn(page, 'ws-a')
  // a fresh session may land with its panel already open; bring it to T2 either way
  if ((await layoutState(page)) !== 'T2') await workbenchIcon(page).click()
  await expect.poll(() => layoutState(page)).toBe('T2')
  const open = (await workbenchIcon(page).boundingBox())!
  const strip = (await page.locator(WORKBENCH.tabStrip).boundingBox())!
  const plus = (await page.locator(WORKBENCH.newTab).boundingBox())!
  // on the strip: vertically inside it, right of the ＋, clear of the island's edge
  expect(open.y).toBeGreaterThanOrEqual(strip.y)
  expect(open.y + open.height).toBeLessThanOrEqual(strip.y + strip.height)
  expect(open.x).toBeGreaterThan(plus.x + plus.width)
  expect(open.x + open.width).toBeLessThan(strip.x + strip.width)

  await workbenchIcon(page).click()
  await expect.poll(() => layoutState(page)).toBe('T1')
  const closed = (await workbenchIcon(page).boundingBox())!
  expect(closed).toEqual(open)
})

// WB-L02 (FR-05) — ⌘⏎ and the kind bar's ⤢ are the same toggle. T3 is entered and left by
// the EXISTING Focus Mode key; no new menu item named T1/T2/T3 exists.
test('WB-L02: ⌘⏎ and ⤢ move between T2 and T3', async ({ app, page }) => {
  await startSessionIn(page, 'ws-a')
  await expect.poll(() => layoutState(page)).toBe('T2')

  // in T2 the strip's empty run drags the window, like the TUI's own top band beside it
  expect(await appRegion(page, WORKBENCH.dragHandle)).toBe('drag')

  await toggleFull(app, page)
  await expect.poll(() => layoutState(page)).toBe('T3')
  // the island keeps the row's 10px on its left: with the TUI's gutter gone, nothing else
  // would hold it off the sidebar's border (found by code review,)
  const side = (await page.locator('.side').boundingBox())!
  const island = (await page.locator(WORKBENCH.column).boundingBox())!
  expect(island.x - (side.x + side.width)).toBeGreaterThanOrEqual(10)
  expect(await appRegion(page, WORKBENCH.dragHandle)).toBe('drag')
  await toggleFull(app, page)
  await expect.poll(() => layoutState(page)).toBe('T2')

  // the label carries its accelerator ("Full width ⌘⏎") and flips to "Restore ⌘⏎" in T3,
  // so both are matched by prefix rather than by the exact string
  const expand = page.locator('.wb-bar .icobtn[aria-label^="Full width"]')
  const restore = page.locator('.wb-bar .icobtn[aria-label^="Restore"]')
  await expand.click()
  await expect.poll(() => layoutState(page)).toBe('T3')
  await restore.click()
  await expect.poll(() => layoutState(page)).toBe('T2')
})

// WB-L03 (FR-06) — from T3, ⇧⌘B lands on T1 in ONE step rather than stopping at T2. The
// stop-at-T2 reading is the tempting one, which is why this is its own case.
test('WB-L03: ⇧⌘B in T3 collapses straight to T1, never stopping at T2', async ({ app, page }) => {
  await startSessionIn(page, 'ws-a')
  await toggleFull(app, page)
  await expect.poll(() => layoutState(page)).toBe('T3')

  await toggleWorkbench(app, page)
  await expect.poll(() => layoutState(page)).toBe('T1')
  // the TUI is back in the centre, not merely uncovered
  await expect(centerTerm(page)).toBeVisible()
})

// WB-L04 (FR-05) — at T1 there is nothing to give the row to, so ⌘⏎ does nothing at all.
// Expanding on ⌘⏎ would make one key mean two things depending on invisible state.
test('WB-L04: ⌘⏎ at T1 is a no-op', async ({ app, page }) => {
  await startSessionIn(page, 'ws-a')
  await toggleWorkbench(app, page)
  await expect.poll(() => layoutState(page)).toBe('T1')

  await toggleFull(app, page)
  await expect.poll(() => layoutState(page)).toBe('T1')
})

// WB-L05 (FR-04, FR-05, FR-55, §6/no session) — the welcome panel. ONE aux icon (the
// Workbench toggle; the Terminal icon left with the island), aria-disabled; all
// three panel keys inert; Focus Mode greyed in the real menu.
//
// FLIPPED by D1: the tail used to be "…and the island entirely unaffected, since it
// belongs to no session". A shell needs a session to live in now, so with nothing selected
// there is no shell to be had at all. That inverted sentence — New Terminal Tab greyed on
// the welcome page — is pinned by workbench-terminal.spec.ts T-WT-07 ① together with the
// two other greyed states, and is not repeated here.
test('WB-L05: with no session the panel is unavailable', async ({ app, page }) => {
  await expect(page.locator('.aux-icons .aux-ico')).toHaveCount(1)
  await expect(workbenchIcon(page)).toHaveAttribute('aria-disabled', 'true')

  await toggleWorkbench(app, page)
  await sendShortcut(app, 'shortcut:find-files')
  await toggleFull(app, page)
  await expect(workbenchPanel(page)).toBeHidden()

  // FR-05: the menu item is genuinely disabled, not merely inert — main is told whether a
  // session is selected, because a native accelerator cannot gate on renderer state
  await expect
    .poll(() =>
      app.evaluate(
        ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('toggle-focus-mode')?.enabled
      )
    )
    .toBe(false)

  // …and the same for New Terminal Tab (D1/R5). It is disabled for its OWN reason —
  // a shell needs a live session to live in — and read the same way, because a native
  // accelerator cannot gate on renderer state either.
  await expect
    .poll(() =>
      app.evaluate(
        ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('new-terminal-tab')?.enabled
      )
    )
    .toBe(false)
})

// WB-L06 (FR-07) — the case the derivation exists for. Leaving T3 by a session SWITCH must
// land on the TARGET's own open state, and T3 itself is neither restored nor written.
test('WB-L06: switching sessions dissolves T3 and lands on the target’s own open state', async ({
  app,
  page
}) => {
  await startSessionIn(page, 'ws-a')
  await startSessionIn(page, 'ws-a')
  const rows = page.locator('.ws-tab')
  await expect(rows).toHaveCount(2, { timeout: 20_000 })
  const rowB = rows.nth(0)
  const rowA = rows.nth(1)

  // B collapses…
  await rowB.click()
  await toggleWorkbench(app, page)
  await expect.poll(() => layoutState(page)).toBe('T1')

  // …A stays expanded and goes full width
  await rowA.click()
  await expect(workbenchPanel(page)).toBeVisible()
  await toggleFull(app, page)
  await expect.poll(() => layoutState(page)).toBe('T3')

  await rowB.click()
  await expect.poll(() => layoutState(page)).toBe('T1')

  await rowA.click()
  // back on A: T2, NOT the T3 it was left in — T3 is neither persisted nor per-session
  await expect.poll(() => layoutState(page)).toBe('T2')
})

// WB-L07 (FR-08, NFR-07) — the floor is 440 for EVERY kind now: the merge inherited
// Preview's 320 and the Browser's 440 and kept the higher one, because after the merge any
// tab can be a web tab and a page below 440 hits most sites' mobile breakpoint.
test('WB-L07: the divider clamps at 440 and the width survives a restart', async ({
  app,
  page,
  env
}) => {
  await startSessionIn(page, 'ws-a')

  const gutter = page.locator('.center-row .gutter-v').last()
  const box = await gutter.boundingBox()
  expect(box).not.toBeNull()

  // drag hard right: the panel stops shrinking at its floor rather than vanishing
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2)
  await page.mouse.down()
  await page.mouse.move(box!.x + 4000, box!.y + box!.height / 2, { steps: 12 })
  await page.mouse.up()
  const clamped = (await workbenchPanel(page).boundingBox())!.width
  expect(clamped).toBeGreaterThanOrEqual(438)
  expect(clamped).toBeLessThan(470)

  // …then out to a known wider value, which is what a restart has to bring back
  const after = (await gutter.boundingBox())!
  await page.mouse.move(after.x + after.width / 2, after.y + after.height / 2)
  await page.mouse.down()
  await page.mouse.move(after.x - 220, after.y + after.height / 2, { steps: 12 })
  await page.mouse.up()
  const widened = (await workbenchPanel(page).boundingBox())!.width
  expect(widened).toBeGreaterThan(600)
  await expect.poll(() => settingsOnDisk(env).workbenchWidth as number).toBeGreaterThan(600)

  const next = await relaunch(app, env)
  await startSessionIn(next.page, 'ws-a')
  const restored = (await workbenchPanel(next.page).boundingBox())!.width
  expect(Math.abs(restored - widened)).toBeLessThan(6)
  await next.app.close().catch(() => {})
})

// WB-L09 — FLIPPED by R18. It used to read "the island toggles the same in T1/T2/T3
// and never disturbs the panel", on FR-09's premise that the two were separate surfaces.
// ⌃` opens a tab INSIDE the panel now, so it is not layout-neutral: from T1 it EXPANDS to
// T2, and from T2 or T3 it leaves the layout exactly where it is. The T1 half is also
// T-WT-01's opening line; the T2/T3 halves are only here — R18's "expand first, then act"
// is easy to write as "always go to T2", which would silently drop a user out of Focus
// Mode every time they asked for a shell.
test('WB-L09: ⌃` expands a collapsed panel and leaves T2 and T3 exactly where they are', async ({
  app,
  page
}) => {
  test.setTimeout(240_000)
  await startSessionIn(page, 'ws-a')

  // T1 → the shell brings the panel back up
  await toggleWorkbench(app, page)
  await expect.poll(() => layoutState(page)).toBe('T1')
  await openSessionTerminal(app, page)
  await expect.poll(() => layoutState(page)).toBe('T2')

  // T2 → stays T2
  await openSessionTerminal(app, page)
  await expect.poll(() => layoutState(page)).toBe('T2')

  // T3 → stays T3: asking for a shell must not drop the user out of Focus Mode
  await toggleFull(app, page)
  await expect.poll(() => layoutState(page)).toBe('T3')
  await openSessionTerminal(app, page)
  await expect.poll(() => layoutState(page)).toBe('T3')
})

// WB-L10 (NFR-05) — the reliability case behind T3. The TUI leaves the layout ENTIRELY in
// T3, so a round trip is exactly where an xterm comes back blank or dead. Both halves are
// asserted: the buffer content, and that the pty still executes.
test('WB-L10: a T2→T3→T2 round trip leaves the TUI’s buffer and its pty intact', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await startSessionIn(page, 'ws-a')

  const errors: string[] = []
  page.on('pageerror', (e) => errors.push(e.message))

  // the centre TUI runs claude, not a shell: `/write <rel>` is fake-claude's own
  // file-writing sentinel, and a typed line is what puts assertable text in the buffer
  await runIn(page, centerTerm(page), 'WB_L10_MARK')
  await expect(centerTerm(page)).toContainText('WB_L10_MARK', { timeout: 25_000 })
  const before = await centerTerm(page).innerText()

  await toggleFull(app, page)
  await expect.poll(() => layoutState(page)).toBe('T3')
  await toggleFull(app, page)
  await expect.poll(() => layoutState(page)).toBe('T2')

  await expect.poll(() => centerTerm(page).innerText()).toBe(before)

  // the pty is not merely painted — it still ACCEPTS INPUT and acts on it. A file landing
  // on disk is proof that holds independently of anything the renderer claims.
  const marker = path.join(env.workspaces.a, 'wb-l10-marker.txt')
  await runIn(page, centerTerm(page), '/write wb-l10-marker.txt')
  await expect.poll(() => fs.existsSync(marker), { timeout: 30_000 }).toBe(true)

  expect(errors).toEqual([])
})

// WB-P01 (§Data Model, FR-56) — the split between what survives a restart and what does
// not. The tab SET and the open flag come back; `activeId`, every unread mark and the
// FR-56 backlink deliberately do not: persisting a selection would turn every tab switch
// into a layout.json write.
test('WB-P01: tabs and open survive a restart; activeId, unread and the backlink do not', async ({
  app,
  env
}) => {
  const sessionId = 'restart-session-1'
  // §6 GC: a `sessions` key whose transcript is gone is dropped on the first rescan, so
  // an id invented purely for a fixture needs a jsonl or it vanishes for the wrong reason
  seedJsonl(env, env.workspaces.a, { id: sessionId, owned: false })
  const filePath = path.join(env.workspaces.a, 'a.md')
  fs.writeFileSync(filePath, '# a\n')
  seedWorkbench(env, sessionId, {
    open: true,
    tabs: [
      { kind: 'web', title: 'A', url: 'http://127.0.0.1:1/a' },
      { kind: 'file', title: 'a.md', path: filePath }
    ]
  })

  const next = await relaunch(app, env)
  const stored = sessionWorkbenchOnDisk(env, sessionId)
  expect(stored?.open).toBe(true)
  expect(stored?.tabs.map((t) => t.kind)).toEqual(['web', 'file'])
  // nothing about the SELECTION reached disk
  const raw = JSON.stringify(stored)
  expect(raw).not.toContain('activeId')
  expect(raw).not.toContain('unread')
  expect(raw).not.toContain('sourceTabId')
  await next.app.close().catch(() => {})
})

// WB-P03 (NFR-06) — the migration's headline guarantee, asserted from the outside: an
// upgrading user must not lose their workspace list. The v2 guard required `aux`, and
// anything unrecognised degraded to the EMPTY document, so renaming that key without a
// version gate would have wiped it.
test('WB-P03: a v2 layout upgrades without losing workspaces or sessions, idempotently', async ({
  app,
  env
}) => {
  await app.close().catch(() => {})
  const wsPath = env.workspaces.a
  // Each id needs a jsonl of its own: §6 GC drops a `sessions` key whose transcript is
  // gone from Claude's storage on the first rescan, so ids invented purely for a fixture
  // would vanish for a reason that has nothing to do with the migration under test.
  for (const id of ['sid-browser', 'sid-preview', 'sid-collapsed']) {
    seedJsonl(env, wsPath, { id, owned: false })
  }
  fs.writeFileSync(
    path.join(env.userData, 'layout.json'),
    JSON.stringify({
      version: 2,
      workspaces: [{ path: wsPath }],
      aux: { defaultMode: 'preview' },
      sessions: {
        'sid-browser': {
          auxMode: 'browser',
          browser: {
            tabs: [
              { url: 'http://127.0.0.1:1/one', title: 'One' },
              { url: 'http://127.0.0.1:1/two', title: 'Two' }
            ]
          }
        },
        'sid-preview': { auxMode: 'preview' },
        'sid-collapsed': { auxMode: null }
      }
    })
  )

  let current = await launchApp(env)
  let page = await current.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitBooted(page)

  const doc = layoutOnDisk(env) as unknown as {
    version: number
    workspaces: { path: string }[]
    sessions: Record<string, { open: boolean; tabs: { kind: string; url?: string }[] }>
  }
  expect(doc.version).toBe(4)
  expect(doc.workspaces.map((w) => w.path)).toEqual([wsPath])
  expect(Object.keys(doc.sessions).sort()).toEqual(['sid-browser', 'sid-collapsed', 'sid-preview'])
  // v4: every upgraded panel lands COLLAPSED, whatever its mode was — v2
  // seeded `auxMode` from `aux.defaultMode` at every bind, so a non-null mode never said
  // anything about the user. The tabs are the user's work and ride through.
  expect(doc.sessions['sid-browser'].open).toBe(false)
  expect(doc.sessions['sid-browser'].tabs.map((t) => t.kind)).toEqual(['web', 'web'])
  expect(doc.sessions['sid-browser'].tabs.map((t) => t.url)).toEqual([
    'http://127.0.0.1:1/one',
    'http://127.0.0.1:1/two'
  ])
  expect(doc.sessions['sid-preview'].open).toBe(false)
  expect(doc.sessions['sid-collapsed'].open).toBe(false)

  // a second cold start of the upgraded document changes nothing (NFR-06's idempotence)
  const first = fs.readFileSync(path.join(env.userData, 'layout.json'), 'utf8')
  await current.close().catch(() => {})
  current = await launchApp(env)
  page = await current.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitBooted(page)
  expect(fs.readFileSync(path.join(env.userData, 'layout.json'), 'utf8')).toBe(first)
  await current.close().catch(() => {})
})

// WB-P04 (§6/hand-edited layout) — per-item repair, never wholesale rejection. One dirty
// entry must never blank the whole panel, which is the failure this shape exists to
// prevent.
test('WB-P04: a dirty layout sanitises per item instead of blanking the panel', async ({
  app,
  env
}) => {
  await app.close().catch(() => {})
  seedJsonl(env, env.workspaces.a, { id: 'sid-dirty', owned: false })
  const twelve = Array.from({ length: 12 }, (_, i) => ({
    kind: 'web',
    title: `T${i}`,
    url: `http://127.0.0.1:1/${i}`
  }))
  fs.writeFileSync(
    path.join(env.userData, 'layout.json'),
    JSON.stringify({
      version: 4,
      workspaces: [{ path: env.workspaces.a }],
      workbench: { defaultOpen: true },
      sessions: {
        'sid-dirty': {
          open: true,
          tabs: [{ kind: 'web', title: 'no url' }, { kind: 'wat', title: 'x' }, ...twelve]
        }
      }
    })
  )

  const current = await launchApp(env)
  const page = await current.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitBooted(page)

  const tabs = sessionWorkbenchOnDisk(env, 'sid-dirty')?.tabs ?? []
  // the url-less web tab and the unknown kind are gone; the valid twelve truncate to 8
  expect(tabs).toHaveLength(8)
  expect(tabs.every((t) => t.kind === 'web' && !!t.url)).toBe(true)
  // …and the app is standing, with the workspace list intact
  expect((layoutOnDisk(env) as unknown as { workspaces: unknown[] }).workspaces).toHaveLength(1)
  await current.close().catch(() => {})
})

// WB-P05 (§Data Model) — the width seeds from the WIDER of the two retired keys, so the
// panel opens at a width the user already dragged to. Those two keys deliberately stay on
// disk: settings.json merges then rewrites whole and has no key-deletion mechanism.
test('WB-P05: workbenchWidth initialises from the larger of the two retired widths', async ({
  app,
  env
}) => {
  await app.close().catch(() => {})
  const settingsFile = path.join(env.userData, 'settings.json')
  const existing = fs.existsSync(settingsFile)
    ? JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
    : {}
  fs.writeFileSync(
    settingsFile,
    JSON.stringify({ ...existing, filePaneWidth: 500, browserPaneWidth: 620 }, null, 2)
  )

  const current = await launchApp(env)
  const page = await current.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')

  const width = (await workbenchPanel(page).boundingBox())!.width
  expect(Math.abs(width - 620)).toBeLessThan(6)
  // …and the two retired keys are still there, untouched
  const onDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
  expect(onDisk.filePaneWidth).toBe(500)
  expect(onDisk.browserPaneWidth).toBe(620)
  await current.close().catch(() => {})
})

// WB-K07 (FR-51, §6/opens while collapsed) — the decision taken out loud: a collapsed
// panel leaves ZERO signal. Not a smaller dot, not a count — no element at all. The
// accepted consequence is that files the agent opens during collapse are undiscoverable
// until the panel is expanded, which is why the FILE half is asserted here too.
test('WB-K07: a collapsed panel shows no count and no unread dot on the titlebar', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await startSessionIn(page, 'ws-a')
  await toggleWorkbench(app, page)
  await expect.poll(() => layoutState(page)).toBe('T1')

  const before = await wbTabs(page).count()

  // the agent opens two pages and writes a file, all while the panel is collapsed.
  // `/open` spawns the open shim from inside the session's OWN pty, which is what makes
  // this an agent-source request rather than the island's user-source one (FR-13 vs FR-57).
  await runIn(page, centerTerm(page), '/open http://127.0.0.1:1/one')
  await runIn(page, centerTerm(page), '/open http://127.0.0.1:1/two')
  await runIn(page, centerTerm(page), '/write wb-k07-written.txt')
  await expect
    .poll(() => fs.existsSync(path.join(env.workspaces.a, 'wb-k07-written.txt')), {
      timeout: 30_000
    })
    .toBe(true)

  // The panel never expanded itself, and the titlebar carries NO signal element at all —
  // neither the unread dot the former Eye/Globe had nor a count. That is the whole of
  // FR-51, and it is what makes the agent's work invisible until the panel is opened.
  expect(await layoutState(page)).toBe('T1')
  await expect(workbenchIcon(page)).not.toHaveClass(/unread/)
  await expect(workbenchIcon(page).locator('.cnt')).toHaveCount(0)

  // The two web opens DID build background tabs (FR-13) — the marks live on the strip,
  // not on the titlebar. The file write built none (FR-14): that is the asymmetry the
  // merge introduced, so the count grows by exactly the two urls and no more.
  await expect.poll(() => wbTabs(page).count()).toBe(before + 2)
  await expect(wbUnreadTabs(page)).toHaveCount(2)

  // …and expanding does NOT batch-clear them (FR-16): only activation clears a mark.
  await toggleWorkbench(app, page)
  await expect.poll(() => layoutState(page)).toBe('T2')
  await expect(wbUnreadTabs(page)).toHaveCount(2)
})

// ---- the shipped default -------------------------------------------------------

/**
 * layout.json with NO `workbench` block — the shipped default, nothing seeded. The suite's
 * own seed (helpers/env.ts) opts every other case into `defaultOpen: true`, which is
 * precisely the pre-v4 "arrives expanded" feel the two cases below exist to prove is gone,
 * so they delete it rather than seed `false`: a seeded `false` would pass against a build
 * that still ships `true`. Must run with the app down — main reads layout.json once.
 */
function unseedWorkbenchDefault(env: E2EEnv): void {
  const file = path.join(env.userData, 'layout.json')
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>
  delete doc.workbench
  fs.writeFileSync(file, JSON.stringify(doc, null, 2))
}

const rowTitled = (page: Page, title: string): ReturnType<Page['locator']> =>
  page.locator('.ws-tab').filter({ has: page.locator('.ws-tab-title', { hasText: title }) })

// WB-L11 — the panel is HIDDEN unless the user opened it. A fresh session
// lands on T1, and the document says so afterwards in both places: the entry main seeded
// for the session, and the default a never-seen session inherits. Until this change the
// default shipped `true` with no UI to change it, so every new session and every resume
// sprang the panel open — the complaint that prompted the bump to layout v4.
test('WB-L11: under the shipped default a new session starts with the panel collapsed', async ({
  app,
  env
}) => {
  await app.close().catch(() => {})
  unseedWorkbenchDefault(env)
  const next = await relaunch(app, env)
  try {
    await startSessionIn(next.page, 'ws-a')
    await expect.poll(() => layoutState(next.page)).toBe('T1')
    // the toggle is live (a session is selected), just not lit
    await expect(workbenchIcon(next.page)).toHaveAttribute('aria-disabled', 'false')
    await expect(workbenchIcon(next.page)).not.toHaveClass(/\bon\b/)
    const [call] = await waitForCalls(env, 1)
    await expect
      .poll(() => sessionWorkbenchOnDisk(env, call.sessionId)?.open, { timeout: 20_000 })
      .toBe(false)
    expect(workbenchDefaultOnDisk(env)).toBe(false)
  } finally {
    await next.app.close().catch(() => {})
  }
})

// WB-P06 — the mirror of T-AUX-02 (workbench-aux.spec.ts), and the
// informative direction now that collapsed is the default: a panel the user EXPANDED is
// remembered for THAT session across a restart and a resume, while a session they never
// touched still lands collapsed. Under the old default this direction was the trivial one
// (everything came back open), which is why only the collapse was pinned before.
//
// The assertion carrying the case is the T2 after the resume: with nothing seeded, the
// shipped default cannot produce it, so it proves the session's own entry was read. The
// second session in the first run is what separates "per session" from "global" — a
// build that flipped the default on the first toggle would pass the resume half alone.
test('WB-P06: an expanded panel is remembered per session across a restart and a resume', async ({
  app,
  env
}) => {
  test.setTimeout(300_000)
  await app.close().catch(() => {})
  unseedWorkbenchDefault(env)

  let idA = ''
  const first = await relaunch(app, env)
  try {
    setNextSessionTitle(env, 'Session A')
    await startSessionIn(first.page, 'ws-a')
    const [callA] = await waitForCalls(env, 1)
    idA = callA.sessionId
    await expect.poll(() => layoutState(first.page)).toBe('T1')
    await toggleWorkbench(first.app, first.page)
    await expect.poll(() => layoutState(first.page)).toBe('T2')
    // polled rather than slept: the panel write is debounced in main
    await expect.poll(() => sessionWorkbenchOnDisk(env, idA)?.open, { timeout: 20_000 }).toBe(true)

    // a second session is its own session: still collapsed, and A's expand untouched
    setNextSessionTitle(env, 'Session B')
    await startSessionIn(first.page, 'ws-a')
    await expect.poll(() => layoutState(first.page)).toBe('T1')
    expect(sessionWorkbenchOnDisk(env, idA)?.open).toBe(true)
  } finally {
    await first.app.close().catch(() => {})
  }

  // relaunch cold, resume A — the expand comes back with it
  const second = await relaunch(first.app, env)
  try {
    const page = second.page
    const rowA = rowTitled(page, 'Session A')
    await expect(rowA).toHaveCount(1, { timeout: 30_000 })
    await expect(rowA).toHaveClass(/\bcold\b/, { timeout: 30_000 })
    await rowA.click()
    await waitForCalls(env, 3) // the resume really relaunched claude, under the same id
    // the row leaving `cold` is NOT the bind (`st-pending` is not cold either) — the panel
    // has no session until the icon goes live, and only then can `open` mean anything
    await waitPanelAttached(page)
    await expect(rowA).not.toHaveClass(/\bcold\b/, { timeout: 60_000 })
    await expect.poll(() => layoutState(page), { timeout: 30_000 }).toBe('T2')
    await expect(workbenchPanel(page)).toBeVisible()
  } finally {
    await second.app.close().catch(() => {})
  }
})

// WB-L12 — a collapse is answered in the click's own frame, however heavy
// the panel's content. Collapsing is two changes of very different cost: the column going
// to zero width, and the panel learning it is off — `visibility: hidden` over its whole
// subtree plus WorkbenchPane dropping the Changes stream, an unmount of every node. Both
// used to land in the click's commit, and the column's zero width relaid the panel's
// contents out at width 0 on top: a Changes stream of six 900-line files measured 220–310ms
// of style+layout between the click and the first changed pixel. Now the panel keeps its
// box while the column collapses, and it is told it is off two frames later — once the
// collapsed column is on screen (App's `panelVisible`).
//
// Two oracles, because the timing one is the user-visible fact and the ordering one is
// what fails without noise: the panel's box is unchanged right after React's flush (an
// unchanged box is a subtree the browser does not lay out again), the collapse and the
// visibility drop land in DIFFERENT mutation batches, and the forced layout after the
// flush stays under a budget the old code missed by an order of magnitude.
test('WB-L12: collapsing a heavy panel paints in the click’s frame; the rest follows', async ({
  app,
  env,
  page
}) => {
  test.setTimeout(120_000)
  const fx = setupChangeFixture(env.workspaces.a)
  fx.bigChange()
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  if (!(await workbenchPanel(page).isVisible())) await workbenchIcon(page).click()
  await expect.poll(() => layoutState(page)).toBe('T2')
  await expect(page.locator('.wb-panel .cv-blk')).toHaveCount(6, { timeout: 60_000 })
  await expect(page.locator('.wb-panel .cv-blk:not([data-ready="1"])')).toHaveCount(0, {
    timeout: 60_000
  })
  // scroll the whole stream once so every block is highlighted — the heaviest DOM it gets
  await page.locator('.wb-panel .cv-stream').evaluate(async (el) => {
    for (let y = 0; y < el.scrollHeight; y += 600) {
      el.scrollTop = y
      await new Promise((r) => setTimeout(r, 30))
    }
    el.scrollTop = 0
  })
  await page.waitForTimeout(1000)

  const collapse = (): Promise<{
    before: { w: number; h: number }
    after: { w: number; h: number; col: number }
    layoutMs: number
    log: string[]
  }> =>
    page.evaluate(async () => {
      const col = document.querySelector('.wb-col') as HTMLElement
      const panel = document.querySelector('.wb-panel') as HTMLElement
      const before = { w: panel.offsetWidth, h: panel.offsetHeight }
      // one line per change we care about, stamped with the mutation batch (= React commit)
      const log: string[] = []
      let batch = 0
      const mo = new MutationObserver((recs) => {
        batch++
        for (const rec of recs) {
          const el = rec.target as HTMLElement
          if (el === col && rec.attributeName === 'class' && el.classList.contains('off')) {
            log.push(`${batch} col-off`)
          }
          if (el === panel && rec.attributeName === 'data-surface' && !el.dataset.surface) {
            log.push(`${batch} panel-off`)
          }
        }
      })
      mo.observe(document.body, { subtree: true, attributes: true })
      const icon = document.querySelector('.aux-ico[aria-label="Workbench"]') as HTMLElement
      icon.click()
      for (let i = 0; i < 5; i++) await Promise.resolve() // React's flush of the click
      const after = { w: panel.offsetWidth, h: panel.offsetHeight, col: col.offsetWidth }
      const t0 = performance.now()
      void document.body.getBoundingClientRect() // force the click frame's style + layout
      const layoutMs = performance.now() - t0
      await new Promise((r) => setTimeout(r, 300))
      mo.disconnect()
      return { before, after, layoutMs, log }
    })
  const r = await collapse()
  expect(r.after.col).toBe(0)
  expect(r.after).toMatchObject(r.before)
  const batchOf = (m: string): number => {
    const line = r.log.find((l) => l.endsWith(m))
    expect(line, `no "${m}" in ${JSON.stringify(r.log)}`).toBeDefined()
    return Number(line!.split(' ')[0])
  }
  expect(batchOf('panel-off')).toBeGreaterThan(batchOf('col-off'))
  expect(r.layoutMs, `click-frame layout took ${r.layoutMs}ms`).toBeLessThan(60)
  await expect.poll(() => layoutState(page)).toBe('T1')

  // …and from Focus Mode (T3), where the panel spans the whole row: ⇧⌘B collapses
  // straight to T1 (WB-L03), and the box it keeps has to be the one it HAD — the row's
  // width, not the side-by-side width (code review,: `--wb-w` was always the
  // latter, so a collapse out of T3 relaid out the whole stream after all).
  await workbenchIcon(page).click()
  await expect.poll(() => layoutState(page)).toBe('T2')
  await expect(page.locator('.wb-panel .cv-blk:not([data-ready="1"])')).toHaveCount(0, {
    timeout: 60_000
  })
  await toggleFull(app, page)
  await expect.poll(() => layoutState(page)).toBe('T3')
  await page.waitForTimeout(500)
  const r3 = await collapse()
  expect(r3.after.col).toBe(0)
  expect(r3.after).toMatchObject(r3.before)
  await expect.poll(() => layoutState(page)).toBe('T1')
})
