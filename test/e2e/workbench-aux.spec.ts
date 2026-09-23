import fs from 'fs'
import path from 'path'
import type { Locator } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import {
  auxIcon,
  FAKE_SESSION_TITLE,
  gitInit,
  layoutOnDisk,
  openSessionTerminal,
  panelTerm,
  processAlive,
  readCalls,
  runIn,
  sendShortcut,
  snap,
  startSessionIn,
  waitForCalls,
  wsRows
} from './helpers/p1'
import {
  openInBrowse,
  sessionWorkbenchOnDisk,
  waitPanelAttached,
  WORKBENCH,
  workbenchPanel
} from './helpers/workbench'
import type { E2EEnv } from './helpers/env'

/**
 * A user-source `open` typed into a shell — the ONE user open still reachable while the
 * panel is collapsed, now that the sidebar tree has retired into the panel's own Browse
 * half. FR-57 is what makes it user-source: no agent can reach a shell (interactive claude
 * is hard-blocked there, R3). moved the shell INTO the session's panel, so a caller
 * that needs the panel shut fires this from behind a `sleep` and collapses afterwards.
 *
 * The PATH pinning is not decoration: a session pty is a login shell and macOS's
 * path_helper would otherwise hoist the REAL /usr/bin/open, launching an actual app on the
 * developer's machine. Same reasoning, same spelling, as open-intercept.spec.ts.
 */
function shellOpen(env: E2EEnv, cwd: string, target: string): string {
  return `export PATH="${env.shimDir}:${env.fakeBin}:$PATH"; hash -r; cd '${cwd}'; open ${target}`
}

// The titlebar cluster, and the panel's seam with everything that used to share the aux
// column with it, as they stand merged that column into the Workbench panel.
//
// This file used to be mostly the global terminal island's (global-terminal design
// D1–D13). retired the
// island itself: every shell case moved to workbench-terminal.spec.ts, driven through a
// session's own terminal tab, and the retirement notes below record where each id went
// and why. What is left is the aux half: the Eye and the Globe merged into one Workbench
// toggle (FR-55) and `auxMode` became the session's own `open` flag in layout v3, so
// T-AUX-01/02 and T-MIG-08 are retargeted onto the panel below.
//
// The panel's OWN layout contract (T1/T2/T3, ⇧⌘B, ⌘⏎, the divider, persistence and the
// v2→v3 migration) is workbench-layout.spec.ts.
//
// Every case drives the product path: sessions start from the sidebar's New session
// (the only entry point left, A1) and the shortcuts travel the §0 IPC / menu seams.

/** computed style of one property, read off the live element */
function styleOf(loc: Locator, prop: string): Promise<string> {
  return loc.evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop) as Promise<string>
}

// RETIRED HERE — T-GT-01…T-GT-05, the global terminal island's own cases.
//
//   T-GT-01 (⌃` shows / refocuses / collapses the island)  → rewritten as T-WT-01 in
//     workbench-terminal.spec.ts: ⌃` is not a three-state toggle any more (D3), it opens
//     one terminal tab in the selected session and puts the caret in it.
//   T-GT-02 (in-island ⌘T / ⌘W, last ⌘W collapses)         → T-WT-01's ⌘T half and T-WT-03.
//     "the last ⌘W only collapses" is gone with the island: ⌘W kills the shell (R6).
//   T-GT-03 (the strip's titles, cwds and visibility survive a restart) → T-WT-12,
//     flipped: terminal tabs are not layout data at all now (D4), so NOTHING survives.
//     Double-click rename went with the strip and is deliberately not replaced (§03).
//   T-GT-04 (a saved folder that vanished falls back up the chain) and
//   T-GT-05 (the island's height persists, and is clamped) — both retire outright per the
//     design's §08. Their subjects no longer exist: nothing is saved to fall back FROM
//     (a shell starts in its conversation tab's root, R4), and a panel tab has no height
//     of its own.

// T-AUX-01 (retargeted for FR-55/FR-04/FR-09) — the titlebar cluster's two icons and
// what each of them owns. The Eye and the Globe merged into ONE Workbench toggle, so the
// old "Preview owns the aux column" clause is now "the Workbench icon owns the panel".
//
// FLIPPED by D1. The tail used to be "…the Terminal icon is unchanged — never
// disabled, because the island belongs to no session". A shell needs a live session now,
// so the Terminal icon is greyed in three states; that inverted sentence is
// workbench-terminal.spec.ts T-WT-07's whole subject and is not repeated here. What is
// left is what this id has always been about: the Workbench icon's own paint.
//
// The unavailable-with-no-session half is FR-04's, and it is asserted here as the user
// meets it: a greyed but REAL button that swallows a press. (workbench-layout's WB-L05
// pins the roster count and the menu item's enabled flag; what is here is the icon's own
// paint and the swallowed click.)
test('T-AUX-01: the Workbench icon owns the panel, dead without a session and lit with one', async ({
  page,
  env
}) => {
  test.setTimeout(180_000)
  gitInit(env.workspaces.a)
  const workbench = auxIcon(page, 'Workbench')

  // ① nothing selected: the Workbench icon is dead (no session to attach a panel to) and
  // says so
  await expect(page.locator('.w-empty')).toBeVisible({ timeout: 20_000 })
  await expect(workbench).toHaveAttribute('aria-disabled', 'true')
  expect(await styleOf(workbench, 'opacity')).toBe('0.35')
  // `force` because Playwright reads aria-disabled as disabled and would refuse the
  // click — which is the point: the button is a REAL target that ignores the press
  await workbench.click({ force: true })
  await page.waitForTimeout(1000)
  await expect(workbenchPanel(page)).toBeHidden()

  // ② with a session up the panel is there (T2, the default), and a Browse click lands the
  // file in its `files` tab — the reading area beside the tree, under FR-31's own artifact
  // header. The sidebar tree this used to click retired INTO that Browse half, which is why
  // the route grew a step and the `.ft-*` locators did not change.
  await startSessionIn(page, 'ws-a')
  await expect(workbenchPanel(page)).toBeVisible()
  await openInBrowse(page, path.join(env.workspaces.a, 'NOTES.md'))
  await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('NOTES.md')
  await expect(workbench).toHaveClass(/\bon\b/)

  await snap(page, 'T-AUX-01')

  // ③ pressing the lit Workbench icon collapses the panel again
  await workbench.click()
  await expect(workbenchPanel(page)).toBeHidden()
  await expect(workbench).not.toHaveClass(/\bon\b/)
})

// T-AUX-02 (retargeted §Data Model) — the panel's collapse is a property of the
// SESSION, not of the window: a session the user collapsed stays collapsed across a
// restart, keyed by its own id. v2 spelled that `sessions[id].auxMode: null`; v3 spells
// it `sessions[id].open: false`, which is the same fact through a smaller field — the
// third value ('browser') that made it an enum went with the merge.
//
// The second half is the one a persisted flag can silently break: a resume must land on
// the collapse and a user's own file open must still overcome it (FR-57 — a user open is
// panel intent, so it activates `files` and expands to T2).
//
// That open used to be a sidebar-tree click. The tree retired INTO the panel, so with the
// panel collapsed there is nothing left to click: reaching Browse would mean expanding the
// panel by hand first, which is the very transition this half exists to observe. A shell's
// own `open` is the user-source route FR-57 itself names, and the only one that can be
// fired from outside a collapsed panel — so it is the vehicle.
//
// changed how that vehicle is loaded, not what it proves. A shell is a tab inside the
// panel now, and opening one EXPANDS the panel (R5) — so the run below reaches the shell,
// re-collapses the panel by hand, and fires the `open` from behind a `sleep`. The state the
// open has to overcome is the same collapsed panel either way; what the restart half proved
// (the persisted `open: false` was read back) is asserted before any of that happens.
test('T-AUX-02: a collapsed panel is remembered per session, across a restart', async ({ env }) => {
  test.setTimeout(300_000)
  gitInit(env.workspaces.a)

  const app1 = await launchApp(env)
  const page1 = await app1.firstWindow()
  await page1.waitForLoadState('domcontentloaded')
  let idA = ''
  try {
    await expect(page1.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
    await startSessionIn(page1, 'ws-a')
    const [callA] = await waitForCalls(env, 1)
    idA = callA.sessionId
    // the panel is up here, so Browse is reachable and is the cheapest vehicle
    await openInBrowse(page1, path.join(env.workspaces.a, 'NOTES.md'))
    await expect(page1.locator(WORKBENCH.readingTitle)).toHaveText('NOTES.md')
    await auxIcon(page1, 'Workbench').click() // collapse it for THIS session
    await expect(workbenchPanel(page1)).toBeHidden()

    // polled rather than slept: the panel write is debounced in main
    await expect.poll(() => sessionWorkbenchOnDisk(env, idA)?.open, { timeout: 20_000 }).toBe(false)
    await snap(page1, 'T-AUX-02')
  } finally {
    await app1.close().catch(() => {})
  }

  // relaunch cold, resume A — the collapse comes back with it
  const app2 = await launchApp(env)
  try {
    const page2 = await app2.firstWindow()
    await page2.waitForLoadState('domcontentloaded')
    const rowA = wsRows(page2, 'ws-a').first()
    await expect(rowA).toHaveClass(/\bcold\b/, { timeout: 30_000 })
    await rowA.click()
    await waitForCalls(env, 2) // the resume really relaunched claude, under the same id
    // …and the panel is ATTACHED to it. The row leaving `cold` is NOT enough — it turns
    // running the moment the resume tab is created, while the panel has no session until
    // the bind lands, and a file click inside that window is T-AUX-02b's whole subject.
    await waitPanelAttached(page2)
    await expect(rowA).not.toHaveClass(/\bcold\b/, { timeout: 60_000 })
    // …and the panel came back collapsed. A fetch that never landed would leave it on
    // the `?? true` default, so this is what proves the entry was read.
    await expect(workbenchPanel(page2)).toBeHidden({ timeout: 30_000 })
    await expect(auxIcon(page2, 'Workbench')).not.toHaveClass(/\bon\b/)

    // …and a user's own open IS panel intent (FR-57), so the panel expands and renders —
    // a collapsed panel is what it has to overcome. Fired from a shell, the only
    // user-source open there is while the panel is shut (see the header).
    await openSessionTerminal(app2, page2)
    await runIn(page2, panelTerm(page2), `sleep 3; ${shellOpen(env, env.workspaces.a, 'NOTES.md')}`)
    await auxIcon(page2, 'Workbench').click() // collapse again, request still in flight
    await expect(workbenchPanel(page2)).toBeHidden()
    await expect(workbenchPanel(page2)).toBeVisible({ timeout: 30_000 })
    await expect(page2.locator(WORKBENCH.readingTitle)).toHaveText('NOTES.md', {
      timeout: 30_000
    })
  } finally {
    await app2.close().catch(() => {})
  }
})

// RETIRED HERE — T-AUX-02b, "a file opened while a resume is still binding still
// expands the panel". Recorded rather than deleted, because it was written red twice and
// the reasoning for letting it go is the whole point.
//
// Its GIVEN became unreachable. The case needed a user-source `open` fired inside the
// pre-bind window, and a shell was the only route that could be fired from outside a
// collapsed panel. Under D1/R5 a shell needs a bound, live session: the Terminal icon and
// ⌃` are both greyed for exactly the window this case measured, so the vehicle cannot be
// built any more. Another session's shell is no substitute — R12 routes its `open` to its
// OWN conversation tab.
//
// What it guarded is designed out rather than merely unpinned. The regression was
// `useFilesController`'s reset effect firing when a BIND took `sessionId` from null to a
// real id, wiping a pre-bind user open. D8/R1 key that reset on the conversation tab, which
// does not change at a bind at all — the transition that caused the bug no longer exists.
// The store-lookup half (`setOpenFile` resolving the id off the tab's anchor) is the same
// tab-keyed shape D8 makes universal.
//
// Two fixture facts from it outlived the case; they are on `waitPanelAttached`.

// RETIRED HERE — T-BLK-05, "an interactive claude in the global terminal is turned
// away; the shell and `-p` are fine". The rule is unchanged (R3: a shell is the user's
// hand, never an agent surface) but both its surface and its wording moved: the shim's
// notice now says "this is a Koloft terminal, not an agent surface". It is rewritten
// through a session's own terminal tab as T-WT-05 in workbench-terminal.spec.ts.

// T-AUX-07 — ⇧⌘R acts on the SELECTED running session (contract id `restart-session`,
// unchanged): the row the user is on is the one that respawns, and with nothing
// running the trigger is inert. The rest of the restart contract (in-place swap, dead
// old process, preserved pane) stays in restart-session.spec.
test('T-AUX-07: ⇧⌘R restarts the selected running session, and does nothing without one', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(240_000)
  gitInit(env.workspaces.a)

  // nothing running: the trigger must not launch anything (the "disabled" half)
  await expect(page.locator('.w-empty')).toBeVisible({ timeout: 20_000 })
  await page.waitForFunction(
    () =>
      (window as unknown as { __koloftShortcutsReady?: boolean }).__koloftShortcutsReady === true,
    undefined,
    { timeout: 20_000 }
  )
  await sendShortcut(app, 'shortcut:restart-session')
  await page.waitForTimeout(3000)
  expect(readCalls(env)).toEqual([])

  // two running sessions; the SELECTED one is the target
  await startSessionIn(page, 'ws-a')
  await startSessionIn(page, 'ws-b')
  const calls = await waitForCalls(env, 2)
  const [sessA, sessB] = calls
  await wsRows(page, 'ws-a').first().click()
  await expect(page.locator('.ws-tab.active')).toHaveCount(1)

  await sendShortcut(app, 'shortcut:restart-session')
  const after = await waitForCalls(env, 3)
  const i = after[2].argv.indexOf('--resume')
  expect(after[2].argv[i + 1]).toBe(sessA.sessionId)
  // …and the session nobody selected was never in the blast radius
  expect(processAlive(sessB.pid)).toBe(true)
  await expect(page.locator('.ws-tab', { hasText: FAKE_SESSION_TITLE })).toHaveCount(2)
})

// T-MIG-08 (retargeted for NFR-06; §06 added the island key) — the OLDEST layout
// a user can still be carrying: a pre-D1 document that says `auxMode: 'terminal'`, holds
// that pane's own tab strip, and carries the former island's `globalTerminal` block.
// D12 used to normalize the mode to 'preview' on read; both the mode and the read-path
// normalization retired with `AuxMode`, so what this case now guards is what the v2→v3
// migration owes such a document — it is the shape WB-P03 does NOT exercise (that one
// feeds a POST-D1 v2 document, whose vocabulary is only browser/preview/null).
//
// Three things must survive it: the workspaces, the session's own entry, and the panel's
// usability. The dead terminal strip must NOT survive — `tabs` is the Workbench's key
// now, and a `{title:'zsh'}` entry is not a PersistedTab.
//
// The open half CHANGED with layout v4. Until then `'terminal'` projected to
// `open: true` ("the column was showing something"), and this case guarded that a
// whitelist of the two live modes did not silently collapse it. v4 reads every pre-v4
// open flag as the seeded value it was — v2 seeded `auxMode` from `aux.defaultMode` at
// every bind, exactly as v3 seeded `open` — so the former mode lands COLLAPSED like every
// other upgraded entry, and what this case now pins is that it lands there with its entry
// intact and expands into a working panel on the user's own gesture.
test('T-MIG-08: a pre-D1 layout (retired terminal mode + its strip) upgrades into a usable, collapsed panel', async ({
  env
}) => {
  test.setTimeout(180_000)
  gitInit(env.workspaces.a)

  const app1 = await launchApp(env)
  const page1 = await app1.firstWindow()
  await page1.waitForLoadState('domcontentloaded')
  let idA = ''
  try {
    await expect(page1.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
    await startSessionIn(page1, 'ws-a')
    idA = (await waitForCalls(env, 1))[0].sessionId
    await page1.waitForTimeout(1500)
  } finally {
    await app1.close().catch(() => {})
  }

  // hand-write the pre-D1 shape over the v3 document the run above left, exactly as an
  // older build wrote it: version 2, an `aux` block, and the former mode in both places
  const file = `${env.userData}/layout.json`
  const doc = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    workspaces: { path: string }[]
  }
  fs.writeFileSync(
    file,
    JSON.stringify(
      {
        version: 2,
        workspaces: doc.workspaces,
        aux: { defaultMode: 'terminal' },
        // §06: the former island's block, which such a document also carries. The
        // v2→v4 migration must stop carrying it forward — see the assertion below.
        globalTerminal: { visible: true, tabs: [{ title: 'zsh', cwd: env.workspaces.a }] },
        sessions: { [idA]: { auxMode: 'terminal', tabs: [{ title: 'zsh' }] } }
      },
      null,
      2
    )
  )

  const app2 = await launchApp(env)
  try {
    const page2 = await app2.firstWindow()
    await page2.waitForLoadState('domcontentloaded')
    const row = wsRows(page2, 'ws-a').first()
    await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })

    // the file is upgraded on the first read: v3 vocabulary, retired keys gone…
    await expect.poll(() => layoutOnDisk(env).version, { timeout: 30_000 }).toBe(4)
    const upgraded = layoutOnDisk(env)
    expect(upgraded).not.toHaveProperty('aux')
    // §06 — the island's key is DROPPED by the upgrade rather than carried into v4.
    // The rest of this case is what proves the drop is not the migration bailing out: the
    // workspaces and the session entry below survived the same read.
    expect(upgraded).not.toHaveProperty('globalTerminal')
    expect(typeof upgraded.workbench?.defaultOpen).toBe('boolean')
    // …the workspace list intact (NFR-06's headline: never degrade to the empty doc)…
    expect(upgraded.workspaces?.map((w) => w.path)).toEqual([env.workspaces.a, env.workspaces.b])
    // …the session still owned, the former mode landing COLLAPSED like every upgraded
    // entry (v4), and the aux Terminal's own strip gone rather than carried forward as a
    // dead structure
    const entry = sessionWorkbenchOnDisk(env, idA)
    expect(entry).not.toBeNull()
    expect(entry?.open).toBe(false)
    expect(entry?.tabs).toEqual([])

    // …and resuming that session brings NO panel with it — asserted with no gesture in
    // between, deliberately: the upgrade must not turn a seeded mode into an auto-open
    await row.click()
    await waitForCalls(env, 2)
    // the panel is attached to the resumed session (T-AUX-02b: the row leaving `cold`
    // lands earlier than the bind, and every panel gesture is inert until then)
    await waitPanelAttached(page2)
    await expect(workbenchPanel(page2)).toBeHidden()
    // …while the user's own ⇧⌘B expands a panel that works: the pinned `files` tab is
    // there (FR-02 — an upgraded session gets a real strip) and a file opens in it
    await auxIcon(page2, 'Workbench').click()
    await expect(workbenchPanel(page2)).toBeVisible({ timeout: 30_000 })
    await expect(page2.locator(WORKBENCH.tabFiles)).toHaveCount(1)

    await openInBrowse(page2, path.join(env.workspaces.a, 'NOTES.md'))
    await expect(page2.locator(WORKBENCH.readingTitle)).toHaveText('NOTES.md', {
      timeout: 30_000
    })
  } finally {
    await app2.close().catch(() => {})
  }
})
