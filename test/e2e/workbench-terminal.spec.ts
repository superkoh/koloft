import fs from 'fs'
import path from 'path'
import { test, expect, launchApp } from './helpers/app'
import type { ElectronApplication, Page } from '@playwright/test'
import type { E2EEnv } from './helpers/env'
import {
  centerTerm,
  clickAppMenuItem,
  focusOwner,
  gitInit,
  layoutOnDisk,
  openMenu,
  openSessionTerminal,
  openWorktreeSession,
  panelShellPid,
  panelTerm,
  processAlive,
  readCalls,
  runIn,
  seedGlobalTerm,
  seedJsonl,
  sendShortcut,
  startSessionIn,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'
import {
  WORKBENCH,
  artifactBody,
  openFileTab,
  persistedTabsOnDisk,
  waitPanelAttached,
  wbActiveTab,
  wbTabTitles,
  wbTabs,
  workbenchPanel
} from './helpers/workbench'

/**
 * Workbench · terminal tabs (*) §04/§08).
 *
 * The subject is the move: the shell stopped being ONE global island across the bottom of
 * the window and became a fourth kind of Workbench tab, one per shell, owned by a
 * conversation tab. Everything that used to be true "because the island belonged to no
 * session" flips here — a shell now needs a live session to exist at all (D1), dies with
 * it (D2), never comes back after a restart (D4), and rides through `/clear`, `/resume`
 * and ⇧⌘R untouched because the panel follows the CONVERSATION TAB rather than the Claude
 * session id (D8).
 *
 * The retired global-terminal spec's cases live on here by id where the contract merely
 * flipped: T-GT-01/02/08/09/10 rewritten, T-GT-03/12 folded into one, T-LIFE-05 /
 * T-REL-04 / WB-L05 / BB-C33 (813)'s terminal halves absorbed.
 *
 * Every case drives a product entry point: the session starts from the sidebar, the
 * shell from ⌃`'s own menu IPC (`helpers/p1.ts openSessionTerminal`), and nothing here
 * imports from src/.
 */

/** FR-02's pinned tab is always the strip's first label, so it is in every expectation. */
const FILES_LABEL = 'Files'

/** A shell's first title (R19), and therefore the terminal tab's first label. */
const SHELL_TITLE = 'zsh'

/** The mounted terminal BODIES — one per shell, all of them resident (R8), only the
 *  active one visible. The count is the honest "how many shells does this tab own". */
function termBodies(page: Page): ReturnType<Page['locator']> {
  return page.locator(`${WORKBENCH.panel} .wb-term`)
}

/** Is the keyboard focus inside the visible shell's own input layer? xterm's caret is a
 *  hidden <textarea>, so "the panel is focused" is not the same claim (R5/R15). */
function focusInShell(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null
    return !!el && el.tagName === 'TEXTAREA' && el.closest('.wb-term') !== null
  })
}

/** ⌘T — no menu accelerator owns it (menu.ts leaves the key free), so it is a real
 *  renderer keydown caught in App's capture-phase listener. */
async function newTabKey(page: Page): Promise<void> {
  await page.keyboard.press('Meta+t')
}

/** ⌘W travels the menu's `close-tab` accelerator, arbitrated in the renderer by focus. */
async function closeTabKey(app: ElectronApplication): Promise<void> {
  await sendShortcut(app, 'shortcut:close-tab')
}

/**
 * A command typed into a shell needs Koloft's own shim dir and the fake `open` ahead of
 * /usr/bin, exactly as open-intercept.spec pins it by hand: a pty is a login shell and
 * macOS's path_helper would otherwise hoist the REAL /usr/bin/open and launch an app on
 * the machine running the suite.
 */
function withOpenPath(env: E2EEnv, cmd: string): string {
  return `export PATH="${env.shimDir}:${env.fakeBin}:$PATH"; hash -r; ${cmd}`
}

/** Given: one live session in ws-a with one terminal tab open in it. */
async function sessionWithShell(app: ElectronApplication, page: Page, ws: string): Promise<void> {
  await startSessionIn(page, ws)
  await openSessionTerminal(app, page)
}

// ---- opening one (T-GT-01/02 rewritten) ----------------------------------------------

// T-WT-01 (D3/R4/R5, was T-GT-01) — ⌃` on a live session: the panel comes up, a terminal
// tab lands rightmost with the shell's first title, the caret is IN the shell, and the
// shell is standing in the conversation tab's own root directory. Then ⌘T from inside it
// opens a second one (R6).
//
// The `$PWD` echo is the assertion carrying the case: everything above it passes just as
// happily on a shell spawned in the wrong directory — which is exactly what the former
// island did (its cwd was the "current workspace", a concept D1 deleted).
test('T-WT-01: ⌃` opens a terminal tab in the session’s own directory, focused; ⌘T opens a second', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(240_000)
  await startSessionIn(page, 'ws-a')

  // start COLLAPSED, so "⌃` expands the panel on the way" is observable at all
  await clickAppMenuItem(app, page, 'toggle-browser')
  await expect(workbenchPanel(page)).toBeHidden()

  await openSessionTerminal(app, page)

  await expect(workbenchPanel(page)).toBeVisible()
  await expect(termBodies(page)).toHaveCount(1)
  await expect(page.locator(`${WORKBENCH.panel}[data-kind="terminal"]`)).toHaveCount(1)
  // rightmost, after the pinned Files tab, titled `zsh` (R2/R19)
  expect(await wbTabTitles(page)).toEqual([FILES_LABEL, SHELL_TITLE])
  await expect(wbActiveTab(page)).toHaveText(SHELL_TITLE)
  expect(await focusInShell(page)).toBe(true)

  // …and it really is standing in this session's root
  await runIn(page, panelTerm(page), `[ "$PWD" = '${env.workspaces.a}' ] && echo WT01_CWD_OK`)
  await expect(panelTerm(page)).toContainText('WT01_CWD_OK', { timeout: 25_000 })
  // the kind bar names that directory too (R19)
  await expect(page.locator(WORKBENCH.artifactTitle)).toContainText(path.basename(env.workspaces.a))

  // ⌘T from inside the shell: a second terminal tab, selected, and the first one stays
  await panelTerm(page).click()
  await newTabKey(page)
  await expect(termBodies(page)).toHaveCount(2, { timeout: 40_000 })
  expect(await wbTabTitles(page)).toEqual([FILES_LABEL, SHELL_TITLE, SHELL_TITLE])
})

// T-WT-02 (R4) — the same opening, on a WORKTREE session. The directory is the whole
// case: a worktree session's root is the checkout under `.claude/worktrees/`, never the
// repo it was launched from, and the launch cwd is the repo root — so a shell that
// inherited the launch cwd would look perfectly healthy and be in the wrong tree.
//
// Launched by hand rather than through the `app` fixture: C8's fly-out item only offers
// itself for a workspace the sidebar already knows is a git repo, so the `git init` has
// to be on disk BEFORE the app reads its workspaces (pattern: aggregate.spec T-AGG-07).
test('T-WT-02: a worktree session’s terminal starts in the worktree, not the repo root', async ({
  env
}) => {
  test.setTimeout(240_000)
  gitInit(env.workspaces.a)

  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitBooted(page)

    // C8 is the product's `claude -w`: name a worktree that does not exist and ⏎
    const dlg = await openWorktreeSession(page, 'ws-a')
    await dlg.getByRole('textbox').click()
    await page.keyboard.type('wt197')
    await page.keyboard.press('Enter')
    await expect(dlg).toHaveCount(0)
    const [call] = await waitForCalls(env, 1)
    const wtDir = fs.realpathSync(path.join(env.workspaces.a, '.claude', 'worktrees', 'wt197'))
    expect(call.effectiveCwd).toBe(wtDir)
    expect(call.cwd).toBe(env.workspaces.a) // the launch cwd is the repo root, not the tree
    await expect(page.locator('.ws-tab.st-pending')).toHaveCount(0, { timeout: 60_000 })

    await openSessionTerminal(app, page)

    // the carrying assertion: the shell's own answer, not the app's claim about it
    await runIn(page, panelTerm(page), `[ "$PWD" = '${wtDir}' ] && echo WT02_CWD_OK`)
    await expect(panelTerm(page)).toContainText('WT02_CWD_OK', { timeout: 25_000 })
  } finally {
    await app.close().catch(() => {})
  }
})

// ---- closing one (T-GT-02/09 rewritten) ----------------------------------------------

// T-WT-03 (R6, was T-GT-02/T-GT-09) — ⌘W with the caret in a shell kills THAT shell and
// nothing else: no confirmation dialog (a shell is not a session), the session behind it
// keeps running, and the strip lands on the right neighbour → left neighbour → Files.
//
// The pid going dead is what carries the first half: a build that merely dropped the tab
// would leave an orphan zsh running forever, invisible, and every DOM assertion here
// would still be green.
test('T-WT-03: ⌘W in a shell kills only that shell and lands on the neighbour, then Files', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(300_000)
  await startSessionIn(page, 'ws-a')
  const [session] = await waitForCalls(env, 1)
  const row = wsRows(page, 'ws-a').first()

  // a web tab to the LEFT of the terminal (terminals are always rightmost, R2)
  await runIn(page, centerTerm(page), '/open http://127.0.0.1:1/neighbour')
  await expect(wbTabs(page)).toHaveCount(2, { timeout: 30_000 })
  await openSessionTerminal(app, page)
  const pid = await panelShellPid(page, 'WT03')
  expect(processAlive(pid)).toBe(true)

  await panelTerm(page).click()
  await closeTabKey(app)

  // the shell is really gone, and its tab with it
  await expect.poll(() => processAlive(pid), { timeout: 30_000 }).toBe(false)
  await expect(termBodies(page)).toHaveCount(0, { timeout: 20_000 })
  // …nothing asked the user anything, and the session never noticed
  await page.waitForTimeout(1500)
  await expect(page.locator('.modal')).toHaveCount(0)
  expect(processAlive(session.pid)).toBe(true)
  await expect(row).not.toHaveClass(/\bcold\b/)
  await expect(centerTerm(page)).toBeVisible()
  // no right neighbour existed, so the strip fell LEFT — onto the web tab
  await expect(wbActiveTab(page)).toHaveText(/neighbour/)

  // …and with nothing but Files beside it, closing the shell lands on Files
  await openSessionTerminal(app, page)
  await page
    .locator(`${WORKBENCH.panel} .wb-tab`, { hasText: /neighbour/ })
    .locator(WORKBENCH.tabCloseIn)
    .click()
  await expect(wbTabs(page)).toHaveCount(2, { timeout: 20_000 })
  await panelTerm(page).click()
  await closeTabKey(app)
  await expect(wbTabs(page)).toHaveCount(1, { timeout: 20_000 })
  await expect(wbActiveTab(page)).toHaveClass(/pinned/)

  // …and closing a shell hands the caret BACK TO THE PANEL, so the next ⌘W lands there too.
  //
  // Two ⌘W in a row with NO click in between is the whole point. Every close above
  // re-clicked the terminal first, which quietly supplies the focus the product is
  // supposed to be restoring — a build that dropped the caret on the floor (or left it on
  // a element that just unmounted) passes all of them. Here the second ⌘W has nothing but
  // the product's own focus handling to travel on: if it goes nowhere, the second shell
  // survives; if it reaches the WINDOW instead of the panel, ⌘W means "close the session"
  // and the confirm dialog or a dead row is what shows up.
  await openSessionTerminal(app, page)
  await openSessionTerminal(app, page)
  await expect(termBodies(page)).toHaveCount(2, { timeout: 20_000 })
  await panelTerm(page).click()

  await closeTabKey(app)
  await expect(termBodies(page)).toHaveCount(1, { timeout: 20_000 })
  expect(await focusOwner(page)).toBe('panel')

  await closeTabKey(app)
  await expect(termBodies(page)).toHaveCount(0, { timeout: 20_000 })
  // the session is untouched by either press: no dialog, no cold row
  await expect(page.locator('.modal')).toHaveCount(0)
  expect(processAlive(session.pid)).toBe(true)
  await expect(row).not.toHaveClass(/\bcold\b/)
})

// T-WT-04 (R7, was T-GT-10) — a shell that exits on its own is the same event as closing
// its tab: `exit` removes the tab and takes nothing else with it. The retired island
// collapsed itself and persisted `visible:false`; there is no island and nothing is
// persisted (D4), so the tab count is the whole contract.
test('T-WT-04: `exit` in a shell removes its terminal tab and leaves the session alone', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(240_000)
  await sessionWithShell(app, page, 'ws-a')
  const [session] = await waitForCalls(env, 1)
  await expect(termBodies(page)).toHaveCount(1)

  await runIn(page, panelTerm(page), 'exit')

  await expect(termBodies(page)).toHaveCount(0, { timeout: 30_000 })
  expect(await wbTabTitles(page)).toEqual([FILES_LABEL])
  expect(processAlive(session.pid)).toBe(true)
  await expect(centerTerm(page)).toBeVisible()
})

// T-WT-04b (R7 + FR-19) — `exit` promotes a NEIGHBOUR, and a promotion has to do
// everything a click would have done for that tab.
//
// FR-19's promotion deliberately bypasses `activate`, so each side effect a click performs
// has to be repeated by hand on the close path. A shell leaving by `exit` is the one close
// the STORE starts rather than the user, and the side effects are easy to attach to the
// user's ✕ alone: the promoted tab then comes up half-built and nothing says so.
//
// The neighbour must never have been VISITED, or there is nothing to observe — a visited
// `file` tab keeps a resident artifact node and renders no matter how it was promoted. An
// agent open cannot supply that shape (FR-14: an agent's file open mints no tab at all), so
// the unvisited tab comes from the other route the product has for one: a RESTART restores
// the strip from disk with nothing visited and nothing active but Files.
//
// `artifactBody` is the assertion carrying the case. The tab going active is true in the
// broken state too — the kind bar shows the path over an empty body, which is FR-51's
// "present but unobservable" again, and a title check would sail straight past it.
test('T-WT-04b: `exit` promotes a restored file tab with its body and the caret, not just its title', async ({
  env
}) => {
  test.setTimeout(420_000)
  const doc = path.join(env.workspaces.a, 'wt04b.md')
  fs.writeFileSync(doc, '# WT04B\n\nbody of the restored tab\n')

  // run one: a `file` tab that persists
  const app1 = await launchApp(env)
  try {
    const page1 = await app1.firstWindow()
    await page1.waitForLoadState('domcontentloaded')
    await expect(page1.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
    await startSessionIn(page1, 'ws-a')
    const [call] = await waitForCalls(env, 1)
    await openFileTab(page1, env, doc)
    await expect
      .poll(() => persistedTabsOnDisk(env, call.sessionId).length, { timeout: 30_000 })
      .toBe(1)
  } finally {
    await app1.close().catch(() => {})
  }

  // run two: the tab comes back UNVISITED, and Files is what is active (WB-P01 — `activeId`
  // is deliberately not persisted), which is exactly the state the promotion has to handle
  const app2 = await launchApp(env)
  try {
    const page2 = await app2.firstWindow()
    await page2.waitForLoadState('domcontentloaded')
    const row = wsRows(page2, 'ws-a').first()
    await expect(row).toHaveClass(/\bcold\b/, { timeout: 60_000 })
    await row.click()
    await waitPanelAttached(page2)
    await expect(wbTabs(page2)).toHaveCount(2, { timeout: 30_000 })
    await expect(wbActiveTab(page2)).toHaveClass(/pinned/)
    // nothing is mounted for it yet — the Given the promotion is measured against
    await expect(artifactBody(page2)).toHaveCount(0)

    // the shell goes on the right of it (terminals are always rightmost, R2) and takes the
    // caret; with no right neighbour the strip falls LEFT onto the restored file tab
    await openSessionTerminal(app2, page2)
    await panelTerm(page2).click()
    await runIn(page2, panelTerm(page2), 'exit')
    await expect(termBodies(page2)).toHaveCount(0, { timeout: 30_000 })

    // (a) it is active AND rendered — the carrying assertion
    await expect(wbActiveTab(page2)).toHaveText(/wt04b/i, { timeout: 20_000 })
    await expect(artifactBody(page2)).toHaveCount(1, { timeout: 20_000 })
    // (b) the caret went with it rather than falling on the floor when the shell unmounted
    expect(await focusOwner(page2)).toBe('panel')
    // (c) …so the next ⌘W is the PANEL's and closes that tab, never the session's
    await sendShortcut(app2, 'shortcut:close-tab')
    await expect(wbTabs(page2)).toHaveCount(1, { timeout: 20_000 })
    await expect(page2.locator('.modal')).toHaveCount(0)
    await expect(row).not.toHaveClass(/\bcold\b/)
  } finally {
    await app2.close().catch(() => {})
  }
})

// ---- what a shell is, and is not (T-BLK-05 rewritten) --------------------------------

// T-WT-05 (R3, was T-BLK-05) — the real shim, in a real terminal-tab pty, turning a real
// interactive `claude` away. The wording moved with the surface (it is a Koloft terminal
// now, not a "global utility terminal"), so only the load-bearing half of the sentence is
// pinned; what the case actually guards is that no second claude was ever exec'd.
//
// `readCalls` staying at one is the assertion carrying the case: a banner printed AFTER
// an exec would look identical on screen and would have burned an account slot.
test('T-WT-05: an interactive claude in a terminal tab is refused, and `-p` still runs', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(240_000)
  await sessionWithShell(app, page, 'ws-a')
  await waitForCalls(env, 1)

  await runIn(page, panelTerm(page), 'claude')
  await expect(panelTerm(page)).toContainText('Koloft terminal', { timeout: 25_000 })
  await expect(panelTerm(page)).toContainText('not an agent surface')
  expect(readCalls(env)).toHaveLength(1) // blocked BEFORE the exec

  // the shell itself is untouched…
  await runIn(page, panelTerm(page), 'echo WT05_$((6 * 7))')
  await expect(panelTerm(page)).toContainText('WT05_42', { timeout: 20_000 })
  // …and the allow-list really lets a print-mode call reach the binary
  await runIn(page, panelTerm(page), 'claude -p "x"')
  const calls = await waitForCalls(env, 2)
  expect(calls[1].argv).toContain('-p')
})

// T-WT-06 (R6/R17) — Esc belongs to the shell, judged by where the caret is rather than
// by which KIND of tab is active: a terminal tab with the panel's find bar or ＋ menu
// open must still be able to close those with Esc, which is why the ladder cannot simply
// step aside for the whole kind.
//
// `read -sk1` parks zsh waiting for exactly one raw key; `printf '%d' "'$k"` prints its
// code. 27 is Esc, and only a key that really reached the pty can produce it.
test('T-WT-06: Esc pressed in a shell reaches the shell, not the panel’s Esc ladder', async ({
  app,
  page
}) => {
  test.setTimeout(240_000)
  await sessionWithShell(app, page, 'ws-a')

  // `read` has to be WAITING before Esc is pressed, or the key lands on the prompt and the
  // case fails for a reason that has nothing to do with the Esc ladder. The shell says so
  // itself: `echo READY` runs first, and its output on screen is the signal that the
  // command line was accepted and `read` is now the thing holding the pty.
  await runIn(page, panelTerm(page), `echo WT06_READY; read -sk1 k; printf 'GOT_%d\\n' "'$k"`)
  await expect(panelTerm(page)).toContainText('WT06_READY', { timeout: 25_000 })
  await panelTerm(page).click()
  await page.keyboard.press('Escape')

  await expect(panelTerm(page)).toContainText('GOT_27', { timeout: 25_000 })
  // the ladder never ran: the panel is still open with its terminal tab
  await expect(workbenchPanel(page)).toBeVisible()
  await expect(termBodies(page)).toHaveCount(1)
})

// ---- the New Terminal Tab gate (T-GT-08 / T-AUX-01 / BB-C33:813 / WB-L05, four flipped into one) --

// T-WT-07 (D1/D2/R5) — ⌃`, View ▸ New Terminal Tab and the strip's ＋ share ONE gate, and
// it is closed in exactly the three states where a shell has nowhere to live: no session
// selected, a session still binding, and a session whose claude has exited. The retired
// island belonged to no session and its icon was NEVER disabled — this case is that
// sentence inverted, which is why it replaces four of the old ones at once. (The titlebar
// Terminal icon that used to carry the gate is gone; the menu item's own `enabled` flag is
// the observable now — a native accelerator cannot gate on renderer state, so main is
// told separately and the flag is exactly what a stale report would get wrong.)
test('T-WT-07: New Terminal Tab is greyed with no session, while pending and when cold, live in between', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(300_000)
  const itemEnabled = (): Promise<boolean | undefined> =>
    app.evaluate(
      ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('new-terminal-tab')?.enabled
    )

  // ① the welcome page: nothing selected, nothing to open a shell in (D1)
  await expect(page.locator('.w-empty')).toBeVisible({ timeout: 20_000 })
  await expect.poll(itemEnabled).toBe(false)

  // ② a session that has launched but not bound yet — widen that window so it is
  // observable at all, and start the session by hand (startSessionIn waits past it)
  fs.writeFileSync(env.claudeDelayFile, '4000')
  await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
  await page.locator('.menu .mi', { hasText: 'New session' }).click()
  await expect(page.locator('.ws-tab.st-pending')).toHaveCount(1, { timeout: 30_000 })
  expect(await itemEnabled()).toBe(false)

  // ③ bound and live: the menu item opens one terminal tab
  fs.rmSync(env.claudeDelayFile, { force: true })
  await expect(page.locator('.ws-tab.st-pending')).toHaveCount(0, { timeout: 60_000 })
  const [session] = await waitForCalls(env, 1)
  await expect.poll(itemEnabled, { timeout: 30_000 }).toBe(true)
  await clickAppMenuItem(app, page, 'new-terminal-tab')
  await expect(termBodies(page)).toHaveCount(1, { timeout: 40_000 })
  await expect(panelTerm(page)).toBeVisible({ timeout: 40_000 })

  // ④ the session dies: the gate closes again (D2 — a cold session owns no shells)
  process.kill(session.pid, 'SIGKILL')
  await expect(wsRows(page, 'ws-a').first()).toHaveClass(/\bcold\b/, { timeout: 40_000 })
  await expect.poll(itemEnabled, { timeout: 20_000 }).toBe(false)
})

// ---- one shell per conversation tab (R8/R9/R12) --------------------------------------

// T-WT-08 (R8) — switching away and back must not cost the shell its scrollback. The
// terminal body stays MOUNTED and merely `visibility:hidden` for exactly this reason:
// main keeps no scrollback of its own, so an unmount loses it silently — the tab comes
// back looking perfectly fine, just empty.
test('T-WT-08: a shell keeps its output across a switch to another session and back', async ({
  app,
  page
}) => {
  test.setTimeout(300_000)
  await sessionWithShell(app, page, 'ws-a')
  await runIn(page, panelTerm(page), 'echo WT08_KEEPS_5511')
  await expect(panelTerm(page)).toContainText('WT08_KEEPS_5511', { timeout: 25_000 })
  const pid = await panelShellPid(page, 'WT08PID')

  // A second session takes the screen — its own panel owns no terminal, so nothing is
  // SHOWN. `panelTerm`, not `termBodies`: R8 keeps every live conversation tab's shells
  // mounted and merely `visibility:hidden`, which is the whole mechanism this case is
  // about — A's body is still in the DOM here, and counting bodies would assert the
  // opposite of the rule.
  await startSessionIn(page, 'ws-b')
  await expect(panelTerm(page)).toHaveCount(0, { timeout: 20_000 })
  expect(processAlive(pid)).toBe(true)

  await wsRows(page, 'ws-a').first().click()

  await expect(panelTerm(page)).toHaveCount(1, { timeout: 20_000 })
  await expect(panelTerm(page)).toContainText('WT08_KEEPS_5511', { timeout: 25_000 })
  // …and coming back did NOT put the caret in the shell. Only ⌃`, ⌘T and ⇧⌘B are supposed
  // to move it there (R5/R15); a session switch is none of those, and the user's next
  // keystroke belongs to claude. The failure mode is a focus signal that fires on the
  // terminal body becoming visible again rather than on the gesture that asked for it.
  // Polled: the TUI takes the caret when its xterm is displayed, which since the
  // two-phase switch (tab-switch.spec.ts) is a couple of frames after the click.
  await expect.poll(() => focusOwner(page)).toBe('tui')
  // …and it is the SAME shell, still taking input
  await runIn(page, panelTerm(page), 'echo WT08_STILL_$$')
  await expect(panelTerm(page)).toContainText(`WT08_STILL_${pid}`, { timeout: 25_000 })
})

// T-WT-09 (R12, was open-intercept case 4) — `open x.md` typed into a shell is a USER
// action, and it lands in the Files of the conversation tab that shell belongs to. The
// `sleep 3` plus the switch is what makes the landing observable: the request arrives
// while a DIFFERENT session is on screen, so a build that dropped it into "whatever is
// active" would put the file in front of the wrong conversation.
test('T-WT-09: `open` from a shell lands in ITS OWN session’s Files, after a switch away', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(300_000)
  await sessionWithShell(app, page, 'ws-a')

  await runIn(
    page,
    panelTerm(page),
    withOpenPath(env, `cd '${env.workspaces.a}'; sleep 3; open README.md`)
  )
  // move the screen to another session INSIDE the sleep window
  await startSessionIn(page, 'ws-b')

  // the carrying assertion: session A came back to the front, carrying the file
  await expect(wsRows(page, 'ws-a').first()).toHaveClass(/\bactive\b/, { timeout: 45_000 })
  await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('README.md', { timeout: 30_000 })
  await expect(page.locator(WORKBENCH.readingBody)).toContainText('koloft-e2e-alpha')
  expect(fs.existsSync(env.openCalls)).toBe(false) // nothing left Koloft for the OS
})

// T-WT-10 (D2/R9, was T-LIFE-05's island half, flipped) — a session going cold takes its
// shells with it. T-LIFE-05 pinned the opposite ("nothing about the cold transition
// reaches the island") because the island belonged to no session; the shell is the
// session's helper now, so the SIGKILL has to reach it.
//
// `processAlive` is the assertion carrying the case: dropping the tab while leaking the
// zsh is the failure mode a DOM-only oracle cannot see.
test('T-WT-10: claude dying kills the session’s shells and drops their tabs', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(300_000)
  await sessionWithShell(app, page, 'ws-a')
  const [session] = await waitForCalls(env, 1)
  const pid = await panelShellPid(page, 'WT10')
  expect(processAlive(pid)).toBe(true)

  // SIGKILL fires no SessionEnd — only the liveness probe sees this go cold
  process.kill(session.pid, 'SIGKILL')
  await expect(wsRows(page, 'ws-a').first()).toHaveClass(/\bcold\b/, { timeout: 40_000 })

  await expect.poll(() => processAlive(pid), { timeout: 40_000 }).toBe(false)
  await expect(termBodies(page)).toHaveCount(0, { timeout: 20_000 })
})

// ---- nothing survives a reload or a restart (D4) --------------------------------------

// T-WT-11 (D4, was T-REL-04, flipped) — a reload kills the shell and brings nothing back.
// T-REL-04 pinned "the island respawns and the old shell is killed"; half of that stands
// (no leaked zsh), the respawn half is gone: terminal tabs are not layout data any more.
test('T-WT-11: a reload kills the shell and restores no terminal tab', async ({ app, page }) => {
  test.setTimeout(240_000)
  await sessionWithShell(app, page, 'ws-a')
  const pid = await panelShellPid(page, 'WT11')
  expect(processAlive(pid)).toBe(true)

  await page.reload()
  await waitBooted(page)

  await expect.poll(() => processAlive(pid), { timeout: 40_000 }).toBe(false)
  // …and nothing came back in its place, once the panel is up again for the adopted tab
  await expect(workbenchPanel(page)).toBeVisible({ timeout: 40_000 })
  await expect(termBodies(page)).toHaveCount(0)
  await expect(page.locator(`${WORKBENCH.panel} .wb-tab`, { hasText: SHELL_TITLE })).toHaveCount(0)
})

// T-WT-12 (D4 + §06, was T-GT-03 / T-GT-12, both flipped into one) — across a real app
// restart there are no terminal tabs, and the former island's `globalTerminal` key is
// never written again. A layout.json seeded with the old key is the input: reading it
// must ignore it, and the NEXT panel write must leave it out of the document.
//
// The web tab is not decoration — it is what forces one panel save. Asserting the key's
// absence without it would pass on a build that never wrote layout.json at all.
test('T-WT-12: a restart brings back no terminal tab, and the old globalTerminal key is dropped', async ({
  env
}) => {
  test.setTimeout(300_000)
  seedGlobalTerm(env, {
    visible: true,
    tabs: [{ title: 'zsh', cwd: env.workspaces.a }]
  })
  expect(layoutOnDisk(env).globalTerminal).toBeTruthy() // the Given really is on disk

  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitBooted(page)
    // nothing came back: no shell body anywhere in the window, and nothing visible
    await expect(page.locator('.wb-term')).toHaveCount(0)
    await expect(panelTerm(page)).toHaveCount(0)

    await startSessionIn(page, 'ws-a')
    const [session] = await waitForCalls(env, 1)
    await expect(termBodies(page)).toHaveCount(0)

    // one web tab → one panel write (debounced in main)
    await runIn(page, centerTerm(page), '/open http://127.0.0.1:1/wt12')
    await expect(wbTabs(page)).toHaveCount(2, { timeout: 30_000 })
    await expect
      .poll(() => persistedTabsOnDisk(env, session.sessionId).length, { timeout: 30_000 })
      .toBe(1)

    // …and the document that write produced has no island key left in it
    expect(layoutOnDisk(env).globalTerminal).toBeUndefined()
  } finally {
    await app.close().catch(() => {})
  }
})

// ---- the cap (R2) ----------------------------------------------------------------------

// T-WT-13 (R2) — eight shells per conversation tab, and the ninth is REFUSED rather than
// evicting the least-recently-used one: an eviction would silently kill a shell that may
// be running something. Both halves are asserted, because a build that simply ignored the
// ninth request would pass the count check alone.
test('T-WT-13: the ninth terminal is refused with a notice and the eight already open survive', async ({
  app,
  page
}) => {
  test.setTimeout(420_000)
  await startSessionIn(page, 'ws-a')

  for (let i = 0; i < 8; i++) await openSessionTerminal(app, page)
  await expect(termBodies(page)).toHaveCount(8)

  await sendShortcut(app, 'shortcut:new-terminal-tab')

  await expect(page.locator('.toast')).toContainText(
    'Terminal limit reached: at most 8 per session',
    {
      timeout: 20_000
    }
  )
  await expect(termBodies(page)).toHaveCount(8)
  await expect(wbTabs(page)).toHaveCount(9) // the pinned Files tab plus eight shells
})

// ---- D8: the panel follows the conversation tab, so the shell never moves --------------

// T-WT-14 (D8/R10) — `/clear` swaps the Claude session id underneath the tab. The panel
// hangs off the TAB now, so nothing about that reaches the shell: same pid, same tab,
// same output. (BB-C40 owns the web half of the same row; the strip and the on-disk move
// are asserted there.)
test('T-WT-14: /clear leaves the shell running, with its tab and its output', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(300_000)
  await sessionWithShell(app, page, 'ws-a')
  const [call] = await waitForCalls(env, 1)
  await runIn(page, panelTerm(page), 'echo WT14_MARK_6060')
  await expect(panelTerm(page)).toContainText('WT14_MARK_6060', { timeout: 25_000 })
  const pid = await panelShellPid(page, 'WT14')

  await runIn(page, centerTerm(page), '/clear')
  // the rebind under a brand-new id is the black-box barrier the assertions hang off
  await expect
    .poll(
      () =>
        Object.keys(layoutOnDisk(env).sessions as Record<string, unknown>).filter(
          (i) => i !== call.sessionId
        ).length,
      { timeout: 60_000 }
    )
    .toBeGreaterThan(0)

  expect(processAlive(pid)).toBe(true)
  await expect(termBodies(page)).toHaveCount(1)
  await expect(panelTerm(page)).toContainText('WT14_MARK_6060')
})

// T-WT-15 (D8/R11) — `/resume` moves the tab to ANOTHER conversation, and the panel does
// not follow it: the shell of the tab is the tab's, not the id's. Today the product
// rebuilds the whole panel from the target session's stored entry, which kills the shell
// outright — that is the behaviour this case is written against.
test('T-WT-15: an in-TUI /resume leaves the shell running in the same tab', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(300_000)
  const targetId = seedJsonl(env, env.workspaces.a, { summary: 'WT15 resume target' })
  await sessionWithShell(app, page, 'ws-a')
  await waitForCalls(env, 1)
  const pid = await panelShellPid(page, 'WT15')

  await runIn(page, centerTerm(page), `/resume ${targetId}`)
  await expect(centerTerm(page)).toContainText(`resumed session ${targetId}`, { timeout: 30_000 })

  expect(processAlive(pid)).toBe(true)
  await expect(termBodies(page)).toHaveCount(1)
  await runIn(page, panelTerm(page), 'echo WT15_ALIVE_$$')
  await expect(panelTerm(page)).toContainText(`WT15_ALIVE_${pid}`, { timeout: 25_000 })
})

// T-WT-16 (R1) — ⇧⌘R swaps a fresh pty into the SAME conversation-tab slot. The panel
// state moves with the slot, so the shell rides through untouched: the restart is a new
// claude process, not a new conversation.
test('T-WT-16: ⇧⌘R restarts claude and leaves the tab’s shell running', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(300_000)
  await sessionWithShell(app, page, 'ws-a')
  const [first] = await waitForCalls(env, 1)
  const pid = await panelShellPid(page, 'WT16')
  // a mark in the SCROLLBACK, printed before the restart. The xterm holds it and main
  // holds no copy, so its survival is the falsifiable form of "rode through untouched":
  // an unmount-and-remount comes back with a live shell and an empty screen, which every
  // other assertion here passes just as happily.
  await runIn(page, panelTerm(page), 'echo WT16_BEFORE_RESTART')
  await expect(panelTerm(page)).toContainText('WT16_BEFORE_RESTART', { timeout: 25_000 })

  await sendShortcut(app, 'shortcut:restart-session')
  const calls = await waitForCalls(env, 2)
  const i = calls[1].argv.indexOf('--resume')
  expect(calls[1].argv[i + 1]).toBe(first.sessionId)

  expect(processAlive(pid)).toBe(true)
  await expect(termBodies(page)).toHaveCount(1)
  await expect(panelTerm(page)).toContainText('WT16_BEFORE_RESTART', { timeout: 25_000 })
  await runIn(page, panelTerm(page), 'echo WT16_ALIVE_$$')
  await expect(panelTerm(page)).toContainText(`WT16_ALIVE_${pid}`, { timeout: 25_000 })
})
