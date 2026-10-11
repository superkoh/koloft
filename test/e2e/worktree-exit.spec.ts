import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { rowsWithSub } from './helpers/blackbox'
import { runGit } from './helpers/gitFixture'
import {
  FAKE_SESSION_TITLE,
  gitInit,
  openWorktreeSession,
  startSessionIn,
  terminalText,
  waitBooted
} from './helpers/p1'

const REMOVAL_STILL_RUNNING_FOR_MS = 8000
const REMOVAL_KOLOFT_QUITS_DURING_MS = 60_000

function worktreeRow(page: Page, name: string) {
  return rowsWithSub(page, 'ws-a', name)
}

async function startWorktreeSession(page: Page, name: string): Promise<string> {
  const dlg = await openWorktreeSession(page, 'ws-a')
  await dlg.getByRole('textbox').click()
  await page.keyboard.type(name)
  await page.keyboard.press('Enter')
  await expect(dlg).toHaveCount(0)
  const row = worktreeRow(page, name)
  await expect(row).toHaveClass(/st-waiting|st-idle/, { timeout: 60_000 })
  await expect(row).toHaveAttribute('data-tab-id', /.+/)
  return (await row.getAttribute('data-tab-id'))!
}

function type(page: Page, tabId: string, line: string): Promise<void> {
  return page.evaluate(([id, text]) => window.api.terminal.write(id, text + '\r'), [
    tabId,
    line
  ] as const)
}

async function exitChoosingRemove(page: Page, tabId: string): Promise<void> {
  await type(page, tabId, '/exit')
  await expect
    .poll(() => terminalText(page, tabId), { timeout: 15_000 })
    .toContain('Remove worktree')
  await type(page, tabId, '2')
}

function branchExists(repo: string, branch: string): boolean {
  return runGit(repo, 'branch', '--list', branch).trim() !== ''
}

// CC§4
test.describe('leaving a worktree session with /exit', () => {
  test('its row and tab go away as soon as Claude Code starts removing the worktree, while the removal still runs, and the worktree and its branch are gone once it ends', async ({
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    fs.writeFileSync(
      path.join(env.home, 'fake-claude-remove-ms'),
      String(REMOVAL_STILL_RUNNING_FOR_MS)
    )
    const wt = path.join(env.workspaces.a, '.claude', 'worktrees', 'leaving')
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      const tabId = await startWorktreeSession(page, 'leaving')
      await worktreeRow(page, 'leaving').click()

      await exitChoosingRemove(page, tabId)
      await expect(worktreeRow(page, 'leaving')).toHaveCount(0, { timeout: 4000 })
      expect(fs.existsSync(wt)).toBe(true)
      await expect(
        page.locator('.ws-tab.active', { hasText: FAKE_SESSION_TITLE }).locator('.ws-tab-sub')
      ).toHaveText('main')

      await expect.poll(() => fs.existsSync(wt), { timeout: 30_000 }).toBe(false)
      expect(branchExists(env.workspaces.a, 'worktree-leaving')).toBe(false)
      await expect(worktreeRow(page, 'leaving')).toHaveCount(0)
    } finally {
      await quitAndClose(app).catch(() => {})
    }
  })

  test('when Claude Code cannot remove the worktree, Koloft shows the line it printed', async ({
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    fs.writeFileSync(path.join(env.home, 'fake-claude-remove-fails'), '')
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const tabId = await startWorktreeSession(page, 'stuck')
      await worktreeRow(page, 'stuck').click()

      await exitChoosingRemove(page, tabId)
      await expect(
        page.locator('.toast .toast-msg', {
          hasText:
            /Claude Code did not remove the worktree: Could not finish removing the worktree at .*stuck/
        })
      ).toBeVisible({ timeout: 10_000 })
      expect(fs.existsSync(path.join(env.workspaces.a, '.claude', 'worktrees', 'stuck'))).toBe(true)
    } finally {
      await quitAndClose(app).catch(() => {})
    }
  })

  // PLATFORM§41
  test('quitting Koloft while Claude Code is removing the worktree still leaves no worktree folder, registration or branch behind', async ({
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    fs.writeFileSync(
      path.join(env.home, 'fake-claude-remove-ms'),
      String(REMOVAL_KOLOFT_QUITS_DURING_MS)
    )
    const wt = path.join(env.workspaces.a, '.claude', 'worktrees', 'cut')
    const app = await launchApp(env)
    const page = await app.firstWindow()
    await waitBooted(page)
    const tabId = await startWorktreeSession(page, 'cut')
    await worktreeRow(page, 'cut').click()
    await exitChoosingRemove(page, tabId)
    await expect(worktreeRow(page, 'cut')).toHaveCount(0, { timeout: 4000 })

    await quitAndClose(app)
    await expect.poll(() => fs.existsSync(wt), { timeout: 30_000 }).toBe(false)
    await expect
      .poll(() => branchExists(env.workspaces.a, 'worktree-cut'), { timeout: 10_000 })
      .toBe(false)
    expect(runGit(env.workspaces.a, 'worktree', 'list', '--porcelain')).not.toContain(
      path.join(fs.realpathSync(env.workspaces.a), '.claude', 'worktrees', 'cut')
    )
  })
})
