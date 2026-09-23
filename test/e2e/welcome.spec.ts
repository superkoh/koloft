import fs from 'fs'
import path from 'path'
import { test, expect, launchApp, runInTerminal } from './helpers/app'
import { seedSettings } from './helpers/env'
import {
  gitInit,
  killSession,
  pickerDialog,
  seedJsonl,
  sendShortcut,
  snap,
  startSessionIn,
  waitForCalls,
  worktreeDialog,
  wsRows
} from './helpers/p1'

test.describe('S4: the centre with no session running — onboarding with nothing pinned, a launchpad otherwise', () => {
  test('T-LIFE-13: with nothing pinned the center is the onboarding panel', async ({ env }) => {
    test.setTimeout(120_000)
    seedSettings(env, { onboardingSeen: true })
    fs.writeFileSync(
      path.join(env.userData, 'layout.json'),
      JSON.stringify({ version: 4, workspaces: [], workbench: { defaultOpen: true }, sessions: {} })
    )

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      const panel = page.locator('.w-empty')
      await expect(panel).toBeVisible({ timeout: 20_000 })
      await expect(panel.locator('.big')).toHaveText('No workspace yet')
      await expect(panel).toContainText('Pick a folder to manage sessions in.')
      await expect(panel.locator('.btn-primary')).toHaveText('Choose Folder…')
      await expect(panel.locator('.quiet.key')).toHaveText('⇧⌘O')
      await expect(panel.locator('.recent-list')).toHaveCount(0)
      await expect(page.locator('.tb-ico[aria-label="Add workspace"]')).toHaveClass(/\bon\b/)
      await snap(page, 'T-LIFE-13a')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('T-LIFE-13: with a workspace pinned the panel launches that workspace, then yields to it', async ({
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    seedJsonl(env, env.workspaces.a, { summary: 'Recent A session' })
    seedJsonl(env, env.workspaces.b, { summary: 'Other B session' })

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      const panel = page.locator('.w-empty')
      await expect(panel).toBeVisible({ timeout: 20_000 })
      await expect(panel.locator('.big')).toHaveText('ws-a')
      await expect(panel.locator('.quiet').first()).toHaveText('No running session')
      await expect(panel.locator('.btn-primary')).toHaveText('＋ New session')

      await expect(panel.locator('.recent-hd')).toHaveText('Recent')
      const recent = panel.locator('.recent-list .recent-row')
      await expect(recent).toHaveCount(1)
      await expect(recent.locator('.ws-tab-title')).toHaveText('Recent A session')
      await expect(page.locator('.ws-tab', { hasText: 'Other B session' })).toHaveCount(1)
      await snap(page, 'T-LIFE-13b')

      await panel.locator('button', { hasText: 'New worktree session' }).click()
      const c8 = worktreeDialog(page)
      await expect(c8).toBeVisible({ timeout: 15_000 })
      await expect(c8.locator('.modal-header')).toContainText('ws-a')
      await page.keyboard.press('Escape')
      await expect(c8).toHaveCount(0)

      await panel.locator('.btn-primary').click()

      await expect(page.locator('.w-empty')).toHaveCount(0, { timeout: 20_000 })
      await expect(page.locator('.modal')).toHaveCount(0)
      await expect(page.locator('.term-wrap:visible')).toBeVisible()
      const [call] = await waitForCalls(env, 1)
      expect(call.cwd).toBe(env.workspaces.a)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('T-LIFE-17: the last session exiting cleanly hands the centre back to the panel, cold rows still listed', async ({
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    seedJsonl(env, env.workspaces.a, { summary: 'Recent A session' })

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await page.waitForLoadState('domcontentloaded')
      await startSessionIn(page, 'ws-a')
      await waitForCalls(env, 1)
      await expect(page.locator('.w-empty')).toHaveCount(0)

      await expect(page.locator('.ws-tab', { hasText: 'Recent A session' })).toHaveCount(1)

      await runInTerminal(page, '/exit')

      const panel = page.locator('.w-empty')
      await expect(panel).toBeVisible({ timeout: 30_000 })
      await expect(panel.locator('.quiet').first()).toHaveText('No running session')
      await expect(page.locator('.term-wrap')).toHaveCount(0)
      await expect(page.locator('.ws-tab', { hasText: 'Recent A session' })).toHaveCount(1)
      await snap(page, 'T-LIFE-17')
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('T-LIFE-12: with nothing selected the panel targets the workspace last worked in, until a restart', async ({
    env
  }) => {
    test.setTimeout(300_000)
    gitInit(env.workspaces.b)
    seedJsonl(env, env.workspaces.a, { summary: 'Cold A session' })

    const app1 = await launchApp(env)
    const page1 = await app1.firstWindow()
    await page1.waitForLoadState('domcontentloaded')
    try {
      await expect(page1.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
      await expect(page1.locator('.w-empty .big')).toHaveText('ws-a')

      await startSessionIn(page1, 'ws-b')
      const rowB = wsRows(page1, 'ws-b').first()
      await rowB.click()
      const [sessionB] = await waitForCalls(env, 1)
      killSession(sessionB.pid, env)
      await expect(rowB).toHaveClass(/\bcold\b/, { timeout: 40_000 })
      const panel = page1.locator('.w-empty')
      await expect(panel).toBeVisible({ timeout: 20_000 })

      await expect(panel.locator('.big')).toHaveText('ws-b')
      const recent = panel.locator('.recent-list .recent-row')
      await expect(recent).toHaveCount(1)
      await expect(recent.locator('.ws-tab-title')).toHaveText('Fake session: project notes')
      await expect(panel).not.toContainText('Cold A session')
      await snap(page1, 'T-LIFE-12')

      await sendShortcut(app1, 'shortcut:new-session')
      const dlg = pickerDialog(page1)
      await expect(dlg).toBeVisible({ timeout: 15_000 })
      await expect(dlg.locator('.modal-header')).toContainText('New Session in…')
      await expect(dlg.locator('[role="option"][aria-selected="true"] .wsp-name')).toHaveText(
        'ws-b'
      )
      await page1.keyboard.press('Enter')
      const calls = await waitForCalls(env, 2)
      expect(calls[1].cwd).toBe(env.workspaces.b)
      expect(calls[1].argv).not.toContain('-w')
    } finally {
      await app1.close().catch(() => {})
    }

    const app2 = await launchApp(env)
    try {
      const page2 = await app2.firstWindow()
      await page2.waitForLoadState('domcontentloaded')
      await expect(page2.locator('.w-empty .big')).toHaveText('ws-a', { timeout: 20_000 })
    } finally {
      await app2.close().catch(() => {})
    }
  })
})
