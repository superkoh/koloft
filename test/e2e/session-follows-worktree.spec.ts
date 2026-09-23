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

/**
 * A session follows its worktree.
 *
 * Claude Code has a pair of tools — EnterWorktree / ExitWorktree — that move a whole
 * session into another git checkout mid-conversation. It does that by RENAMING the
 * transcript into another project folder, and it fires no hook: the one way Koloft ever
 * learned a new transcript path never runs. So the panels kept browsing a directory the
 * session had left, the spend froze, and ⇧⌘R said there was no conversation.
 *
 * The fake claude's `/enter-worktree` / `/exit-worktree` do exactly what the real tools do
 * on disk (helpers: one rename, a `relocated` record, a `worktree-state` record, no hook).
 * Everything asserted below is the product's own surface.
 */

/** one row of the Browse tree, by the absolute path it stands for */
function treeRow(page: Page, abs: string, section = 'tree'): Locator {
  return page.locator(`.wb-panel .bv-sec[data-section="${section}"] .ft-node[data-path="${abs}"]`)
}

const subLine = (page: Page, wsName: string): Locator =>
  wsRows(page, wsName).first().locator('.ws-tab-sub')

test('the Workbench, the sidebar and the restart gate all follow the session into a worktree and back', async ({
  env
}) => {
  test.setTimeout(300_000)
  // the repo has to be one before the app reads its workspaces (pattern: aggregate T-AGG-07)
  gitInit(env.workspaces.a)

  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const [call] = await waitForCalls(env, 1)
    // the scratchpad belongs to the folder the session STARTED in — claude does not move
    // it, so this is the fixture for "the panel must not go looking in the new one"
    const scratch = seedScratchpad(env, call.cwd, call.sessionId)

    await showBrowse(page)
    await expect(treeRow(page, env.workspaces.a)).toBeVisible({ timeout: 60_000 })
    await expect(subLine(page, 'ws-a')).toHaveText('main')

    // --- in ----------------------------------------------------------------------
    // the workspace path is already canonical, so this is the spelling the session itself
    // reports (the fixture realpath's what git made)
    const wtDir = path.join(env.workspaces.a, '.claude', 'worktrees', 'wt269')
    await runIn(page, centerTerm(page), '/enter-worktree wt269')
    // said out loud, once, and only because this is the conversation in front of the user
    await expect(page.locator('.toast')).toContainText('wt269', { timeout: 60_000 })
    await expect(subLine(page, 'ws-a')).toHaveText('wt269', { timeout: 30_000 })
    // the panel re-rooted: the tree's own root row IS the worktree now
    await expect(treeRow(page, wtDir)).toBeVisible({ timeout: 60_000 })
    await expect(treeRow(page, env.workspaces.a)).toHaveCount(0)
    // ⇧⌘R's gate: the conversation is still found, at its new address
    expect(
      await page.evaluate((id) => window.api.sessions.transcriptExists(id), call.sessionId)
    ).toBe(true)
    // and the scratchpad column still lists what it listed before the move
    await expect(treeRow(page, scratch.md, 'scratchpad')).toBeVisible({ timeout: 30_000 })
    // the row's menu can still open where the session is
    const menu = await openMenu(page, wsRows(page, 'ws-a').first())
    await expect(menu.locator('.mi', { hasText: 'Reveal in Finder' })).not.toHaveClass(/disabled/)
    await closeMenu(page)

    // --- and back out ------------------------------------------------------------
    // nothing the session writes from here on carries a directory again (measured:
    // 195/195), so the way back is read from the `relocated` record alone
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
    // the second session takes the screen, and keeps it for the whole case
    await startSessionIn(page, 'ws-b')
    await expect(wsRows(page, 'ws-b').first()).toHaveClass(/\bactive\b/, { timeout: 20_000 })

    // the line goes to the ws-a session's own pty, without bringing it to the front —
    // typing into it would, and the point of the case is that it is NOT in front
    await page.evaluate(([id, line]) => window.api.terminal.write(id, line), [
      bgPty,
      '/enter-worktree wt269bg\r'
    ] as [string, string])

    // it really did move — the sidebar says so while the other conversation is on screen.
    // The notice would be up at this very moment (it lives 4s), so checking right here is
    // checking it is not there at all, rather than outliving it.
    await expect(subLine(page, 'ws-a')).toHaveText('wt269bg', { timeout: 60_000 })
    await expect(page.locator('.toast')).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
  }
})
