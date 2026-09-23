import fs from 'fs'
import path from 'path'
import { spawnSync } from 'child_process'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, runInTerminal } from './helpers/app'
import { writeClaudeWrapper, type E2EEnv } from './helpers/env'
import {
  centerTerm,
  openMenu,
  runIn,
  setNextSessionTitle,
  startSessionIn,
  waitBooted
} from './helpers/p1'
import { WORKBENCH, showBrowse } from './helpers/workbench'

/**
 * Quick Restart Session (⇧⌘R / File ▸ Restart Session) — black-box coverage of
 * the locked contract v2. A tab that HAS A RESUMABLE
 * SESSION — however it got one, whether Koloft spawned the claude tab or the user typed
 * `claude` into a shell tab — must kill its pty and come back IN PLACE running
 * `<configured claude command> --resume <same session>`. Everything else, above all a
 * shell tab that never ran claude, must be a silent no-op.
 *
 * Everything is asserted from outside the app: the application menu (the contract's
 * `restart-session` id is the trigger, equivalent to the shortcut), the DOM, the
 * Claude storage the user's session survives in, and the launch log the fake `claude` /
 * fake wrapper write under the isolated $HOME — which claude processes were started,
 * with which argv, under which pid.
 *
 * Agent-centric v2 adaptations: `.ws-tab` rows are now
 * the AGGREGATED session rows of the pinned fixture workspaces (ordered by creation
 * time, newest first, and never re-ordered — shell tabs have no row); run-state renders as the
 * row's lightbar class (`st-working`/`st-waiting`), not a dot; an app relaunch lands
 * COLD (T-LIFE-09) — the resume happens by clicking the cold row, never automatically.
 * The `restart-session` contract id and the ⇧⌘R semantics are unchanged.
 */

const SESSION_TITLE = 'Fake session: project notes'

interface ClaudeCall {
  pid: number
  argv: string[]
  cwd: string
  sessionId: string
  ts: number
}

/** Every fake-claude launch so far, oldest first. Absent file = never launched. */
function readCalls(env: E2EEnv): ClaudeCall[] {
  if (!fs.existsSync(env.claudeCalls)) return []
  return fs
    .readFileSync(env.claudeCalls, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as ClaudeCall]
      } catch {
        return [] // a record still being written
      }
    })
}

async function waitForCalls(env: E2EEnv, count: number, timeout = 40_000): Promise<ClaudeCall[]> {
  await expect.poll(() => readCalls(env).length, { timeout }).toBeGreaterThanOrEqual(count)
  return readCalls(env)
}

/** The id a launch was told to resume, if any. */
function resumedId(call: ClaudeCall): string | undefined {
  const i = call.argv.indexOf('--resume')
  return i >= 0 ? call.argv[i + 1] : undefined
}

/** A restart must never launch `--resume` with a missing / non-uuid id. */
function hasMalformedResume(calls: ClaudeCall[]): boolean {
  return calls.some((c) => {
    const i = c.argv.indexOf('--resume')
    if (i < 0) return false
    const id = c.argv[i + 1]
    return !id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
  })
}

/** Alive as a real process — a reaped-but-not-yet-collected zombie counts as dead. */
function processAlive(pid: number): boolean {
  const res = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' })
  if (res.status !== 0) return false
  const stat = res.stdout.trim()
  return stat.length > 0 && !stat.startsWith('Z')
}

interface MenuEntry {
  top: string
  id: string
  label: string
  role: string
  accelerator: string
}

/** Flatten the application menu: every item, tagged with its top-level menu's label. */
async function menuEntries(app: ElectronApplication): Promise<MenuEntry[]> {
  return app.evaluate(({ Menu }) => {
    const out: { top: string; id: string; label: string; role: string; accelerator: string }[] = []
    const menu = Menu.getApplicationMenu()
    if (!menu) return out
    for (const top of menu.items) {
      const stack = top.submenu ? [...top.submenu.items] : []
      while (stack.length) {
        const item = stack.shift()!
        out.push({
          top: top.label ?? '',
          id: item.id ?? '',
          label: item.label ?? '',
          role: String(item.role ?? ''),
          accelerator: String(item.accelerator ?? '')
        })
        if (item.submenu) stack.unshift(...item.submenu.items)
      }
    }
    return out
  })
}

/** Modifier order in an accelerator is a free choice; the keys it binds are not. */
function normalizeAccelerator(accel: string): string {
  return accel
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter(Boolean)
    .sort()
    .join('+')
}

/**
 * The contract's trigger: the File menu item, which is the same code path as ⇧⌘R.
 * `times > 1` fires the clicks back to back with nothing awaited in between — the
 * "user double-tapped the shortcut" case.
 */
async function triggerRestart(app: ElectronApplication, times = 1): Promise<void> {
  await app.evaluate(({ Menu }, count) => {
    for (let i = 0; i < count; i++) {
      const item = Menu.getApplicationMenu()?.getMenuItemById('restart-session')
      if (!item) throw new Error('no application-menu item with id "restart-session"')
      item.click()
    }
  }, times)
}

/** The renderer only listens for shortcut IPC once its effect has run. */
async function waitForShortcutsReady(page: Page): Promise<void> {
  await page.waitForFunction(
    () =>
      (window as unknown as { __koloftShortcutsReady?: boolean }).__koloftShortcutsReady === true,
    undefined,
    { timeout: 20_000 }
  )
}

async function launch(env: E2EEnv): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

/** A new shell tab running the fake claude through the real shim, waited to BIND. */
async function startClaudeTab(
  page: Page,
  env: E2EEnv,
  opts: { wsName?: string; title?: string } = {}
): Promise<void> {
  const title = opts.title ?? SESSION_TITLE
  if (opts.title) setNextSessionTitle(env, opts.title)
  await waitBooted(page)
  await startSessionIn(page, opts.wsName ?? 'ws-a')
  await expect(page.locator('.ws-tab-title', { hasText: title })).toBeVisible({ timeout: 40_000 })
}

/**
 * Resume a cold session row by clicking it (the v2 resume path, T-LIFE-06) and wait
 * until it is running again: the row leaves `cold` once the SessionStart hook binds
 * the fresh pty.
 */
async function resumeColdRow(page: Page, title: string): Promise<void> {
  const row = page.locator('.ws-tab', { hasText: title })
  await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })
  await row.click()
  await expect(row).not.toHaveClass(/\bcold\b/, { timeout: 40_000 })
}

/** Where the session's transcript lives — the tracker's documented on-disk layout. */
function transcriptPath(env: E2EEnv, workspace: string, sessionId: string): string {
  const encoded = workspace.replace(/[^a-zA-Z0-9]/g, '-')
  return path.join(env.home, '.claude', 'projects', encoded, `${sessionId}.jsonl`)
}

function fileSize(file: string): number {
  try {
    return fs.statSync(file).size
  } catch {
    return 0
  }
}

/**
 * transcriptPath re-derives the cwd encoding, so if that encoding ever changes these
 * waits just time out with nothing useful to say. Say what was expected and what is
 * actually on disk instead.
 */
function describeTranscriptMiss(transcript: string): string {
  const projects = path.dirname(path.dirname(transcript))
  const listing: string[] = []
  try {
    for (const entry of fs.readdirSync(projects)) {
      const full = path.join(projects, entry)
      const files = fs.statSync(full).isDirectory() ? fs.readdirSync(full) : []
      listing.push(`  ${entry}/ -> ${files.join(', ') || '(empty)'}`)
    }
  } catch (err) {
    listing.push(`  <cannot read ${projects}: ${String(err)}>`)
  }
  return (
    `expected transcript: ${transcript}\n` +
    `actual projects dir:\n${listing.join('\n') || '  (no project dirs)'}`
  )
}

async function withTranscriptDiagnostics<T>(transcript: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    throw new Error(`${describeTranscriptMiss(transcript)}\n\n${(err as Error).message}`)
  }
}

/**
 * A stable baseline: wait until the session currently running has finished writing its
 * startup turn (the file stops growing) and return that size. Taking the baseline
 * earlier would let the CURRENT process's own append satisfy waitForResumedTurn below.
 */
async function transcriptBaseline(transcript: string): Promise<number> {
  await withTranscriptDiagnostics(transcript, async () => {
    let previous = -1
    await expect
      .poll(
        () => {
          const size = fileSize(transcript)
          const settled = size > 0 && size === previous
          previous = size
          return settled
        },
        { timeout: 30_000, intervals: [400] }
      )
      .toBe(true)
  })
  return fileSize(transcript)
}

/**
 * Wait until a resumed session is back on its feet and reading stdin. Gated on its
 * transcript GROWING past the baseline — the resumed process appends its startup turn
 * just before it starts reading input, so this can't be satisfied by the previous run
 * (a banner match in the terminal could be, if scrollback survived).
 */
async function waitForResumedTurn(
  page: Page,
  transcript: string,
  sizeBefore: number
): Promise<void> {
  await withTranscriptDiagnostics(transcript, () =>
    expect.poll(() => fileSize(transcript), { timeout: 30_000 }).toBeGreaterThan(sizeBefore)
  )
  // the append lands two hook invocations before the readline loop exists
  await page.waitForTimeout(1500)
}

// ---------------------------------------------------------------------------------
// A. Menu structure
// ---------------------------------------------------------------------------------

// T1 — the feature's only entry point. If the item or its accelerator is dropped or
// rebound, the whole feature is unreachable and every trigger below is meaningless.
test('T1: File carries Restart Session (id restart-session, ⇧⌘R)', async ({ app }) => {
  await app.firstWindow()
  const entries = await menuEntries(app)
  const item = entries.find((e) => e.id === 'restart-session')

  expect(item, 'no menu item with id "restart-session"').toBeDefined()
  expect(item!.label).toBe('Restart Session')
  expect(item!.top).toBe('File')
  expect(normalizeAccelerator(item!.accelerator)).toBe(normalizeAccelerator('Shift+CmdOrCtrl+R'))
})

// T2 — ⇧⌘R was View ▸ Force Reload. Leaving that item in place means the restart key
// is eaten by a double binding, while plain Reload (⌘R) must survive the rebuild.
test('T2: Force Reload gave up ⇧⌘R, Reload stayed', async ({ app }) => {
  await app.firstWindow()
  const entries = await menuEntries(app)
  const view = entries.filter((e) => e.top === 'View')
  expect(view.length).toBeGreaterThan(0)

  expect(view.filter((e) => e.role.toLowerCase() === 'forcereload')).toEqual([])
  expect(view.filter((e) => /force\s*reload/i.test(e.label))).toEqual([])
  // nothing anywhere may hold ⇧⌘R except the restart item
  const shiftCmdR = entries.filter(
    (e) => normalizeAccelerator(e.accelerator) === normalizeAccelerator('Shift+CmdOrCtrl+R')
  )
  expect(shiftCmdR.map((e) => e.id)).toEqual(['restart-session'])

  const reload = view.find((e) => e.role.toLowerCase() === 'reload' || /^reload$/i.test(e.label))
  expect(reload, 'View lost its Reload item').toBeDefined()
  // an explicit accelerator must still be ⌘R; a role-default one is reported empty
  if (reload!.accelerator) {
    expect(normalizeAccelerator(reload!.accelerator)).toBe(normalizeAccelerator('CmdOrCtrl+R'))
  }
})

// ---------------------------------------------------------------------------------
// B. The core restart flow
// ---------------------------------------------------------------------------------

// T3 — the whole feature in one pass, on a tab Koloft itself created as a claude tab: a
// cold-row resume spawns through the same `terminal:create` + resumeSessionId path a
// restart uses. (The other shape — a shell tab the user ran `claude` in by hand — is
// T17; under the v2 eligibility rule both must restart.)
test('T3: restart relaunches the SAME session in place and the new terminal works', async ({
  env
}) => {
  test.setTimeout(240_000)
  const first = await launch(env)
  let sessionId = ''
  try {
    await startClaudeTab(first.page, env)
    const [initial] = await waitForCalls(env, 1)
    sessionId = initial.sessionId
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/)
  } finally {
    await first.app.close().catch(() => {})
  }

  // relaunch: v2 lands cold — the row is listed but nothing respawns until clicked
  const { app, page } = await launch(env)
  try {
    expect(readCalls(env)).toHaveLength(1) // no auto-resume on startup (T-LIFE-09)
    await resumeColdRow(page, SESSION_TITLE)
    const restored = await waitForCalls(env, 2)
    expect(resumedId(restored[1])).toBe(sessionId)

    const transcript = transcriptPath(env, env.workspaces.a, sessionId)
    const sizeBefore = await transcriptBaseline(transcript)
    const titlesBefore = await page.locator('.ws-tab .ws-tab-title').allTextContents()
    await triggerRestart(app)

    // (a) another claude launch, resuming exactly the session that was running
    const calls = await waitForCalls(env, 3)
    expect(calls).toHaveLength(3)
    expect(resumedId(calls[2])).toBe(sessionId)
    expect(calls[2].sessionId).toBe(sessionId)
    expect(calls[2].cwd).toBe(env.workspaces.a)

    // (b) same tab, same slot, same title — not a close-and-reopen
    await expect(page.locator('.ws-tab')).toHaveCount(titlesBefore.length)
    expect(await page.locator('.ws-tab .ws-tab-title').allTextContents()).toEqual(titlesBefore)

    // (c) exactly one sidebar row for the session — no ghost left by the dead pty
    await expect(page.locator('.ws-tab', { hasText: SESSION_TITLE })).toHaveCount(1)

    // (d) the replacement terminal is live and interactive
    await waitForResumedTurn(page, transcript, sizeBefore)
    await runIn(page, centerTerm(page), 'after-restart-marker')
    await expect(centerTerm(page)).toContainText('handled: after-restart-marker', {
      timeout: 20_000
    })
  } finally {
    await app.close().catch(() => {})
  }
})

// T4: the restart used to go
// through a configured wrapper; auth now comes from the multi-account balancer (the
// shim injects per-launch — multi-account.spec.ts E9 covers a restart re-balancing)
// or the system /login. The KOLOFT_CLAUDE_CMD env seam remains test-only (T15 uses it).

// T5 — ⇧⌘R is deliberate enough on its own: no confirmation, even mid-turn. A dialog
// would also be unanswerable in a hidden window; and the tab must not strand in
// 'working' once the process it was waiting on is gone.
test('T5: restarting a working session is immediate, with no confirmation', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(150_000)
  await startClaudeTab(page, env)
  const [first] = await waitForCalls(env, 1)

  await runIn(page, centerTerm(page), '/busy')
  await expect(page.locator('.ws-tab.st-working')).toBeVisible({ timeout: 20_000 })

  // count (and auto-answer) any confirmation instead of letting it appear: a real modal
  // in a never-shown window would hang the suite AND break the no-visible-UI rule
  await app.evaluate(({ dialog }) => {
    const g = globalThis as unknown as { __koloftDialogCount?: number }
    g.__koloftDialogCount = 0
    const d = dialog as unknown as Record<string, unknown>
    d.showMessageBox = (): Promise<{ response: number }> => {
      g.__koloftDialogCount = (g.__koloftDialogCount ?? 0) + 1
      return Promise.resolve({ response: 0 })
    }
    d.showMessageBoxSync = (): number => {
      g.__koloftDialogCount = (g.__koloftDialogCount ?? 0) + 1
      return 0
    }
  })
  await page.evaluate(() => {
    const w = window as unknown as { __koloftConfirmCount?: number }
    w.__koloftConfirmCount = 0
    window.confirm = (): boolean => {
      w.__koloftConfirmCount = (w.__koloftConfirmCount ?? 0) + 1
      return true
    }
  })

  await triggerRestart(app)
  const calls = await waitForCalls(env, 2)
  expect(resumedId(calls[1])).toBe(first.sessionId)

  expect(
    await app.evaluate(
      () => (globalThis as { __koloftDialogCount?: number }).__koloftDialogCount ?? -1
    )
  ).toBe(0)
  expect(
    await page.evaluate(
      () => (window as unknown as { __koloftConfirmCount?: number }).__koloftConfirmCount ?? -1
    )
  ).toBe(0)

  // and the resumed session settles back to a normal run-state instead of hanging
  await expect(page.locator('.ws-tab.st-waiting')).toBeVisible({ timeout: 40_000 })
})

// T6 — an orphaned claude keeps appending to the session jsonl and fighting the new
// one over the same session. The old process has to be gone, not just detached.
test('T6: the old claude process is dead after a restart', async ({ app, page, env }) => {
  test.setTimeout(150_000)
  await startClaudeTab(page, env)
  const [first] = await waitForCalls(env, 1)
  expect(processAlive(first.pid)).toBe(true)

  await triggerRestart(app)
  const calls = await waitForCalls(env, 2)
  expect(calls[1].pid).not.toBe(first.pid)

  await expect.poll(() => processAlive(first.pid), { timeout: 30_000 }).toBe(false)
  expect(processAlive(calls[1].pid)).toBe(true)
})

// ---------------------------------------------------------------------------------
// C. no-op boundaries
// ---------------------------------------------------------------------------------

// T7 retired with the free terminal (agent-centric §9): "a tab that never ran claude"
// was a shell tab, and there is no longer any such thing — every tab IS a session, so
// the no-op boundary it guarded cannot be reached. T8 (a tab whose claude has not bound
// YET) and T9 (no tab at all) are the boundaries that remain.

// T8 — between "claude started" and "the session bound" there is no id to resume. The
// trigger must do nothing at all there, and above all never launch `--resume undefined`.
test('T8: an unbound claude tab is a no-op until it binds, then restarts normally', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  // delay the fake claude's SessionStart + transcript: the process runs, the shim has
  // registered the tab as a claude tab, but no session exists yet
  // 20s: the whole unbound-window assertion below runs in well under half that, even
  // on a slow runner, so the session can't bind mid-assertion
  fs.writeFileSync(env.claudeDelayFile, '20000')
  // NOT startClaudeTab: that waits for the bind, which is the very window under test
  await waitBooted(page)
  await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
  await page.locator('.menu .mi', { hasText: 'New session' }).click()

  const [first] = await waitForCalls(env, 1, 30_000)
  await page.waitForTimeout(2000) // let the shim registration reach the tracker
  await expect(page.locator('.ws-tab-title', { hasText: SESSION_TITLE })).toHaveCount(0)

  await triggerRestart(app, 2)
  await page.waitForTimeout(4000)
  expect(readCalls(env)).toHaveLength(1)
  expect(hasMalformedResume(readCalls(env))).toBe(false)
  // the launch holds a PENDING row (§4) — what it must not have is a bound session
  await expect(page.locator('.ws-tab')).toHaveCount(1)
  await expect(page.locator('.ws-tab.st-pending')).toHaveCount(1)

  // once the session binds, the very same trigger restarts it
  fs.rmSync(env.claudeDelayFile, { force: true })
  await expect(page.locator('.ws-tab-title', { hasText: SESSION_TITLE })).toBeVisible({
    timeout: 40_000
  })
  await triggerRestart(app)
  const calls = await waitForCalls(env, 2)
  expect(resumedId(calls[1])).toBe(first.sessionId)
  expect(hasMalformedResume(calls)).toBe(false)
})

// T9 — with no active tab there is nothing to dereference; the app must simply ignore
// the key rather than throw (an unhandled main-process error kills the menu action for
// the rest of the session).
test('T9: with no claude tab at all the trigger does nothing and nothing breaks', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(120_000)
  await expect(page.locator('.center')).toContainText('No running session', { timeout: 20_000 })
  await waitForShortcutsReady(page)

  await triggerRestart(app, 3)
  await page.waitForTimeout(3000)
  await expect(page.locator('.center')).toContainText('No running session')
  await expect(page.locator('.ws-tab')).toHaveCount(0)
  expect(readCalls(env)).toHaveLength(0)

  // still fully functional afterwards: repeated triggers change nothing, and a session
  // started after them runs normally
  await triggerRestart(app, 3)
  await page.waitForTimeout(3000)
  await expect(page.locator('.ws-tab')).toHaveCount(0)
  expect(readCalls(env)).toHaveLength(0)
  await startClaudeTab(page, env)
  expect(readCalls(env)).toHaveLength(1)
})

// ---------------------------------------------------------------------------------
// D. Concurrency / de-duplication
// ---------------------------------------------------------------------------------

// T10 — a double tap must not put two claude processes on one session (they would both
// append to the same jsonl) or leave a second pty behind.
test('T10: two rapid triggers restart the session exactly once', async ({ app, page, env }) => {
  test.setTimeout(150_000)
  await startClaudeTab(page, env)
  const [first] = await waitForCalls(env, 1)

  await triggerRestart(app, 2)
  const calls = await waitForCalls(env, 2)
  expect(resumedId(calls[1])).toBe(first.sessionId)

  // a second restart would land well inside this window
  await page.waitForTimeout(8000)
  expect(readCalls(env)).toHaveLength(2)
  await expect(page.locator('.ws-tab')).toHaveCount(1)
  await expect(page.locator('.ws-tab', { hasText: SESSION_TITLE })).toHaveCount(1)

  // …and the one restart that did happen left a session that still answers, with no
  // error output from the double press (BB-C01's tail clause)
  await runInTerminal(page, 'double-press-marker')
  await expect(page.locator('.term-wrap:visible .xterm')).toContainText(
    'handled: double-press-marker',
    { timeout: 15_000 }
  )
  await expect(page.locator('.term-wrap:visible .xterm')).not.toContainText('fatal:')
})

// T11 — the restart's blast radius is exactly one pty: the ACTIVE tab's. A sibling
// session running beside it must come through untouched, however the restart is
// implemented underneath (close-old + open-new is not allowed to reach anything else).
// (The original case drove TWO tabs on ONE session, typing `claude --resume <id>` into
// a second shell tab. Dual binding is still legal — it is what two Koloft instances, or a
// history session resumed while it runs elsewhere, produce — but nothing inside one
// instance can set it up any more: "Restore from history" only ever offers sessions
// that are NOT in the working set.)
test('T11: restarting one session leaves a sibling session untouched', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  // session A: the sibling that must survive
  await startClaudeTab(page, env, { title: 'Sibling session' })
  const [tabA] = await waitForCalls(env, 1)

  // session B in ws-b, now the active tab — the one the restart targets
  await startClaudeTab(page, env, { wsName: 'ws-b' })
  const afterB = await waitForCalls(env, 2)
  const tabB = afterB[1]
  await expect(page.locator('.ws-tab')).toHaveCount(2)

  // ⇧⌘R is gated on the transcript already being on disk, so firing it before
  // that lands makes the shortcut a no-op and the third launch below never comes. Same
  // barrier the other restart cases take.
  await transcriptBaseline(transcriptPath(env, env.workspaces.a, tabA.sessionId))

  await triggerRestart(app)
  const calls = await waitForCalls(env, 3)
  expect(resumedId(calls[2])).toBe(tabB.sessionId)
  // the restart killed the ACTIVE tab's pty (B)…
  await expect.poll(() => processAlive(tabB.pid), { timeout: 30_000 }).toBe(false)
  // …while A's process was never in the blast radius
  expect(processAlive(tabA.pid)).toBe(true)
  await expect(page.locator('.ws-tab')).toHaveCount(2)

  // and the restarted terminal is still bound and interactive (the swapped-in pty
  // renders a fresh xterm, so 'ready in' can only come from the NEW process)
  await expect(centerTerm(page)).toContainText('ready in', {
    timeout: 20_000
  })
  await page.waitForTimeout(1500) // the readline loop attaches just after the banner
  await runIn(page, centerTerm(page), 'tab-b-marker')
  await expect(centerTerm(page)).toContainText('handled: tab-b-marker', {
    timeout: 20_000
  })
  await expect(page.locator('.ws-tab', { hasText: 'Sibling session' })).toHaveCount(1)
})

// ---------------------------------------------------------------------------------
// E. State kept across the swap
// ---------------------------------------------------------------------------------

// T12 — the viewer pane hangs off the tab, not the pty. Swapping in a new pty must
// carry it over (the same way activating a dormant tab does).
test('T12: an open preview pane survives the restart', async ({ app, page, env }) => {
  test.setTimeout(150_000)
  await startClaudeTab(page, env)
  const [first] = await waitForCalls(env, 1)

  // the tree moved into the panel's pinned `files` tab (FR-44); the reading area it feeds
  // is still what has to survive the pty swap
  await showBrowse(page)
  const notes = page.locator(`${WORKBENCH.panel} .ft-node.ft-file`, { hasText: 'NOTES.md' })
  await expect(notes).toBeVisible({ timeout: 20_000 })
  await notes.click()
  await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('NOTES.md')

  await triggerRestart(app)
  const calls = await waitForCalls(env, 2)
  expect(resumedId(calls[1])).toBe(first.sessionId)

  // THIS is the assertion the case turns on, and the reason it can see what it sees is the
  // header's claim: the pane hangs off the TAB, not the pty. A restart swaps a fresh pty
  // into the same tab for the same session — so it exercises the one arrangement where
  // "the tab changed" and "the user switched session" come apart, and only a reset keyed
  // on the latter survives it. WB-C05's per-tab state swap is about switching to a DIFFERENT
  // session and must not fire here.
  //
  // No Browse gesture, deliberately: the reading area has to be STILL ON SCREEN, not
  // merely still loaded behind a view that reset. That distinction is not pedantry — it is
  // the whole failure mode. A version that keyed the reset on `activeTabId`, which a
  // restart changes, passed every other line in this file: the file stayed loaded and
  // correct while its half went off screen, so only an on-screen oracle could fail. Keep
  // it that way; do not "simplify" this into a showBrowse() plus a content check.
  await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('NOTES.md')
  await expect(page.locator(WORKBENCH.readingBody)).toContainText('Written by the fake claude')
})

// T13 — "restart" implemented as close-old + open-new must not duplicate the session's
// row, drop a sibling, flash any row back to a default title — or move Bravo: rows sit
// by creation time and a restart resumes the SAME session, so the order is untouched.
test('T13: restarting the middle session keeps every row, in place, each with its title', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(240_000)
  const titles = ['Alpha session', 'Bravo session', 'Charlie session']
  for (const title of titles) {
    await startClaudeTab(page, env, { title })
  }
  const calls = await waitForCalls(env, 3)
  const bravo = calls[1] // launched second

  const orderBefore = await page.locator('.ws-tab .ws-tab-title').allTextContents()
  expect(orderBefore).toEqual(expect.arrayContaining(titles))

  await page.locator('.ws-tab', { hasText: 'Bravo session' }).click()
  await triggerRestart(app)
  const after = await waitForCalls(env, 4)
  expect(resumedId(after[3])).toBe(bravo.sessionId)

  await expect(page.locator('.ws-tab')).toHaveCount(3)
  expect(await page.locator('.ws-tab .ws-tab-title').allTextContents()).toEqual(orderBefore)
  await expect(page.locator('.ws-tab', { hasText: 'Bravo session' })).toHaveCount(1)
})

// T12 + T13 on the tab shape neither of them had: a CLAUDE-KIND tab (one Koloft spawned
// itself — in v2 that is a cold-row resume — rather than a shell tab someone typed
// `claude` into). Those tabs go through state transitions the others never see, above
// all the claude→shell revert that fires when a bound session's process ends — which is
// exactly what a restart does to it. A revert landing inside the restart window strips
// the row back to a default title and drops the viewer pane.
test('T12/T13 on a claude-kind tab: a resumed tab keeps its title and pane across a restart', async ({
  env
}) => {
  test.setTimeout(240_000)
  const first = await launch(env)
  let sessionId = ''
  try {
    await startClaudeTab(first.page, env)
    const [initial] = await waitForCalls(env, 1)
    sessionId = initial.sessionId
  } finally {
    await first.app.close().catch(() => {})
  }

  const { app, page } = await launch(env)
  try {
    // a tab Koloft created as a claude tab: the cold row clicked back to life (v2 resume)
    await resumeColdRow(page, SESSION_TITLE)
    await waitForCalls(env, 2)

    // the preview that has to survive the swap (now the pinned `files` tab's reading area)
    await showBrowse(page)
    const notes = page.locator(`${WORKBENCH.panel} .ft-node.ft-file`, { hasText: 'NOTES.md' })
    await expect(notes).toBeVisible({ timeout: 25_000 })
    await notes.click()
    await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('NOTES.md')

    const transcript = transcriptPath(env, env.workspaces.a, sessionId)
    const sizeBefore = await transcriptBaseline(transcript)
    await triggerRestart(app)

    // Sample CONTINUOUSLY across the swap window. The contract forbids flashing back to
    // a default title, so a transient revert fails even if it later heals — count() is
    // an instantaneous snapshot, where an expect() would paper the flash over with its
    // own retry budget. Keep watching past the relaunch: the revert is driven by the OLD
    // pty's exit, which can land after the new claude is already up.
    let sawRelaunch = false
    let stopAt = 0
    const hardDeadline = Date.now() + 45_000
    while (Date.now() < hardDeadline) {
      expect(
        await page.locator('.ws-tab', { hasText: SESSION_TITLE }).count(),
        'the tab lost its session title during the restart'
      ).toBe(1)
      if (!sawRelaunch && readCalls(env).length >= 3) {
        sawRelaunch = true
        stopAt = Date.now() + 5000
      }
      if (sawRelaunch && Date.now() >= stopAt) break
      await page.waitForTimeout(150)
    }
    expect(sawRelaunch, 'the restart never launched claude again').toBe(true)

    const calls = readCalls(env)
    expect(resumedId(calls[2])).toBe(sessionId)
    await expect(page.locator('.ws-tab')).toHaveCount(1)
    await expect(page.locator('.ws-tab', { hasText: SESSION_TITLE })).toHaveCount(1)

    // the pane is still attached to the tab, still showing what it showed before — on
    // screen, not merely loaded behind a reset view (see T12's note on the same line)
    await expect(page.locator(WORKBENCH.readingTitle)).toHaveText('NOTES.md')
    await expect(page.locator(WORKBENCH.readingBody)).toContainText('Written by the fake claude')

    // and the resumed session is genuinely alive, not just visually intact
    await waitForResumedTurn(page, transcript, sizeBefore)
  } finally {
    await app.close().catch(() => {})
  }
})

// T14 — a restart must not orphan the session from its storage anchors (id + cwd):
// after the next app launch the session must still be listed and resumable as ITSELF.
// (v2: the anchor is Claude's own storage, not a layout.json tab snapshot — A10.)
test('T14: a restarted session is still listed and resumable after an app restart', async ({
  env
}) => {
  test.setTimeout(240_000)
  const first = await launch(env)
  let sessionId = ''
  try {
    await startClaudeTab(first.page, env)
    const [initial] = await waitForCalls(env, 1)
    sessionId = initial.sessionId

    await triggerRestart(first.app)
    const calls = await waitForCalls(env, 2)
    expect(resumedId(calls[1])).toBe(sessionId)
  } finally {
    await first.app.close().catch(() => {})
  }

  // relaunch: the session lands cold, and clicking it resumes the very same id
  const second = await launch(env)
  try {
    await resumeColdRow(second.page, SESSION_TITLE)
    const calls = await waitForCalls(env, 3)
    expect(resumedId(calls[2])).toBe(sessionId)
  } finally {
    await second.app.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------------
// F. Fault tolerance
// ---------------------------------------------------------------------------------

// T15 — kill succeeded, respawn died at exec: the session is recoverable afterwards, and
// the user is told why it went.
//
// REWRITTEN for's dead=cold. The old shape asserted "the tab must stay", which was
// the freeze path: a respawn whose command is missing does NOT reject `terminal.create` —
// main spawns a real pty and the shell exits at once with 127 — and that exit used to
// freeze the tab so the error stayed readable. Every pty exit closes its tab now, so what
// carries the case is the pair put in the freeze's place: a toast that names the
// exit, and a cold row that resumes. (Measured: the second ⇧⌘R in the old shape found
// `activeTabId: null` and returned, because the tab had already gone.)
test('T15: a respawn that dies at exec says so, and the row still resumes', async ({ env }) => {
  test.setTimeout(180_000)
  // every launch goes through a wrapper this test owns (KOLOFT_CLAUDE_CMD is the test-only
  // base-command seam; the claudeCommand setting is retired, D4). It works for the first
  // launch and is then REMOVED, so the restart's respawn cannot produce a working process.
  const wrapper = writeClaudeWrapper(env)
  env.launchEnv.KOLOFT_CLAUDE_CMD = wrapper

  const { app, page } = await launch(env)
  try {
    await startClaudeTab(page, env)
    const [first] = await waitForCalls(env, 1)

    fs.rmSync(path.join(env.fakeBin, wrapper), { force: true })
    await triggerRestart(app)

    // The exit is said out loud, carrying the code — the whole of what the former freeze
    // was for. 127 is the shell's "command not found", i.e. the missing wrapper itself, so
    // this pins that the REASON reaches the user and not merely that something happened.
    await expect(page.locator('.toast-msg')).toContainText('exit code 127', { timeout: 30_000 })
    expect(readCalls(env)).toHaveLength(1) // no claude ever ran: the wrapper was gone
    // …and nothing of the dead session is left on screen (T-LIFE-05's shape)
    await expect(page.locator('.term-island .term-wrap')).toHaveCount(0, { timeout: 20_000 })

    // put the command back; the cold row is the door leaves for exactly this
    writeClaudeWrapper(env, wrapper)
    await resumeColdRow(page, SESSION_TITLE)
    const calls = await waitForCalls(env, 2)
    expect(resumedId(calls[1])).toBe(first.sessionId)
    expect(fs.readFileSync(env.wrapperCalls, 'utf8')).toContain(`--resume ${first.sessionId}`)
  } finally {
    await app.close().catch(() => {})
  }
})

// T16 and T17 retired with the free terminal (agent-centric §9). Both rested on a shell
// outliving the TUI inside one tab: T16 restarted a tab whose claude had /exit-ed (the
// shell kept the tab alive), and T17 restarted a session the user had typed `claude`
// into a plain shell tab to start. A session pty now runs `exec claude`, so claude's
// exit IS the tab's — there is no tab left to restart, and no other way to start a
// session than the one every case above already uses.
