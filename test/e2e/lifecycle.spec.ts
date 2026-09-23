import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp, pendingAttention } from './helpers/app'
import type { E2EEnv } from './helpers/env'
import {
  centerTerm,
  closeMenu,
  FAKE_SESSION_TITLE,
  gitInit,
  gitWorktreeAdd,
  killSession,
  layoutOnDisk,
  menuItemTexts,
  openMenu,
  readCalls,
  resumedId,
  runIn,
  seedJsonl,
  setNextSessionTitle,
  snap,
  startSessionIn,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'
import {
  installStallingGit,
  persistedTabsOnDisk,
  sessionWorkbenchOnDisk,
  wbTabs
} from './helpers/workbench'

// Session lifecycle, P1 slice: both go-cold signal
// paths, the cold-row resume chain, the cold restart invariant, the statusless
// lightbar, and the menu-is-the-operation-surface contract.

/** Start a fake-claude session the way the product does and wait for its row to bind.
 *  A named session takes the one-shot title seam — a Koloft-spawned pty has no shell in
 *  between to export $KOLOFT_FAKE_TITLE in. */
async function startSession(
  page: Page,
  env: E2EEnv,
  opts: { wsName?: string; title?: string } = {}
): Promise<void> {
  const title = opts.title ?? FAKE_SESSION_TITLE
  if (opts.title) setNextSessionTitle(env, opts.title)
  await waitBooted(page)
  await startSessionIn(page, opts.wsName ?? 'ws-a')
  await expect(page.locator('.ws-tab-title', { hasText: title })).toBeVisible({ timeout: 40_000 })
}

// T-LIFE-04 (the lifecycle contract D1; WB-T15/FR-29) — the two ways a session stops are no
// longer one verdict. A graceful /exit is the user declaring they are done with it, so
// the row leaves the working set entirely (the transcript stays in Claude's storage,
// where "Restore from history" finds it). A hard kill is nobody's decision, so its row
// is kept — cold, in place, resumable.
//
// After the merge that verdict decides one more thing: the session's WORKBENCH. FR-29
// splits the two id changes that look alike — /clear MOVES the tab set to the new id
// (browser-lifecycle's BB-C40), while leaving the list DROPS it. So the graceful half
// here also pins the drop: the tab the session built goes with the row, and a fresh
// session in the same workspace starts on a clean strip rather than inheriting it.
test('T-LIFE-04: /exit removes the row (jsonl kept); kill -9 leaves it cold in place', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await startSession(page, env, { title: 'Graceful session' })
  await startSession(page, env, { title: 'Hard session' })
  const [graceful, hard] = await waitForCalls(env, 2)

  const gracefulRow = page.locator('.ws-tab', { hasText: 'Graceful session' })
  const hardRow = page.locator('.ws-tab', { hasText: 'Hard session' })
  await expect(gracefulRow).not.toHaveClass(/\bcold\b/)
  await expect(hardRow).not.toHaveClass(/\bcold\b/)

  // non-graceful path: SIGKILL fires no hook — only the ps probe can see this, and
  // what it finds it keeps (the removal whitelist is never reached from there)
  killSession(hard.pid, env)
  await expect(hardRow).toHaveClass(/\bcold\b/, { timeout: 30_000 })

  // graceful path: /exit reports SessionEnd(prompt_input_exit) — D1's whitelist
  await gracefulRow.click() // bring its tab back to the foreground
  await expect(centerTerm(page)).toBeVisible()
  // a tab of its own first, so "the tab set is dropped with the row" has something to
  // drop (an agent `open` — a background web tab, FR-13 — is the cheapest way to build one)
  await runIn(page, centerTerm(page), '/open http://127.0.0.1:1/graceful')
  await expect
    .poll(() => persistedTabsOnDisk(env, graceful.sessionId).length, { timeout: 30_000 })
    .toBe(1)
  await runIn(page, centerTerm(page), '/exit')
  await expect(gracefulRow).toHaveCount(0, { timeout: 30_000 })
  // FR-29: the whole entry goes, tab set included — not emptied, not orphaned
  await expect
    .poll(() => sessionWorkbenchOnDisk(env, graceful.sessionId), { timeout: 20_000 })
    .toBeNull()

  // deregistered, never deleted — the jsonl is what Restore from history reads back
  const jsonl = fs
    .readdirSync(path.join(env.home, '.claude', 'projects'), { recursive: true })
    .map(String)
    .find((p) => p.endsWith(graceful.sessionId + '.jsonl'))
  expect(jsonl).toBeTruthy()

  // the killed session is the only row left, and nothing claims to be running
  await expect(page.locator('.ws-tab')).toHaveCount(1)
  await expect(
    page.locator('.ws-tab.st-working, .ws-tab.st-waiting, .ws-tab.st-approval, .ws-tab.st-idle')
  ).toHaveCount(0)
  await snap(page, 'T-LIFE-04')

  // WB-T15's positive barrier: a NEW session in the same workspace opens on the default
  // strip — the pinned `files` tab alone (FR-02). Without it "the entry is gone" could
  // still mean "gone into the next session that comes along".
  await startSession(page, env, { title: 'After the exit' })
  await expect(wbTabs(page)).toHaveCount(1)
})

// T-LIFE-04's other half: the way BACK from a graceful /exit is Restore from history —
// the eviction must leave the session restorable IN THE SAME RUN, and the restore must
// resume the very same id. This is the round trip the /exit-race fix completes: before
// it, the row never left, so this path could not even be reached. (BB-M09 covers the
// dialog itself, but seeds through a NON-graceful end — this pins the graceful one.)
test('a /exit-ed session comes back through Restore session…, resuming the same id', async ({
  page,
  env
}) => {
  test.setTimeout(180_000)
  await startSession(page, env, { title: 'Round trip session' })
  const [first] = await waitForCalls(env, 1)
  const row = page.locator('.ws-tab', { hasText: 'Round trip session' })

  await runIn(page, centerTerm(page), '/exit')
  await expect(row).toHaveCount(0, { timeout: 30_000 })

  await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
  await page.locator('.menu .mi', { hasText: 'Restore session' }).click()
  const entry = page.getByRole('button', { name: 'Round trip session' })
  await expect(entry).toBeVisible({ timeout: 15_000 })
  await entry.click()

  await expect(row).toHaveCount(1, { timeout: 60_000 })
  const calls = await waitForCalls(env, 2)
  expect(resumedId(calls[1])).toBe(first.sessionId)
})

// T-LIFE-15 (the lifecycle contract D1, pinning E6) — the whitelist rule at the one place it
// decides something: a SIGHUP'd claude DOES fire SessionEnd, with reason 'other'.
// 'other' is outside the removal whitelist, so every signal-driven teardown (⌘W, a
// workspace removal, Koloft quitting) leaves its row behind as cold — the hook is what
// decides the row's fate, and it fires before the pty it runs in goes down with claude.
test('T-LIFE-15: a SIGHUP reports SessionEnd(other) and the row stays, cold', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await startSession(page, env, { title: 'Hangup session' })
  const [call] = await waitForCalls(env, 1)
  const row = page.locator('.ws-tab', { hasText: 'Hangup session' })

  // consume the finished-turn marker first, so the absence asserted below means
  // "no exit alert was raised", not "an older marker is still pending"
  await row.click()
  await expect.poll(() => pendingAttention(page), { timeout: 20_000 }).toHaveLength(0)

  process.kill(call.pid, 'SIGHUP')
  await expect(row).toHaveClass(/\bcold\b/, { timeout: 40_000 })
  await expect(page.locator('.ws-tab')).toHaveCount(1)

  // the SessionEnd really arrived: a death with NO SessionEnd is reported as an
  // unexpected exit (attention.spec) — two liveness sweeps' worth of silence is the
  // observable difference between the hook path and the ps-probe path
  await page.waitForTimeout(8000)
  expect(await pendingAttention(page)).toHaveLength(0)
  await expect(page.locator('.ws-tab')).toHaveCount(1)
  await expect(row).toHaveClass(/\bcold\b/)
})

// T-LIFE-16 (the lifecycle contract D2/V5) — an in-place restart on the SAME id is a list
// no-op. /compact fires SessionEnd + SessionStart(source=compact) without moving the
// id, so the rebind guard (nextId !== prevId) never fires and the ambiguous end reason
// never reaches the removal whitelist: same row, same registration, still running.
test('T-LIFE-16: /compact restarts the session in place and the row does not move', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await startSession(page, env, { title: 'Compacted session' })
  const [call] = await waitForCalls(env, 1)
  const row = page.locator('.ws-tab', { hasText: 'Compacted session' })
  await expect(row).not.toHaveClass(/\bcold\b/)

  await runIn(page, centerTerm(page), '/compact')
  await expect(centerTerm(page)).toContainText(`compacted -> session ${call.sessionId}`, {
    timeout: 30_000
  })

  // long enough for a wrong removal (or a rebind) to show up
  await page.waitForTimeout(5000)
  await expect(page.locator('.ws-tab')).toHaveCount(1)
  await expect(row).not.toHaveClass(/\bcold\b/)
  expect(readCalls(env)).toHaveLength(1) // in place: nothing was relaunched
  expect((layoutOnDisk(env).sessions as Record<string, unknown>)[call.sessionId]).toBeTruthy()
})

// T-LIFE-05 — a session that dies is a cold row and nothing more: the state an app
// restart leaves it in (T-LIFE-09). Its tab closes with its pty — no frozen transcript
// stays on screen, the row is no longer the selected one, and the centre falls back to
// whatever is next (here the S4 welcome panel). The one account of the death is a toast.
//
// The SHELL half moved out rather than flipping in place. A shell used to belong to no
// session at all (the global terminal island), so a cold transition left it standing;
// D2/R9 make the shells the session's own, so going cold kills them and drops their
// tabs — pinned by workbench-terminal.spec.ts T-WT-10, and deliberately not repeated here.
test('T-LIFE-05: a session that dies closes its tab and leaves a cold, unselected row', async ({
  page,
  env
}) => {
  test.setTimeout(240_000)
  gitInit(env.workspaces.a)
  await startSessionIn(page, 'ws-a')
  const [session] = await waitForCalls(env, 1)
  const row = wsRows(page, 'ws-a').first()
  await expect(row).toHaveClass(/\bactive\b/)

  // SIGKILL fires no SessionEnd — only the ps liveness probe can see this go cold
  killSession(session.pid, env)
  // the pty's exit is what closes the tab, and it is said out loud as the kill it was
  // (node-pty reports a signal death with exit code 0 — the signal is the tell)
  await expect(page.locator('.toast-msg')).toContainText('killed by signal', { timeout: 20_000 })
  await expect(page.locator('.term-island .term-wrap')).toHaveCount(0, { timeout: 20_000 })
  await expect(page.locator('.w-empty')).toBeVisible({ timeout: 20_000 })
  await expect(row).toHaveClass(/\bcold\b/, { timeout: 40_000 })
  await expect(row).not.toHaveClass(/\bactive\b/)

  await snap(page, 'T-LIFE-05')
})

// T-LIFE-06 — clicking a cold row resumes THAT session: `--resume <id>` in the
// jsonl-recorded cwd, with the "Resuming Claude session…" mask up during the
// pre-bind window (widened by the delay seam).
test('T-LIFE-06: a cold row resumes with --resume in its original cwd, mask shown while binding', async ({
  env
}) => {
  test.setTimeout(180_000)
  const app1 = await launchApp(env)
  const page1 = await app1.firstWindow()
  await page1.waitForLoadState('domcontentloaded')
  await startSession(page1, env)
  const [first] = await waitForCalls(env, 1)
  await app1.close()

  fs.writeFileSync(env.claudeDelayFile, '3000') // widen the pre-bind window
  const app2 = await launchApp(env)
  try {
    const page2 = await app2.firstWindow()
    await page2.waitForLoadState('domcontentloaded')
    const row = page2.locator('.ws-tab', { hasText: 'Fake session: project notes' })
    await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })
    await row.click()

    // inside the delay window: the resuming mask is up over the live pty — and the
    // ROW says so too (bug report): launch treatment (flowing bar) instead of a
    // dead-ringer for cold, and the selection the click just made
    const mask = page2.locator('.term-wrap:visible .empty', {
      hasText: 'Resuming Claude session…'
    })
    await expect(mask).toBeVisible({ timeout: 10_000 })
    await expect(row).toHaveClass(/\bst-pending\b/)
    await expect(row).toHaveClass(/\bactive\b/)
    await snap(page2, 'T-LIFE-06')

    // the relaunch carried --resume <same id> and ran in the jsonl-recorded cwd
    const calls = await waitForCalls(env, 2)
    expect(resumedId(calls[1])).toBe(first.sessionId)
    expect(calls[1].cwd).toBe(env.workspaces.a)

    // once the session binds, the mask drops and the row is running again
    await expect(mask).toHaveCount(0, { timeout: 30_000 })
    await expect(row).not.toHaveClass(/\bcold\b/, { timeout: 30_000 })
  } finally {
    await app2.close().catch(() => {})
  }
})

// T-LIFE-18 — the click answers at once. Before main has even been asked for its plan,
// the island shows the resume mask and the row reads selected; the pty that lands later
// takes over the SAME mask. Reproduced with a worktree-bound row (the plan probes it
// with git) and a git that stalls that probe: without the click-time placeholder the
// mask could only appear AFTER the stall, with the tab — which is the "did it hang?"
// window this case exists for. The marker assertion is the one carrying the case: a
// mask on screen while the stalled git has not finished is a mask that went up before
// main answered.
test('T-LIFE-18: a cold-row click shows the resume mask and selects the row before main has answered', async ({
  env
}) => {
  test.setTimeout(120_000)
  gitInit(env.workspaces.a)
  const wt = gitWorktreeAdd(env.workspaces.a, 'slow')
  const id = seedJsonl(env, env.workspaces.a, {
    summary: 'Slow to plan session',
    cwd: env.workspaces.a,
    worktreeState: { worktreeName: 'slow', worktreePath: wt, originalCwd: env.workspaces.a }
  })
  const stallDone = installStallingGit(env, { root: wt, subcommand: 'symbolic-ref', ms: 3000 })

  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const row = page.locator('.ws-tab', { hasText: 'Slow to plan session' })
    await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })
    await row.click()

    // the very next frames: mask up (naming the session), row selected + launching
    const mask = page.locator('.terminals .empty', { hasText: 'Resuming Claude session…' })
    await expect(mask).toBeVisible({ timeout: 1500 })
    await expect(mask).toContainText('Slow to plan session')
    expect(fs.existsSync(stallDone)).toBe(false) // main is still inside the stalled probe
    await expect(row).toHaveClass(/\bactive\b/)
    await expect(row).toHaveClass(/\bst-pending\b/)
    expect(readCalls(env)).toHaveLength(0) // and no pty has been spawned for it yet
    await snap(page, 'T-LIFE-18')

    // main answers: the same resume goes through — one pty, --resume <this id> — and the
    // mask stays up, uninterrupted, until the session binds
    const calls = await waitForCalls(env, 1)
    expect(resumedId(calls[0])).toBe(id)
    await expect(mask).toHaveCount(0, { timeout: 30_000 })
    await expect(row).not.toHaveClass(/\bcold\b/, { timeout: 30_000 })
    await expect(row).toHaveClass(/\bactive\b/)
  } finally {
    await app.close().catch(() => {})
  }
})

// T-LIFE-09 — a restart lands cold: nothing running, nothing selected, and the
// layout on disk carries no activeSessionId (A10).
test('T-LIFE-09: after an app restart nothing runs, nothing is selected, nothing was persisted', async ({
  env
}) => {
  test.setTimeout(180_000)
  const app1 = await launchApp(env)
  const page1 = await app1.firstWindow()
  await page1.waitForLoadState('domcontentloaded')
  await startSession(page1, env)
  await page1.waitForTimeout(1500) // let debounced writes land
  await app1.close()

  const app2 = await launchApp(env)
  try {
    const page2 = await app2.firstWindow()
    await page2.waitForLoadState('domcontentloaded')
    const row = page2.locator('.ws-tab', { hasText: 'Fake session: project notes' })
    await expect(row).toBeVisible({ timeout: 20_000 })
    await expect(row).toHaveClass(/\bcold\b/)
    await expect(page2.locator('.ws-tab.active')).toHaveCount(0)
    await expect(
      page2.locator('.ws-tab.st-working, .ws-tab.st-waiting, .ws-tab.st-approval, .ws-tab.st-idle')
    ).toHaveCount(0)
    await expect(page2.locator('.center')).toContainText('No running session')
    // nothing respawned on its own
    await page2.waitForTimeout(2000)
    expect(readCalls(env)).toHaveLength(1)

    const layout = layoutOnDisk(env)
    expect(layout.version).toBe(4) // bumped it to 3, the collapsed default to 4; A10's "nothing about the run" is unchanged
    expect(layout).not.toHaveProperty('activeSessionId')
    expect(layout).not.toHaveProperty('tabs')
    await snap(page2, 'T-LIFE-09')
  } finally {
    await app2.close().catch(() => {})
  }
})

// T-LIFE-10 — the 'claude' run-state (bound, no status): the no-status seam binds
// the session (source 'compact' — the one bind that doesn't seed 'waiting') with an
// empty transcript and never reports a run-state; the row's lightbar must read
// st-idle, stably (§4: a statusless bound session renders as idle, never as
// activity it doesn't have).
test('T-LIFE-10: a bound session that never reports a run-state shows the st-idle bar', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(120_000)
  fs.writeFileSync(env.claudeNoStatusFile, '')
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')

  // an empty transcript has no title — the bound row itself is the wait target
  const row = page.locator('.ws-tab')
  await expect(row).toHaveCount(1, { timeout: 40_000 })
  await expect(row).toHaveClass(/\bst-idle\b/)
  // stable: no later transition ever lands (nothing fires prompt/stop)
  await page.waitForTimeout(3000)
  await expect(row).toHaveClass(/\bst-idle\b/)
  await expect(
    page.locator('.ws-tab.st-working, .ws-tab.st-waiting, .ws-tab.st-approval')
  ).toHaveCount(0)
  await snap(page, 'T-LIFE-10')
})

// T-LIFE-11 — the fly-out menu IS the operation surface; each row kind carries
// exactly its set, and the A2 guard holds: a cold row offers no Close/Delete, no
// row offers Rename, and neither account nor worktree ever surface in a menu.
test('T-LIFE-11: right-click menus carry exactly the per-kind sets, with the A2 negatives', async ({
  env
}) => {
  test.setTimeout(180_000)
  // a cold row in ws-b: Koloft's own history, so it is seeded (jsonl + ownership) before
  // the launch that reads the layout — a session claimed while the app runs would only
  // reach the sidebar through a real bind
  seedJsonl(env, env.workspaces.b, { summary: 'Cold menu session' })

  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await startSession(page, env, { title: 'Running menu session' })
    const coldRow = page.locator('.ws-tab', { hasText: 'Cold menu session' })
    await expect(coldRow).toBeVisible({ timeout: 20_000 })

    const noForbidden = (items: string[]): void => {
      for (const t of items) {
        expect(t).not.toMatch(/rename/i)
        expect(t).not.toMatch(/account|@/i)
        expect(t).not.toMatch(/worktree/i)
      }
    }

    // running row: Reveal / Copy — nothing else, and in particular neither a Close
    // item nor the cold row's list-removal one (⌘W is the close gesture, D3, and a
    // running session is never dropped from the list behind the user's back)
    await openMenu(page, page.locator('.ws-tab', { hasText: 'Running menu session' }))
    const running = await menuItemTexts(page)
    expect(running).toEqual(['Reveal in Finder', 'Copy session ID'])
    for (const t of running) expect(t).not.toMatch(/close|remove from list/i)
    noForbidden(running)
    await closeMenu(page)

    // cold row: relative-time head + Resume ↩ / Reveal / Copy / Remove from list —
    // the manual way off the list (the lifecycle contract D4: the label is product copy, the
    // sessions:archive channel underneath is unchanged), and Delete stays banned
    const coldMenu = await openMenu(page, coldRow)
    expect((await coldMenu.locator('.mi.head').textContent())?.trim()).toMatch(/^\d+[smhd] ago$/)
    const cold = await menuItemTexts(page)
    expect(cold).toEqual(['Resume↩', 'Reveal in Finder', 'Copy session ID', 'Remove from list'])
    for (const t of cold) expect(t).not.toMatch(/close|delete/i)
    noForbidden(cold)
    await snap(page, 'T-LIFE-11')
    await closeMenu(page)

    // workspace head: New session ⌘N / Restore session… / Scheduled jobs… /
    // Remove workspace — nothing else
    await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
    const ws = await menuItemTexts(page)
    expect(ws).toEqual(['New session⌘N', 'Restore session…', 'Scheduled jobs…', 'Remove workspace'])
    noForbidden(ws)
    await closeMenu(page)
  } finally {
    await app.close().catch(() => {})
  }
})

// T-LIFE-14 (the lifecycle contract D4; WB-T15/FR-29) — "Remove from list" is the manual way a
// COLD row leaves the working set, and it is a deregistration, not a deletion: the jsonl
// must survive on disk, because Restore from history is how the user takes it back.
// It is also FR-29's second drop gesture, so what the removal takes with it is asserted
// as the Workbench entry, tab set included — the layout key IS that entry since v3.
test('T-LIFE-14: Remove from list drops the row and the registry entry, never the jsonl', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  await startSession(page, env, { title: 'Remove me' })
  const [call] = await waitForCalls(env, 1)
  const row = page.locator('.ws-tab', { hasText: 'Remove me' })

  // a tab of its own, so the removal has a tab set to take with it (FR-29)
  await runIn(page, centerTerm(page), '/open http://127.0.0.1:1/removed')
  await expect
    .poll(() => persistedTabsOnDisk(env, call.sessionId).length, { timeout: 30_000 })
    .toBe(1)

  // a cold row that is still ON the list can only have got there the non-graceful way
  // (a /exit would have removed it outright — T-LIFE-04)
  killSession(call.pid, env)
  await expect(row).toHaveClass(/\bcold\b/, { timeout: 40_000 })
  // FR-25: going cold is NOT a removal — the tab set survives the death and waits for
  // the next resume. That is what makes the removal below the thing that drops it.
  expect(persistedTabsOnDisk(env, call.sessionId)).toHaveLength(1)

  await openMenu(page, row)
  await page.locator('.menu .mi', { hasText: 'Remove from list' }).click()
  await expect(row).toHaveCount(0, { timeout: 20_000 })

  // deregistered, not deleted: the layout entry — the Workbench state and its tabs —
  // is gone, the transcript is not
  await expect
    .poll(() => sessionWorkbenchOnDisk(env, call.sessionId), { timeout: 10_000 })
    .toBeNull()
  const slugDir = path.join(env.home, '.claude', 'projects')
  const jsonl = fs
    .readdirSync(slugDir, { recursive: true })
    .map(String)
    .find((p) => p.endsWith(call.sessionId + '.jsonl'))
  expect(jsonl).toBeTruthy()
  await snap(page, 'T-LIFE-14')
})
