import path from 'path'
import { test, expect, launchApp } from './helpers/app'
import type { Locator, Page } from '@playwright/test'
import {
  centerTerm,
  closeMenu,
  gitInit,
  openMenu,
  runIn,
  startSessionIn,
  termIds,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'
import { seedScratchpad, showBrowse } from './helpers/workbench'

function treeRow(page: Page, abs: string, section = 'tree'): Locator {
  return page.locator(`.wb-panel .bv-sec[data-section="${section}"] .ft-node[data-path="${abs}"]`)
}

const subLine = (page: Page, wsName: string): Locator =>
  wsRows(page, wsName).first().locator('.ws-tab-sub')

test.describe('a session follows its worktree when Claude moves it mid-conversation with no hook', () => {
  // CC§2
  test('the Workbench, the sidebar and the restart gate all follow the session into a worktree and back', async ({
    env
  }) => {
    test.setTimeout(300_000)
    gitInit(env.workspaces.a)

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      const [call] = await waitForCalls(env, 1)
      const scratch = seedScratchpad(env, call.cwd, call.sessionId)

      await showBrowse(page)
      await expect(treeRow(page, env.workspaces.a)).toBeVisible({ timeout: 60_000 })
      await expect(subLine(page, 'ws-a')).toHaveText('main')

      const wtDir = path.join(env.workspaces.a, '.claude', 'worktrees', 'wt269')
      await runIn(page, centerTerm(page), '/enter-worktree wt269')
      await expect(page.locator('.toast')).toContainText('wt269', { timeout: 60_000 })
      await expect(subLine(page, 'ws-a')).toHaveText('wt269', { timeout: 30_000 })
      await expect(treeRow(page, wtDir)).toBeVisible({ timeout: 60_000 })
      await expect(treeRow(page, env.workspaces.a)).toHaveCount(0)
      expect(
        await page.evaluate((id) => window.api.sessions.transcriptExists(id), call.sessionId)
      ).toBe(true)
      await expect(treeRow(page, scratch.md, 'scratchpad')).toBeVisible({ timeout: 30_000 })
      const menu = await openMenu(page, wsRows(page, 'ws-a').first())
      await expect(menu.locator('.mi', { hasText: 'Reveal in Finder' })).not.toHaveClass(/disabled/)
      await closeMenu(page)

      // CC§4
      await runIn(page, centerTerm(page), '/exit-worktree')
      await expect(subLine(page, 'ws-a')).toHaveText('main', { timeout: 60_000 })
      await expect(treeRow(page, env.workspaces.a)).toBeVisible({ timeout: 60_000 })
      await expect(treeRow(page, wtDir)).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('a session that moves in the background says nothing — the panels in front did not move', async ({
    env
  }) => {
    test.setTimeout(300_000)
    gitInit(env.workspaces.a)

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      const [bgPty] = await termIds(page)
      await startSessionIn(page, 'ws-b')
      await expect(wsRows(page, 'ws-b').first()).toHaveClass(/\bactive\b/, { timeout: 20_000 })

      await page.evaluate(([id, line]) => window.api.terminal.write(id, line), [
        bgPty,
        '/enter-worktree wt269bg\r'
      ] as [string, string])

      await expect(subLine(page, 'ws-a')).toHaveText('wt269bg', { timeout: 60_000 })
      await expect(page.locator('.toast')).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
    }
  })
})
