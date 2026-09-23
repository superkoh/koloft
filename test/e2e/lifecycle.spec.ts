import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
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
  processAlive,
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

const SILENCE_LONGER_THAN_TWO_LIVENESS_SWEEPS_OF_2500_MS = 8000
const ROOM_FOR_A_WRONG_REMOVAL_OR_REBIND_MS = 5000
const DEBOUNCED_WRITES_LAND_MS = 1500
const ROOM_FOR_A_RESPAWN_MS = 2000
const ROOM_FOR_A_LATER_TRANSITION_MS = 3000

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

test.describe('Session lifecycle · go-cold paths, cold-row resume, cold restart, statusless lightbar, menus as the operation surface', () => {
  test('T-LIFE-04 / WB-T15: /exit removes the row and its Workbench entry (jsonl kept); kill -9 leaves it cold in place; the next session starts on a clean strip', async ({
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

    killSession(hard.pid, env)
    await expect(hardRow).toHaveClass(/\bcold\b/, { timeout: 30_000 })

    await gracefulRow.click()
    await expect(centerTerm(page)).toBeVisible()
    await runIn(page, centerTerm(page), '/open http://127.0.0.1:1/graceful')
    await expect
      .poll(() => persistedTabsOnDisk(env, graceful.sessionId).length, { timeout: 30_000 })
      .toBe(1)
    // CC§1
    await runIn(page, centerTerm(page), '/exit')
    await expect(gracefulRow).toHaveCount(0, { timeout: 30_000 })
    await expect
      .poll(() => sessionWorkbenchOnDisk(env, graceful.sessionId), { timeout: 20_000 })
      .toBeNull()

    const jsonl = fs
      .readdirSync(path.join(env.home, '.claude', 'projects'), { recursive: true })
      .map(String)
      .find((p) => p.endsWith(graceful.sessionId + '.jsonl'))
    expect(jsonl).toBeTruthy()

    await expect(page.locator('.ws-tab')).toHaveCount(1)
    await expect(
      page.locator('.ws-tab.st-working, .ws-tab.st-waiting, .ws-tab.st-approval, .ws-tab.st-idle')
    ).toHaveCount(0)
    await snap(page, 'T-LIFE-04')

    await startSession(page, env, { title: 'After the exit' })
    await expect(wbTabs(page)).toHaveCount(1)
  })

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

  test('T-LIFE-15: a SIGHUP reports SessionEnd(other) and the row stays, cold', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await startSession(page, env, { title: 'Hangup session' })
    const [call] = await waitForCalls(env, 1)
    const row = page.locator('.ws-tab', { hasText: 'Hangup session' })

    await row.click()
    await expect.poll(() => pendingAttention(page), { timeout: 20_000 }).toHaveLength(0)

    // CC§1
    process.kill(call.pid, 'SIGHUP')
    await expect(row).toHaveClass(/\bcold\b/, { timeout: 40_000 })
    await expect(page.locator('.ws-tab')).toHaveCount(1)

    await page.waitForTimeout(SILENCE_LONGER_THAN_TWO_LIVENESS_SWEEPS_OF_2500_MS)
    expect(await pendingAttention(page)).toHaveLength(0)
    await expect(page.locator('.ws-tab')).toHaveCount(1)
    await expect(row).toHaveClass(/\bcold\b/)
  })

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

    // CC§1
    await runIn(page, centerTerm(page), '/compact')
    await expect(centerTerm(page)).toContainText(`compacted -> session ${call.sessionId}`, {
      timeout: 30_000
    })

    await page.waitForTimeout(ROOM_FOR_A_WRONG_REMOVAL_OR_REBIND_MS)
    await expect(page.locator('.ws-tab')).toHaveCount(1)
    await expect(row).not.toHaveClass(/\bcold\b/)
    expect(readCalls(env)).toHaveLength(1)
    expect((layoutOnDisk(env).sessions as Record<string, unknown>)[call.sessionId]).toBeTruthy()
  })

  test('T-LIFE-05: a session that dies closes its tab, says killed by signal in a toast, and leaves a cold, unselected row', async ({
    page,
    env
  }) => {
    test.setTimeout(240_000)
    gitInit(env.workspaces.a)
    await startSessionIn(page, 'ws-a')
    const [session] = await waitForCalls(env, 1)
    const row = wsRows(page, 'ws-a').first()
    await expect(row).toHaveClass(/\bactive\b/)

    killSession(session.pid, env)
    // PLATFORM§29
    await expect(page.locator('.toast-msg')).toContainText('killed by signal', { timeout: 20_000 })
    await expect(page.locator('.term-island .term-wrap')).toHaveCount(0, { timeout: 20_000 })
    await expect(page.locator('.w-empty')).toBeVisible({ timeout: 20_000 })
    await expect(row).toHaveClass(/\bcold\b/, { timeout: 40_000 })
    await expect(row).not.toHaveClass(/\bactive\b/)

    await snap(page, 'T-LIFE-05')
  })

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

    fs.writeFileSync(env.claudeDelayFile, '3000')
    const app2 = await launchApp(env)
    try {
      const page2 = await app2.firstWindow()
      await page2.waitForLoadState('domcontentloaded')
      const row = page2.locator('.ws-tab', { hasText: 'Fake session: project notes' })
      await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })
      await row.click()

      const mask = page2.locator('.term-wrap:visible .empty', {
        hasText: 'Resuming Claude session…'
      })
      await expect(mask).toBeVisible({ timeout: 10_000 })
      await expect(row).toHaveClass(/\bst-pending\b/)
      await expect(row).toHaveClass(/\bactive\b/)
      await snap(page2, 'T-LIFE-06')

      const calls = await waitForCalls(env, 2)
      expect(resumedId(calls[1])).toBe(first.sessionId)
      expect(calls[1].cwd).toBe(env.workspaces.a)

      await expect(mask).toHaveCount(0, { timeout: 30_000 })
      await expect(row).not.toHaveClass(/\bcold\b/, { timeout: 30_000 })
    } finally {
      await app2.close().catch(() => {})
    }
  })

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

      const mask = page.locator('.terminals .empty', { hasText: 'Resuming Claude session…' })
      await expect(mask).toBeVisible({ timeout: 1500 })
      await expect(mask).toContainText('Slow to plan session')
      expect(fs.existsSync(stallDone)).toBe(false)
      await expect(row).toHaveClass(/\bactive\b/)
      await expect(row).toHaveClass(/\bst-pending\b/)
      expect(readCalls(env)).toHaveLength(0)
      await snap(page, 'T-LIFE-18')

      const calls = await waitForCalls(env, 1)
      expect(resumedId(calls[0])).toBe(id)
      await expect(mask).toHaveCount(0, { timeout: 30_000 })
      await expect(row).not.toHaveClass(/\bcold\b/, { timeout: 30_000 })
      await expect(row).toHaveClass(/\bactive\b/)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('the worktree-anomaly resume dialog focuses "Resume in new worktree", never the destructive button, and Esc cancels the resume', async ({
    env
  }) => {
    test.setTimeout(120_000)
    gitInit(env.workspaces.a)
    const wt = gitWorktreeAdd(env.workspaces.a, 'drifted')
    execFileSync('git', ['checkout', '-q', '-b', 'somewhere-else'], { cwd: wt })
    seedJsonl(env, env.workspaces.a, {
      summary: 'Drifted worktree session',
      cwd: env.workspaces.a,
      worktreeState: { worktreeName: 'drifted', worktreePath: wt, originalCwd: env.workspaces.a }
    })

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      const row = page.locator('.ws-tab', { hasText: 'Drifted worktree session' })
      await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })
      await row.click()

      const dialog = page.locator('.modal.lifecycle-modal')
      await expect(dialog.locator('.modal-header')).toHaveText(
        'Resume "Drifted worktree session"',
        { timeout: 20_000 }
      )
      await expect(dialog.getByRole('button', { name: /^Resume in new worktree/ })).toBeFocused()

      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(
        page.locator('.terminals .empty', { hasText: 'Resuming Claude session…' })
      ).toHaveCount(0)
      await expect(row).toHaveClass(/\bcold\b/)
      expect(readCalls(env)).toHaveLength(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('the could-not-rebuild resume dialog focuses Cancel, never "Resume in main without isolation", and Esc cancels the resume', async ({
    env
  }) => {
    test.setTimeout(120_000)
    gitInit(env.workspaces.a)
    seedJsonl(env, env.workspaces.a, {
      summary: 'Unrebuildable session',
      cwd: env.workspaces.a,
      worktreeState: {
        worktreeName: 'gone',
        worktreePath: path.join(env.workspaces.a, 'not-a-worktree-home', 'gone'),
        originalCwd: env.workspaces.a
      }
    })

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      const row = page.locator('.ws-tab', { hasText: 'Unrebuildable session' })
      await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })
      await row.click()

      const dialog = page.locator('.modal.lifecycle-modal')
      await expect(dialog.locator('.modal-header')).toHaveText('Could not rebuild the worktree', {
        timeout: 20_000
      })
      await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()

      await page.keyboard.press('Escape')
      await expect(dialog).toHaveCount(0)
      await expect(
        page.locator('.terminals .empty', { hasText: 'Resuming Claude session…' })
      ).toHaveCount(0)
      await expect(row).toHaveClass(/\bcold\b/)
      expect(readCalls(env)).toHaveLength(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('T-LIFE-09: after an app restart nothing runs, nothing is selected, nothing was persisted', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const app1 = await launchApp(env)
    const page1 = await app1.firstWindow()
    await page1.waitForLoadState('domcontentloaded')
    await startSession(page1, env)
    await page1.waitForTimeout(DEBOUNCED_WRITES_LAND_MS)
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
        page2.locator(
          '.ws-tab.st-working, .ws-tab.st-waiting, .ws-tab.st-approval, .ws-tab.st-idle'
        )
      ).toHaveCount(0)
      await expect(page2.locator('.center')).toContainText('No running session')
      await page2.waitForTimeout(ROOM_FOR_A_RESPAWN_MS)
      expect(readCalls(env)).toHaveLength(1)

      const layout = layoutOnDisk(env)
      expect(layout.version).toBe(4)
      expect(layout).not.toHaveProperty('activeSessionId')
      expect(layout).not.toHaveProperty('tabs')
      await snap(page2, 'T-LIFE-09')
    } finally {
      await app2.close().catch(() => {})
    }
  })

  test('T-LIFE-10: a bound session that never reports a run-state shows the st-idle bar', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(120_000)
    fs.writeFileSync(env.claudeNoStatusFile, '')
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')

    const row = page.locator('.ws-tab')
    await expect(row).toHaveCount(1, { timeout: 40_000 })
    await expect(row).toHaveClass(/\bst-idle\b/)
    await page.waitForTimeout(ROOM_FOR_A_LATER_TRANSITION_MS)
    await expect(row).toHaveClass(/\bst-idle\b/)
    await expect(
      page.locator('.ws-tab.st-working, .ws-tab.st-waiting, .ws-tab.st-approval')
    ).toHaveCount(0)
    await snap(page, 'T-LIFE-10')
  })

  test("T-LIFE-11: right-click menus carry exactly the per-kind sets, with the A2 negatives, and a running row's Close leaves it cold in place", async ({
    env
  }) => {
    test.setTimeout(180_000)
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

      await openMenu(page, page.locator('.ws-tab', { hasText: 'Running menu session' }))
      const running = await menuItemTexts(page)
      expect(running).toEqual(['Reveal in Finder', 'Copy session ID', 'Close'])
      for (const t of running) expect(t).not.toMatch(/remove from list/i)
      noForbidden(running)
      await closeMenu(page)

      const coldMenu = await openMenu(page, coldRow)
      expect((await coldMenu.locator('.mi.head').textContent())?.trim()).toMatch(/^\d+[smhd] ago$/)
      const cold = await menuItemTexts(page)
      expect(cold).toEqual(['Resume↩', 'Reveal in Finder', 'Copy session ID', 'Remove from list'])
      for (const t of cold) expect(t).not.toMatch(/close|delete/i)
      noForbidden(cold)
      await snap(page, 'T-LIFE-11')
      await closeMenu(page)

      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      const ws = await menuItemTexts(page)
      expect(ws).toEqual([
        'New session⌘N',
        'Restore session…',
        'Scheduled jobs…',
        'Remove workspace'
      ])
      noForbidden(ws)
      await closeMenu(page)

      const [session] = await waitForCalls(env, 1)
      const runningRow = page.locator('.ws-tab', { hasText: 'Running menu session' })
      await openMenu(page, runningRow)
      await page.locator('.menu .mi', { hasText: /^Close$/ }).click()
      await expect(runningRow).toHaveClass(/\bcold\b/, { timeout: 20_000 })
      await expect.poll(() => processAlive(session.pid), { timeout: 15_000 }).toBe(false)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('T-LIFE-14 / WB-T15: Remove from list drops the cold row and its registry entry with its tabs (which survived going cold), never the jsonl', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await startSession(page, env, { title: 'Remove me' })
    const [call] = await waitForCalls(env, 1)
    const row = page.locator('.ws-tab', { hasText: 'Remove me' })

    await runIn(page, centerTerm(page), '/open http://127.0.0.1:1/removed')
    await expect
      .poll(() => persistedTabsOnDisk(env, call.sessionId).length, { timeout: 30_000 })
      .toBe(1)

    killSession(call.pid, env)
    await expect(row).toHaveClass(/\bcold\b/, { timeout: 40_000 })
    expect(persistedTabsOnDisk(env, call.sessionId)).toHaveLength(1)

    await openMenu(page, row)
    await page.locator('.menu .mi', { hasText: 'Remove from list' }).click()
    await expect(row).toHaveCount(0, { timeout: 20_000 })

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
})
