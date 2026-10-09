import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  FAKE_SESSION_TITLE,
  gitCommitAll,
  gitInit,
  openWorktreeSession,
  resumedId,
  sendShortcut,
  waitBooted,
  waitForCalls
} from './helpers/p1'
import { portOffset } from '../../src/shared/worktreeName'

// CC§9 ADR-0026
test.describe('the first session in a newly added repo is a worktree session', () => {
  test('in a repo Claude was never trusted in, the worktree session starts and the repo is trusted from then on', async ({
    env
  }) => {
    test.setTimeout(120_000)
    gitInit(env.workspaces.a)
    const claudeJson = path.join(env.home, '.claude.json')
    fs.writeFileSync(claudeJson, JSON.stringify({ numStartups: 1, projects: {} }))

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)
      const dlg = await openWorktreeSession(page, 'ws-a')
      await dlg.getByRole('textbox').click()
      await page.keyboard.type('feat1')
      await page.keyboard.press('Enter')
      await expect(dlg).toHaveCount(0)

      const row = page.locator('.ws-tab', { hasText: FAKE_SESSION_TITLE })
      await expect.poll(async () => row.isVisible(), { timeout: 30_000 }).toBe(true)
      await expect(row.locator('.ws-tab-sub')).toHaveText('feat1')

      const doc = JSON.parse(fs.readFileSync(claudeJson, 'utf8'))
      expect(doc.numStartups).toBe(1)
      expect(doc.projects[fs.realpathSync(env.workspaces.a)]).toEqual({
        hasTrustDialogAccepted: true
      })
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('a worktree session runs with its worktree’s port offset, and when Koloft rebuilds the deleted worktree it copies in the ignored files .worktreeinclude lists', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const ws = env.workspaces.a
    gitInit(ws)
    fs.writeFileSync(path.join(ws, '.gitignore'), 'NOTES.md\n.env\n')
    fs.writeFileSync(path.join(ws, '.worktreeinclude'), '.env\n')
    gitCommitAll(ws)
    fs.writeFileSync(path.join(ws, '.env'), 'PORT=3000\n')

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const dlg = await openWorktreeSession(page, 'ws-a')
      await dlg.getByRole('textbox').click()
      await page.keyboard.type('feat2')
      await page.keyboard.press('Enter')
      await expect(dlg).toHaveCount(0)

      const row = page.locator('.ws-tab', { hasText: FAKE_SESSION_TITLE })
      await expect(row).toHaveClass(/st-waiting|st-idle/, { timeout: 60_000 })
      const [first] = await waitForCalls(env, 1)
      expect(first.portOffset).toBe(String(portOffset('feat2')))

      await row.click()
      await sendShortcut(app, 'shortcut:close-tab')
      const confirm = page.locator('.modal', { hasText: 'Close running session?' })
      if (await confirm.isVisible({ timeout: 4000 }).catch(() => false)) {
        await confirm
          .locator('.btn-primary, button', { hasText: /^Close$/ })
          .first()
          .click()
      }
      await expect(row).toHaveClass(/\bcold\b/, { timeout: 60_000 })
      const wtDir = path.join(ws, '.claude', 'worktrees', 'feat2')
      execFileSync('git', ['-C', ws, 'worktree', 'remove', '--force', '--force', wtDir])
      expect(fs.existsSync(wtDir)).toBe(false)

      await row.click()
      const calls = await waitForCalls(env, 2, 60_000)
      expect(resumedId(calls[calls.length - 1])).toBe(first.sessionId)
      expect(fs.readFileSync(path.join(wtDir, '.env'), 'utf8')).toBe('PORT=3000\n')
    } finally {
      await quitAndClose(app)
    }
  })
})
