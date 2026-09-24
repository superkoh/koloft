import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, quitAndClose } from './helpers/app'
import {
  addRemoteWorkspace,
  installFakeRemote,
  killFakeRemote,
  launchWithRemote,
  liveTmuxSessions,
  REMOTE_WS_NAME,
  remoteDir,
  sshCommands
} from './helpers/remote'
import {
  FAKE_SESSION_TITLE,
  gitInit,
  gitWorktreeAdd,
  menuItemTexts,
  openMenu,
  openWorktreeSession,
  resumedId,
  sendShortcut,
  waitForCalls,
  wsRows
} from './helpers/p1'

test.afterEach(({ env }) => killFakeRemote(env))

async function closeActiveTab(app: ElectronApplication, page: Page): Promise<void> {
  await page.locator('.ws-tab.active').first().click()
  await sendShortcut(app, 'shortcut:close-tab')
  const confirm = page.locator('.modal', { hasText: 'Close running session?' })
  if (await confirm.isVisible({ timeout: 4000 }).catch(() => false)) {
    await confirm
      .locator('.btn-primary, button', { hasText: /^Close$/ })
      .first()
      .click()
  }
}

async function wsMenuTexts(page: Page): Promise<string[]> {
  await openMenu(page, page.locator('.ws-head', { hasText: REMOTE_WS_NAME }))
  const items = await menuItemTexts(page)
  await page.keyboard.press('Escape')
  await expect(page.locator('.menu')).toHaveCount(0)
  return items
}

test.describe('worktree sessions in a remote workspace, driven by the machine’s own git answer', () => {
  test('E-RW-14: a remote git folder offers New worktree session, and creating one runs `-w` on the machine', async ({
    env
  }) => {
    test.setTimeout(300_000)
    installFakeRemote(env)
    gitInit(remoteDir(env))
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)

      await expect
        .poll(async () => (await wsMenuTexts(page)).join(' | '), { timeout: 60_000 })
        .toContain('New worktree session')
      expect((await wsMenuTexts(page)).join(' | ')).not.toContain('Fetch origin')

      const dlg = await openWorktreeSession(page, REMOTE_WS_NAME)
      await dlg.getByRole('textbox').click()
      await page.keyboard.type('featr')
      await page.keyboard.press('Enter')
      await expect(dlg).toHaveCount(0)

      const row = wsRows(page, REMOTE_WS_NAME).filter({ hasText: FAKE_SESSION_TITLE })
      await expect(row).toHaveCount(1, { timeout: 120_000 })
      await expect(row.locator('.ws-tab-sub')).toHaveText('featr')

      const [call] = await waitForCalls(env, 1, 60_000)
      expect(call.cwd).toBe(remoteDir(env))
      expect(call.argv.join(' ')).toContain('-w featr')

      const wtDir = path.join(remoteDir(env), '.claude', 'worktrees', 'featr')
      expect(fs.statSync(wtDir).isDirectory()).toBe(true)
      await expect.poll(() => liveTmuxSessions(env).length, { timeout: 30_000 }).toBe(1)
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RW-15: C8 lists the machine’s existing worktree and opens it with no -w', async ({
    env
  }) => {
    test.setTimeout(300_000)
    installFakeRemote(env)
    gitInit(remoteDir(env))
    const wtDir = gitWorktreeAdd(remoteDir(env), 'oldwt')
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await expect
        .poll(async () => (await wsMenuTexts(page)).join(' | '), { timeout: 60_000 })
        .toContain('New worktree session')

      const dlg = await openWorktreeSession(page, REMOTE_WS_NAME)
      const listRow = dlg.locator('.cb-row', {
        has: page.locator('.wt-name', { hasText: 'oldwt' })
      })
      await expect(listRow).toHaveCount(1, { timeout: 20_000 })
      await listRow.click()
      await expect(dlg).toHaveCount(0)

      const row = wsRows(page, REMOTE_WS_NAME).filter({ hasText: FAKE_SESSION_TITLE })
      await expect(row).toHaveCount(1, { timeout: 120_000 })

      const [call] = await waitForCalls(env, 1, 60_000)
      expect(fs.realpathSync(call.cwd)).toBe(fs.realpathSync(wtDir))
      expect(call.argv).not.toContain('-w')
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RW-17: a cold worktree row resumes in the worktree directory on the machine, not the workspace root', async ({
    env
  }) => {
    test.setTimeout(300_000)
    installFakeRemote(env)
    gitInit(remoteDir(env))
    const wtDir = gitWorktreeAdd(remoteDir(env), 'oldwt')
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await expect
        .poll(async () => (await wsMenuTexts(page)).join(' | '), { timeout: 60_000 })
        .toContain('New worktree session')

      const dlg = await openWorktreeSession(page, REMOTE_WS_NAME)
      const listRow = dlg.locator('.cb-row', {
        has: page.locator('.wt-name', { hasText: 'oldwt' })
      })
      await expect(listRow).toHaveCount(1, { timeout: 20_000 })
      await listRow.click()
      await expect(dlg).toHaveCount(0)

      const row = wsRows(page, REMOTE_WS_NAME).filter({ hasText: FAKE_SESSION_TITLE })
      await expect(row).toHaveCount(1, { timeout: 120_000 })
      const [first] = await waitForCalls(env, 1, 60_000)

      await closeActiveTab(app, page)
      await expect(row).toHaveClass(/\bcold\b/, { timeout: 90_000 })

      await row.click()

      const calls = await waitForCalls(env, 2, 90_000)
      const resume = calls[calls.length - 1]
      expect(resumedId(resume)).toBe(first.sessionId)
      expect(resume.argv).not.toContain('-w')
      expect(fs.realpathSync(resume.cwd)).toBe(fs.realpathSync(wtDir))
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RW-21: a cold worktree row whose worktree is gone from the machine rebuilds it there with git before resuming, from the folder that holds its transcript', async ({
    env
  }) => {
    test.setTimeout(300_000)
    installFakeRemote(env)
    gitInit(remoteDir(env))
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await expect
        .poll(async () => (await wsMenuTexts(page)).join(' | '), { timeout: 60_000 })
        .toContain('New worktree session')
      const dlg = await openWorktreeSession(page, REMOTE_WS_NAME)
      await dlg.getByRole('textbox').click()
      await page.keyboard.type('gone')
      await page.keyboard.press('Enter')
      await expect(dlg).toHaveCount(0)

      const row = wsRows(page, REMOTE_WS_NAME).filter({ hasText: FAKE_SESSION_TITLE })
      await expect(row).toHaveCount(1, { timeout: 120_000 })
      await expect(row).toHaveClass(/st-waiting|st-idle/, { timeout: 60_000 })
      const [first] = await waitForCalls(env, 1, 60_000)
      const wtDir = path.join(remoteDir(env), '.claude', 'worktrees', 'gone')

      await closeActiveTab(app, page)
      await expect(row).toHaveClass(/\bcold\b/, { timeout: 90_000 })
      execFileSync('git', ['-C', remoteDir(env), 'worktree', 'remove', '--force', wtDir])
      expect(fs.existsSync(wtDir)).toBe(false)

      await row.click()

      const calls = await waitForCalls(env, 2, 90_000)
      const resume = calls[calls.length - 1]
      expect(resumedId(resume)).toBe(first.sessionId)
      expect(sshCommands(env).some((c) => c.includes("'worktree' 'add'"))).toBe(true)
      expect(fs.statSync(wtDir).isDirectory()).toBe(true)
      expect(
        execFileSync('git', ['-C', wtDir, 'branch', '--show-current'], { encoding: 'utf8' })
      ).toBe('worktree-gone\n')
      expect(fs.realpathSync(resume.cwd)).toBe(fs.realpathSync(remoteDir(env)))
    } finally {
      await quitAndClose(app)
    }
  })
})
