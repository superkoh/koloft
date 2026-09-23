import fs from 'fs'
import path from 'path'
import { test, expect, launchApp } from './helpers/app'
import { FAKE_SESSION_TITLE, gitInit, openWorktreeSession, waitBooted } from './helpers/p1'

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
})
