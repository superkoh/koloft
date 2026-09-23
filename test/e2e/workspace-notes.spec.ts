import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  addRemoteWorkspace,
  killFakeRemote,
  launchWithRemote,
  REMOTE_WS_NAME,
  remoteKey,
  sshCommands
} from './helpers/remote'
import { seedSettings } from './helpers/env'
import {
  clickAppMenuItem,
  encodeCwd,
  focusOwner,
  notesIsland,
  notesOnDisk,
  notesPath,
  openMenu,
  processAlive,
  sendShortcut,
  settingsOnDisk,
  snap,
  startSessionIn,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'
import { layoutState } from './helpers/workbench'

// the workspace note: a second island in the left dock, under the sessions list,
// always holding the CURRENT workspace's note and saving itself as it is typed.
//
// Selector rule for this whole file: never match the bare word "notes" case-insensitively.
// ws-a's fixture carries `notes.xyz`, and the fake claude drops a NOTES.md into it, so a
// text match would find the wrong thing. Everything here goes through `.isl-notes`.

/** The note's own text box. */
const notesArea = (page: Page) => notesIsland(page).locator('.ed-area')

/** One workspace head in the sidebar — clicking its name PICKS the workspace (D7). */
const head = (page: Page, wsName: string) => page.locator('.ws-head', { hasText: wsName })

/** The island's border colour, and the accent it wears when it holds the caret. Same
 *  probe trick as `litIsland`: the accent is read out of the live stylesheet rather than
 *  written down here, so a palette change can never make this pass by accident. */
function notesBorder(page: Page): Promise<{ border: string; accent: string }> {
  return page.evaluate(() => {
    const flat = (c: string): string => c.replace(/\s+/g, '')
    const el = document.querySelector('.island.isl-notes') as HTMLElement | null
    const probe = document.createElement('div')
    probe.style.borderTopColor = 'var(--accent-line)'
    probe.style.display = 'none'
    document.body.appendChild(probe)
    const accent = flat(getComputedStyle(probe).borderTopColor)
    probe.remove()
    return { border: el ? flat(getComputedStyle(el).borderTopColor) : '', accent }
  })
}

/** Put the caret in the note through the product's own door (⌥⌘N). */
async function focusNotes(page: Page, app: Parameters<typeof sendShortcut>[0]): Promise<void> {
  await sendShortcut(app, 'shortcut:focus-notes')
  await expect(notesArea(page)).toBeFocused()
}

// N01 — the island is simply there on boot, under the sessions island, naming the
// workspace the welcome panel is already pointing at. The DOM order is the assertion
// carrying the "under, not above" half: both islands are visible either way round.
test('N01: the note island sits under the sessions island and names the current workspace', async ({
  page
}) => {
  test.setTimeout(120_000)
  await waitBooted(page)

  await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })
  await expect(notesIsland(page).locator('.wb-title')).toHaveText('Notes · ws-a')

  const order = await page.evaluate(() =>
    [...(document.querySelector('.dock-left')?.children ?? [])].map((el) => el.className)
  )
  expect(order).toEqual(['island flat isl-sessions', 'gutter-h', 'island isl-notes'])
  await snap(page, 'N01')
})

// N02 — the island follows the pick. A session is picked: its workspace is the group its
// row is listed under, so clicking rows in two different workspaces has to move the note
// with them.
test('N02: picking a session in another workspace moves the note to that workspace', async ({
  page
}) => {
  test.setTimeout(300_000)
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  await expect(notesIsland(page).locator('.wb-title')).toHaveText('Notes · ws-a')

  await startSessionIn(page, 'ws-b')
  await expect(notesIsland(page).locator('.wb-title')).toHaveText('Notes · ws-b')

  await wsRows(page, 'ws-a').first().click()
  await expect(notesIsland(page).locator('.wb-title')).toHaveText('Notes · ws-a')
  await snap(page, 'N02')
})

// N04 — ⌥⌘N is a toggle for the caret. The border assertion is the one that fails only
// when the ring rule forgot the new island: the focus itself can be right while the user
// still cannot see where the caret went.
test('N04: ⌥⌘N puts the caret in the note and lights the island, and again takes it out', async ({
  app,
  page
}) => {
  test.setTimeout(120_000)
  await waitBooted(page)
  await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })

  const dark = await notesBorder(page)
  expect(dark.border).not.toBe(dark.accent)

  await focusNotes(page, app)
  const lit = await notesBorder(page)
  expect(lit.border).toBe(lit.accent)

  await sendShortcut(app, 'shortcut:focus-notes')
  await expect(notesArea(page)).not.toBeFocused()
  await snap(page, 'N04')
})

// N05 — Esc leaves the note, and leaves the layout exactly as it was. Folding on Esc
// would be a second meaning for a key that already has one.
test('N05: Esc hands the caret back to the centre without folding the island', async ({
  app,
  page
}) => {
  test.setTimeout(120_000)
  await waitBooted(page)
  await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })
  await focusNotes(page, app)

  await page.keyboard.press('Escape')
  await expect(notesArea(page)).not.toBeFocused()
  // with no session picked the centre is the welcome panel, and that is where it goes
  expect(await focusOwner(page)).toBe('welcome')
  await expect(notesArea(page)).toBeVisible()
  await snap(page, 'N05')
})

// N06 — the note writes itself. No ⌘S, no Save button: typing is the whole gesture, and
// the strip is how the user learns it landed.
test('N06: typing in the note reaches the file on disk by itself', async ({ app, page, env }) => {
  test.setTimeout(120_000)
  await waitBooted(page)
  await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })
  await focusNotes(page, app)

  // the strip says "Saving…" for the 600 ms the buffer is waiting plus the write itself,
  // and that window closes on its own — so the wait is started BEFORE the typing rather
  // than looked for afterwards, when it may already be gone
  const sawSaving = page.waitForFunction(
    () => !!document.querySelector('.isl-notes .ed-saving'),
    null,
    { polling: 'raf', timeout: 20_000 }
  )
  await page.keyboard.type('hello koloft')
  await sawSaving
  await expect
    .poll(() => notesOnDisk(env, env.workspaces.a), { timeout: 5_000 })
    .toBe('hello koloft')
  // and it turns into the timestamp once the write lands — one strip, two states, never
  // both at once
  await expect(notesIsland(page).locator('.ed-saved')).toContainText('Saved')
  await expect(notesIsland(page).locator('.ed-saving')).toHaveCount(0)
  await snap(page, 'N06')
})

// N21 — Tab over prose writes two spaces instead of walking the focus out of the box, and
// those spaces are typing like any other: they reach the buffer and then the file. Nothing
// else covers the Tab → buffer → disk wiring, and the unit test one level down only knows
// where the caret should land.
test('N21: Tab in the note writes two spaces, which reach the file, and the caret stays put', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(120_000)
  await waitBooted(page)
  await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })
  await focusNotes(page, app)

  await page.keyboard.press('Tab')

  await expect.poll(() => notesOnDisk(env, env.workspaces.a), { timeout: 5_000 }).toBe('  ')
  // the half that fails when the key falls through to the browser: the focus would have
  // walked to the next control and the box would be empty
  await expect(notesArea(page)).toBeFocused()
  await expect(notesArea(page)).toHaveValue('  ')
  await snap(page, 'N21')
})

// N19 — removing a workspace unpins it and nothing more. D9: the note file lives under
// Koloft's own data folder, not in the workspace, and it is kept — so pinning the same
// folder again finds the note where it was left.
test('N19: removing a workspace keeps its note file', async ({ app, page, env }) => {
  test.setTimeout(180_000)
  await waitBooted(page)
  await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })

  await head(page, 'ws-b').locator('.ws-name').click()
  await expect(notesIsland(page).locator('.wb-title')).toHaveText('Notes · ws-b')
  await focusNotes(page, app)
  await page.keyboard.type('keep me')
  // saved first, so the removal has nothing unsaved to ask about: this case is about the
  // FILE, not about the guard (that one is BB-C31's)
  await expect.poll(() => notesOnDisk(env, env.workspaces.b), { timeout: 5_000 }).toBe('keep me')

  await openMenu(page, head(page, 'ws-b'))
  await page.locator('.menu .mi.danger', { hasText: 'Remove workspace' }).click()

  // the island moving is what says the removal went through — nothing is running in ws-b,
  // so there is no question to answer
  await expect(head(page, 'ws-b')).toHaveCount(0, { timeout: 20_000 })
  await expect(notesIsland(page).locator('.wb-title')).toHaveText('Notes · ws-a')
  expect(notesOnDisk(env, env.workspaces.b)).toBe('keep me')
  await snap(page, 'N19')
})

// N07 — quitting inside the note's own 600 ms window WRITES it. The guard used to raise
// the "unsaved files" question about text that was about to save itself, which is the
// worst of both: a dialog nobody asked for, over work that was never at risk.
//
// The app going down is the assertion carrying "no dialog appeared": main holds the quit
// while that question is up, so a build that asked would never reach the close event.
test('N07: closing the app right after typing writes the note instead of asking about it', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(120_000)
  await waitBooted(page)
  await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })
  await focusNotes(page, app)

  await page.keyboard.type('quit fast')
  // still inside the window — if this ever fails the case proves nothing, because the
  // ordinary autosave would have landed the text before the quit was even asked for
  expect(notesOnDisk(env, env.workspaces.a)).not.toBe('quit fast')

  const exited = app.waitForEvent('close', { timeout: 60_000 })
  await app.evaluate(({ app: electronApp }) => electronApp.quit())
  await exited

  // read after the app is gone, so nothing could still be in flight
  expect(notesOnDisk(env, env.workspaces.a)).toBe('quit fast')
})

// N09 — two workspaces, two notes, and nothing crossing between them. Coming back has to
// show what was left there: the buffer outlives the switch (B-30).
test('N09: each workspace keeps its own note, and switching back brings it straight back', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await waitBooted(page)
  await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })

  await focusNotes(page, app)
  await page.keyboard.type('alpha')

  await head(page, 'ws-b').locator('.ws-name').click()
  await expect(notesIsland(page).locator('.wb-title')).toHaveText('Notes · ws-b')
  await expect(notesArea(page)).toHaveValue('')
  await focusNotes(page, app)
  await page.keyboard.type('beta')

  await expect.poll(() => notesOnDisk(env, env.workspaces.a), { timeout: 5_000 }).toBe('alpha')
  await expect.poll(() => notesOnDisk(env, env.workspaces.b), { timeout: 5_000 }).toBe('beta')

  await head(page, 'ws-a').locator('.ws-name').click()
  await expect(notesIsland(page).locator('.wb-title')).toHaveText('Notes · ws-a')
  await expect(notesArea(page)).toHaveValue('alpha')
  await snap(page, 'N09')
})

// N10 — folded is a head band and nothing else, and it is remembered. The settings file
// is the assertion carrying the "remembered" half.
test('N10: the fold button leaves only the head band, and the choice is written down', async ({
  page,
  env
}) => {
  test.setTimeout(120_000)
  await waitBooted(page)
  await expect(notesArea(page)).toBeVisible({ timeout: 20_000 })

  await notesArea(page).click()
  await notesIsland(page).locator('.icobtn[aria-label="Fold"]').click()
  await expect(notesArea(page)).toHaveCount(0)
  await expect(notesIsland(page).locator('.wb-bar')).toBeVisible()
  // manual round: the gap between the two islands stays (as a plain spacer,
  // no grip), and folding hands the caret home — the folded band must not wear the ring
  await expect(page.locator('.gutter-h.idle')).toHaveCount(1)
  expect(await notesIsland(page).evaluate((el) => el.matches(':focus-within'))).toBe(false)
  expect(await focusOwner(page)).toBe('welcome')
  await expect.poll(() => settingsOnDisk(env).notesFolded, { timeout: 5_000 }).toBe(true)

  await notesIsland(page).locator('.icobtn[aria-label="Unfold"]').click()
  await expect(page.locator('.gutter-h.idle')).toHaveCount(0)
  await expect(notesArea(page)).toBeVisible()
  await expect.poll(() => settingsOnDisk(env).notesFolded, { timeout: 5_000 }).toBe(false)
  await snap(page, 'N10')
})

// N16 — Copy path hands the note's own file path over. `writeText` is stubbed on purpose:
// the real clipboard here is the DEVELOPER's clipboard, and this suite runs on the same
// Mac someone is working on (helpers/browser BB-C70 makes the same call).
test('N16: Copy path copies the note file’s path', async ({ page, env }) => {
  test.setTimeout(120_000)
  await waitBooted(page)
  await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })

  await page.evaluate(() => {
    const g = window as unknown as { __copied?: string }
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: (t: string) => {
          g.__copied = t
          return Promise.resolve()
        }
      }
    })
  })
  await notesIsland(page).locator('.icobtn[aria-label="Copy path"]').click()

  const copied = await page.evaluate(() => (window as unknown as { __copied?: string }).__copied)
  expect(copied).toBe(path.join(env.userData, 'notes', encodeCwd(env.workspaces.a), 'notes.md'))
  await expect(page.locator('.toast-msg')).toHaveText('Copied path')
  await snap(page, 'N16')
})

// N18 — no workspace, no note. The island is absent from the dock rather than sitting
// there empty: there is nothing for a note to belong to yet.
test('N18: with nothing pinned there is no note island at all', async ({ env }) => {
  test.setTimeout(120_000)
  fs.writeFileSync(
    path.join(env.userData, 'layout.json'),
    JSON.stringify({ version: 4, workspaces: [], workbench: { defaultOpen: true }, sessions: {} })
  )
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    // the onboarding panel is up, so the dock has finished rendering — and the island
    // still is not there
    await expect(page.locator('.w-empty')).toBeVisible({ timeout: 20_000 })
    await expect(notesIsland(page)).toHaveCount(0)
    await expect(page.locator('.gutter-h')).toHaveCount(0)
    await snap(page, 'N18')
  } finally {
    await app.close().catch(() => {})
  }
})

// N22 — the remembered height is a wish, and the window it comes back to is what grants
// it. A note dragged tall on a big display used to come back on a small window and squeeze
// the session list (which is `flex:1`) down to nothing, with no way back but another drag.
test('N22: a note height remembered from a bigger window never squeezes the session list away', async ({
  env
}) => {
  test.setTimeout(120_000)
  seedSettings(env, { notesHeight: 5000 })

  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })

    const box = await page.evaluate(() => {
      const h = (sel: string): number =>
        document.querySelector(sel)?.getBoundingClientRect().height ?? 0
      return {
        dock: h('.dock-left'),
        sessions: h('.island.isl-sessions'),
        notes: h('.island.isl-notes')
      }
    })
    // the session list keeps its own floor, and the note stops short of it plus the gutter
    expect(box.sessions).toBeGreaterThanOrEqual(160)
    expect(box.notes).toBeLessThanOrEqual(box.dock - 170)
    // …and the wish itself is untouched: a bigger window has to hand the chosen height back
    expect(settingsOnDisk(env).notesHeight).toBe(5000)
    await snap(page, 'N22')
  } finally {
    await app.close().catch(() => {})
  }
})

// N23 — the strip says ⌘S, so ⌘S has to write the file. The island is in the left dock,
// not in the Workbench, so the key only arrives here if App routes it by where the caret
// is; without that routing it lands nowhere and the note waits out its 600 ms instead.
test('N23: ⌘S in the note writes the file at once, ahead of the autosave', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(120_000)
  await waitBooted(page)
  await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })
  await focusNotes(page, app)

  await page.keyboard.type('saved by key')
  await sendShortcut(app, 'shortcut:save')
  // 400ms is the whole point of the case: the autosave is still 600ms away from the last
  // key, so nothing but the ⌘S routing can have put this on disk this early
  await expect
    .poll(() => notesOnDisk(env, env.workspaces.a), { timeout: 400, intervals: [20] })
    .toBe('saved by key')
  await expect(notesIsland(page).locator('.ed-saved')).toContainText('Saved')
  await snap(page, 'N23')
})

// N24 — folding unmounts the editor, and with it the watcher that follows the file. So the
// note has to be read again on the way back, or the box would keep showing text the file
// no longer holds — and the next keystroke's save would be refused over a change the user
// was never shown.
test('N24: unfolding the note shows what changed on disk while it was folded', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(120_000)
  await waitBooted(page)
  await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })
  await focusNotes(page, app)

  await page.keyboard.type('first')
  await expect.poll(() => notesOnDisk(env, env.workspaces.a), { timeout: 5_000 }).toBe('first')
  await expect(notesIsland(page).locator('.ed-saved')).toContainText('Saved')

  await notesIsland(page).locator('.icobtn[aria-label="Fold"]').click()
  await expect(notesArea(page)).toHaveCount(0)

  // exactly what Copy path hands over, written by anything at all — another editor, Claude
  fs.writeFileSync(notesPath(env, env.workspaces.a), 'from outside')

  await notesIsland(page).locator('.icobtn[aria-label="Unfold"]').click()
  await expect(notesArea(page)).toHaveValue('from outside')
  // nothing was unsaved, so the file simply wins — there is no question to answer
  await expect(notesIsland(page).locator('.ed-stale')).toHaveCount(0)
  await snap(page, 'N24')
})

// N25 — the same door, reached the other way: a workspace switch unmounts the editor too,
// so coming back has to read the file rather than trust the buffer it left behind.
test('N25: coming back from another workspace shows the note as the file now stands', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await waitBooted(page)
  await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })
  await focusNotes(page, app)

  await page.keyboard.type('mine')
  await expect.poll(() => notesOnDisk(env, env.workspaces.a), { timeout: 5_000 }).toBe('mine')

  await head(page, 'ws-b').locator('.ws-name').click()
  await expect(notesIsland(page).locator('.wb-title')).toHaveText('Notes · ws-b')

  fs.writeFileSync(notesPath(env, env.workspaces.a), 'changed elsewhere')

  await head(page, 'ws-a').locator('.ws-name').click()
  await expect(notesIsland(page).locator('.wb-title')).toHaveText('Notes · ws-a')
  await expect(notesArea(page)).toHaveValue('changed elsewhere')
  await expect(notesIsland(page).locator('.ed-stale')).toHaveCount(0)
  await snap(page, 'N25')
})

// N26 — Tab keeps the undo history. The box's own undo is the only way back from a
// mistyped key, and writing the two spaces the wrong way silently ends it: ⌘Z after that
// Tab does nothing, and neither does ⌘Z over anything typed BEFORE it. The assertion that
// fails in the broken build is the last one — the two spaces are still there.
test('N26: ⌘Z after a Tab takes the two spaces back', async ({ app, page }) => {
  test.setTimeout(120_000)
  await waitBooted(page)
  await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })
  await focusNotes(page, app)

  await page.keyboard.type('abc')
  await page.keyboard.press('Tab')
  await expect(notesArea(page)).toHaveValue('abc  ')

  await page.keyboard.press('Meta+z')
  await expect(notesArea(page)).not.toHaveValue(/ {2}$/)
  await snap(page, 'N26')
})

// N27 — ⌘W with the caret in the note. There is nothing in the note to close, so the key
// does nothing at all; without the guard it reaches past the note and closes the picked
// SESSION, which is a big thing to lose to a key pressed while typing a list.
test('N27: ⌘W while typing in the note leaves the session alone', async ({ app, page, env }) => {
  test.setTimeout(240_000)
  await startSessionIn(page, 'ws-a')
  const [session] = await waitForCalls(env, 1)
  const row = wsRows(page, 'ws-a').first()
  await focusNotes(page, app)

  await sendShortcut(app, 'shortcut:close-tab')

  // typing is what says the renderer took that key and did nothing with it: the caret is
  // still in the note, and the note is still on screen. It also buys the close a real
  // window to happen in — the autosave below waits 600 ms and a file write.
  await page.keyboard.type('still here')
  await expect(notesArea(page)).toHaveValue('still here')
  await expect.poll(() => notesOnDisk(env, env.workspaces.a), { timeout: 5_000 }).toBe('still here')

  // the two halves that fail when ⌘W reaches past the note: an idle session is killed
  // outright, and a working one raises the close question
  expect(processAlive(session.pid)).toBe(true)
  await expect(page.locator('.modal-backdrop')).toHaveCount(0)
  await expect(row).not.toHaveClass(/\bcold\b/)
  await snap(page, 'N27')
})

// N28 — Esc out of the note while the Workbench is full width (T3). The centre is
// `display:none` there, so handing the caret straight to it would hand it to a box nobody
// can see and the key would look dead. Coming home comes out of full width first.
test('N28: Esc in the note comes out of full-width Workbench and lands on the session', async ({
  app,
  page
}) => {
  test.setTimeout(240_000)
  await startSessionIn(page, 'ws-a')
  await expect.poll(() => layoutState(page), { timeout: 30_000 }).toBe('T2')

  await clickAppMenuItem(app, page, 'toggle-focus-mode')
  await expect.poll(() => layoutState(page), { timeout: 20_000 }).toBe('T3')
  // going full width takes the caret into the panel (R16), and it does that ONE FRAME
  // later — in a window that is never shown, that frame can be a long time coming. Waiting
  // for it here is what keeps the ⌥⌘N below from being undone by a late arrival.
  await expect.poll(() => focusOwner(page), { timeout: 20_000 }).toBe('panel')

  await focusNotes(page, app)
  await page.keyboard.press('Escape')

  await expect.poll(() => layoutState(page), { timeout: 20_000 }).toBe('T2')
  await expect(notesArea(page)).not.toBeFocused()
  await expect.poll(() => focusOwner(page), { timeout: 20_000 }).toBe('tui')
  await snap(page, 'N28')
})

// N29 — ⌥⌘N right after a click on the head band. Chromium leaves the focus ON the button
// that was clicked, so a test for "anywhere in the island" reads that as "already in the
// note" and the key goes the wrong way — out instead of in.
test('N29: ⌥⌘N after clicking Fold unfolds the note and puts the caret in it', async ({
  app,
  page
}) => {
  test.setTimeout(120_000)
  await waitBooted(page)
  await expect(notesIsland(page)).toBeVisible({ timeout: 20_000 })

  await notesIsland(page).locator('.icobtn[aria-label="Fold"]').click()
  await expect(notesArea(page)).toHaveCount(0)

  await sendShortcut(app, 'shortcut:focus-notes')

  await expect(notesArea(page)).toBeVisible({ timeout: 20_000 })
  await expect(notesArea(page)).toBeFocused()
  await snap(page, 'N29')
})

// E-RW-10 — a remote workspace's note is an ordinary local note. The workspace
// lives on another machine, but the note is the user's own thinking about it: it stays
// on this Mac, keyed by the `ssh://` string like any other path, and nothing about it
// ever goes over the wire.
test('E-RW-10: a remote workspace’s note saves locally and sends nothing over ssh', async ({
  env
}) => {
  test.setTimeout(240_000)
  const { app, page } = await launchWithRemote(env)
  try {
    await addRemoteWorkspace(page, env)
    await page.locator('.ws-head', { hasText: REMOTE_WS_NAME }).click()
    await expect(notesIsland(page)).toContainText(REMOTE_WS_NAME, { timeout: 20_000 })

    await focusNotes(page, app)
    await page.keyboard.type('build machine todo')

    await expect
      .poll(() => notesOnDisk(env, remoteKey(env)), { timeout: 20_000 })
      .toBe('build machine todo')
    expect(notesPath(env, remoteKey(env)).startsWith(env.userData)).toBe(true)

    // the note never left this machine: no ssh call mentions it, in any form
    for (const cmd of sshCommands(env)) {
      expect(cmd).not.toContain('notes')
      expect(cmd).not.toContain('build machine todo')
    }
  } finally {
    await quitAndClose(app)
    killFakeRemote(env)
  }
})
