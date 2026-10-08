import fs from 'fs'
import path from 'path'
import type { Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { installCodex, seedSettings } from './helpers/env'
import { runGit, setupGitFixture } from './helpers/gitFixture'
import { installStallingGit } from './helpers/gitSpawnLog'
import {
  centerTerm,
  newSessionInWith,
  openMenu,
  openSessionTerminal,
  openWorktreeSession,
  panelTerm,
  readCalls,
  runIn,
  startSessionIn,
  waitBooted,
  waitForCalls,
  wsGroup,
  wsRows
} from './helpers/p1'

const CENTER = '.term-island .term-wrap'
const PANEL = '.wb-panel .wb-term'
const KOLOFT_SHIM_WAITS_UP_TO_10S_PLUS_ROOM_MS = 30_000
const HOLD_KID_BEFORE_IT_BINDS_MS = 5_000
const A_WORKTREE_REMOVAL_SLOWER_THAN_A_QUICK_GIT_CALL_MS = 7_000

function shownTermText(page: Page, box: string): Promise<string> {
  return page.evaluate((sel) => {
    const terms =
      (
        window as unknown as {
          __koloftTerms?: Record<
            string,
            {
              element?: HTMLElement
              buffer: {
                active: {
                  length: number
                  getLine(
                    i: number
                  ): { isWrapped: boolean; translateToString(trim?: boolean): string } | undefined
                }
              }
            }
          >
        }
      ).__koloftTerms ?? {}
    for (const t of Object.values(terms)) {
      const wrap = t.element?.closest(sel)
      if (!t.element || !wrap || wrap.getClientRects().length === 0) continue
      if (getComputedStyle(t.element).visibility === 'hidden') continue
      const b = t.buffer.active
      let text = ''
      for (let i = 0; i < b.length; i++) {
        const line = b.getLine(i)
        if (!line) continue
        text += (i === 0 || line.isWrapped ? '' : '\n') + line.translateToString(true)
      }
      return text
    }
    return ''
  }, box)
}

async function koloftExits(page: Page): Promise<string[]> {
  const text = await shownTermText(page, CENTER)
  return [...text.matchAll(/\[fake-(?:claude|codex)\] koloft exit=(\d+)/g)].map((m) => m[1])
}

async function koloftInSession(page: Page, args: string): Promise<string> {
  const before = (await koloftExits(page)).length
  await runIn(page, centerTerm(page), `/koloft ${args}`)
  await expect
    .poll(async () => (await koloftExits(page)).length, {
      timeout: KOLOFT_SHIM_WAITS_UP_TO_10S_PLUS_ROOM_MS
    })
    .toBe(before + 1)
  return (await koloftExits(page))[before]
}

async function openCron(page: Page, wsName: string): Promise<Locator> {
  await openMenu(page, page.locator('.ws-head', { hasText: wsName }))
  await page.locator('.menu .mi', { hasText: 'Scheduled jobs' }).click()
  const dlg = page.locator('.modal.cronjobs')
  await expect(dlg).toBeVisible({ timeout: 15_000 })
  return dlg
}

test.describe('`koloft` inside a Koloft tab: the command Koloft puts on PATH reaches Koloft and acts for the session it runs in', () => {
  test('koloft cron add from a session adds a job to its pinned workspace, shown in Scheduled jobs and in koloft cron list', async ({
    page
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')

    expect(await koloftInSession(page, 'cron add --name Standup --daily 09:00 -- say hi')).toBe('0')
    expect(await koloftInSession(page, 'cron list')).toBe('0')
    expect(await shownTermText(page, CENTER)).toMatch(/^1\. Standup · /m)

    const dlg = await openCron(page, 'ws-a')
    await expect(
      dlg.locator('.job-row').filter({ has: page.locator('.job-name', { hasText: /^Standup$/ }) })
    ).toHaveCount(1)
  })

  test('koloft session new starts a named sibling in the same workspace, titled by its task, nested under the caller while it is still starting, and leaves the caller on screen', async ({
    page,
    env
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const callerTabId = await wsRows(page, 'ws-a').first().getAttribute('data-tab-id')
    expect(callerTabId).toBeTruthy()
    const callsBefore = readCalls(env).length
    const caller = wsGroup(page, 'ws-a').locator(`.ws-tab[data-tab-id="${callerTabId}"]`)
    const nested = wsGroup(page, 'ws-a').locator(
      `.ws-tab[data-tab-id="${callerTabId}"] + .ws-subtabs > .ws-tab`
    )
    fs.writeFileSync(path.join(env.home, 'fake-claude-delay'), String(HOLD_KID_BEFORE_IT_BINDS_MS))

    expect(await koloftInSession(page, 'session new --name kid -- hello')).toBe('0')

    await expect(nested).toHaveClass(/\bst-pending\b/, { timeout: 30_000 })
    await expect(wsRows(page, 'ws-a')).toHaveCount(2)
    const calls = await waitForCalls(env, callsBefore + 1, 60_000)
    const kid = calls[calls.length - 1]
    expect(kid.argv[kid.argv.indexOf('--name') + 1]).toBe('kid')
    expect(kid.firstPrompt).toMatch(/\n\nhello$/)
    await expect(nested).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
    await expect(nested.locator('.ws-tab-title', { hasText: /^hello$/ })).toHaveCount(1, {
      timeout: 30_000
    })
    await expect(wsGroup(page, 'ws-a').locator('.ws-tab.active')).toHaveAttribute(
      'data-tab-id',
      callerTabId!
    )

    await expect(nested.locator('.ws-tab-unread')).toHaveCount(1, { timeout: 30_000 })
    await caller.locator('.ws-tab-fold').click()
    await expect(nested).toHaveCount(0)
    await expect(caller.locator('.ws-unread-count')).toHaveText('1')
    await expect(caller.locator('.ws-tab-parked:not(.ws-unread-count)')).toHaveText('1')
    await caller.locator('.ws-tab-fold').click()
    await expect(nested).toHaveCount(1)
    await expect(caller.locator('.ws-tab-parked')).toHaveCount(0)
  })

  test('a Codex session started by koloft session new in a Codex session is nested under it', async ({
    env
  }) => {
    test.setTimeout(120_000)
    installCodex(env)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await newSessionInWith(page, 'ws-a', 'Codex')
      const caller = wsRows(page, 'ws-a')
      await expect(caller).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      const callerTabId = await caller.getAttribute('data-tab-id')

      expect(await koloftInSession(page, 'session new -- hello')).toBe('0')

      await expect(
        wsGroup(page, 'ws-a').locator(
          `.ws-tab[data-tab-id="${callerTabId}"] + .ws-subtabs > .ws-tab`
        )
      ).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      await expect(wsRows(page, 'ws-a')).toHaveCount(2)
    } finally {
      await quitAndClose(app)
    }
  })

  test('koloft session new --workspace starts the sibling in another sidebar workspace, as a top-level row there', async ({
    page,
    env
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const callsBefore = readCalls(env).length

    expect(await koloftInSession(page, 'session new --workspace ws-b --name kid -- hello')).toBe(
      '0'
    )

    await expect(wsRows(page, 'ws-b')).toHaveCount(1, { timeout: 60_000 })
    const calls = await waitForCalls(env, callsBefore + 1, 60_000)
    expect(calls[calls.length - 1].cwd).toMatch(/\/ws-b$/)
    await expect(wsRows(page, 'ws-a')).toHaveCount(1)
    await expect(wsGroup(page, 'ws-b').locator('.ws-tabs > .ws-tab')).toHaveCount(1)
  })

  test("koloft in a session's Workbench shell acts for the session that owns the shell", async ({
    app,
    page
  }) => {
    test.setTimeout(180_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await openSessionTerminal(app, page)

    await runIn(page, panelTerm(page), 'koloft help; echo "help-exit=$?"')
    await expect
      .poll(async () => /help-exit=(\d+)/.exec(await shownTermText(page, PANEL))?.[1], {
        timeout: KOLOFT_SHIM_WAITS_UP_TO_10S_PLUS_ROOM_MS
      })
      .toBe('0')
  })

  test('koloft session close refuses while the worktree holds uncommitted work, then closes the session for good: tab, row, worktree and branch, even when removing the worktree takes longer than a few seconds', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const fx = setupGitFixture(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      const dlg = await openWorktreeSession(page, 'repo')
      await dlg.getByRole('textbox').click()
      await page.keyboard.type('done')
      await page.keyboard.press('Enter')
      const rows = wsRows(page, 'repo')
      await expect(rows).toHaveCount(1, { timeout: 60_000 })
      await expect(rows).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      const tree = path.join(fx.clone, '.claude', 'worktrees', 'done')
      await expect.poll(() => fs.existsSync(path.join(tree, 'NOTES.md'))).toBe(true)

      expect(await koloftInSession(page, 'session close')).toBe('1')
      expect(await shownTermText(page, CENTER)).toContain('nothing was closed')
      await expect(rows).toHaveCount(1)
      expect(fs.existsSync(tree)).toBe(true)

      fs.rmSync(path.join(tree, 'NOTES.md'))
      installStallingGit(env, {
        root: fx.clone,
        subcommand: 'worktree',
        verb: 'remove',
        lastArg: tree,
        ms: A_WORKTREE_REMOVAL_SLOWER_THAN_A_QUICK_GIT_CALL_MS
      })
      await runIn(page, centerTerm(page), '/koloft session close')
      await expect(rows).toHaveCount(0, { timeout: 30_000 })
      await expect.poll(() => fs.existsSync(tree), { timeout: 30_000 }).toBe(false)
      expect(runGit(fx.clone, 'branch', '--list', 'worktree-done').trim()).toBe('')
      expect(runGit(fx.clone, 'worktree', 'list')).not.toContain('done')
    } finally {
      await quitAndClose(app)
    }
  })

  test('koloft session close <child> closes a session the caller started in a worktree, only once nothing in it would be lost, and leaves the caller open', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const fx = setupGitFixture(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      const dlg = await openWorktreeSession(page, 'repo')
      await dlg.getByRole('textbox').click()
      await page.keyboard.type('parent')
      await page.keyboard.press('Enter')
      const rows = wsRows(page, 'repo')
      await expect(rows).toHaveCount(1, { timeout: 60_000 })
      await expect(rows).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      const callerTabId = await rows.getAttribute('data-tab-id')
      expect(await koloftInSession(page, 'session new -w kid --name kid -- hello')).toBe('0')
      await expect(rows).toHaveCount(2, { timeout: 60_000 })
      const child = rows.and(page.locator(`.ws-tab:not([data-tab-id="${callerTabId}"])`))
      await expect(child).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      const childTabId = await child.getAttribute('data-tab-id')
      const tree = path.join(fx.clone, '.claude', 'worktrees', 'kid')
      expect(fs.existsSync(tree)).toBe(true)

      fs.writeFileSync(path.join(tree, 'left-behind.txt'), 'not committed')
      expect(await koloftInSession(page, `session close ${childTabId}`)).toBe('1')
      expect(await shownTermText(page, CENTER)).toContain('left-behind.txt')
      await expect(rows).toHaveCount(2)

      fs.rmSync(path.join(tree, 'left-behind.txt'))
      expect(await koloftInSession(page, `session close ${childTabId}`)).toBe('0')
      await expect(rows).toHaveCount(1, { timeout: 30_000 })
      await expect(rows).toHaveAttribute('data-tab-id', callerTabId!)
      await expect.poll(() => fs.existsSync(tree), { timeout: 30_000 }).toBe(false)
      expect(runGit(fx.clone, 'branch', '--list', 'worktree-kid').trim()).toBe('')
    } finally {
      await quitAndClose(app)
    }
  })

  test('koloft session close <child> still reaches a child its parent started before Koloft restarted, now a cold row still nested under it', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const fx = setupGitFixture(env)
    const rowOf = (page: Page, worktree: string): Locator =>
      wsRows(page, 'repo').filter({
        has: page.locator('.ws-tab-sub', { hasText: new RegExp(`^${worktree}$`) })
      })
    const before = await launchApp(env)
    try {
      const page = await before.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      const dlg = await openWorktreeSession(page, 'repo')
      await dlg.getByRole('textbox').click()
      await page.keyboard.type('parent')
      await page.keyboard.press('Enter')
      await expect(rowOf(page, 'parent')).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      expect(await koloftInSession(page, 'session new -w kid --name kid -- hello')).toBe('0')
      await expect(rowOf(page, 'kid')).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
    } finally {
      await quitAndClose(before)
    }
    const kid = readCalls(env).find((c) => c.argv.includes('kid'))!
    const tree = path.join(fx.clone, '.claude', 'worktrees', 'kid')

    const after = await launchApp(env)
    try {
      const page = await after.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      await expect(rowOf(page, 'kid')).toHaveClass(/\bcold\b/, { timeout: 30_000 })
      await expect(
        wsGroup(page, 'repo').locator('.ws-subtabs > .ws-tab', {
          has: page.locator('.ws-tab-sub', { hasText: /^kid$/ })
        })
      ).toHaveCount(1)
      await rowOf(page, 'parent').click()
      await expect(rowOf(page, 'parent')).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })

      expect(await koloftInSession(page, `session close ${kid.sessionId}`)).toBe('0')
      await expect(rowOf(page, 'kid')).toHaveCount(0, { timeout: 30_000 })
      await expect(rowOf(page, 'parent')).toHaveCount(1)
      await expect.poll(() => fs.existsSync(tree), { timeout: 30_000 }).toBe(false)
      expect(runGit(fx.clone, 'branch', '--list', 'worktree-kid').trim()).toBe('')
    } finally {
      await quitAndClose(after)
    }
  })

  test('with agent tools off in Settings, koloft in a new session is refused', async ({ env }) => {
    test.setTimeout(120_000)
    seedSettings(env, { agentTools: false })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')

      expect(await koloftInSession(page, 'help')).not.toBe('0')
    } finally {
      await quitAndClose(app)
    }
  })
})
