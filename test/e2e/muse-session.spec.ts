import fs from 'fs'
import path from 'path'
import type { Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  installMuse,
  museCalls,
  seedSettings,
  trustInMuse,
  type E2EEnv,
  type MuseCall
} from './helpers/env'
import {
  centerTerm,
  chooseBackend,
  gitCommitAll,
  gitInit,
  newSessionInWith,
  openMenu,
  openWorktreeSession,
  processAlive,
  runIn,
  sendShortcut,
  waitBooted,
  wsRows
} from './helpers/p1'

test.setTimeout(120_000)

function museRows(page: Page): Locator {
  return wsRows(page, 'ws-a').filter({
    hasNot: page.getByRole('img', { name: 'Claude', exact: true })
  })
}

async function startMuse(page: Page, env: E2EEnv): Promise<MuseCall> {
  const before = museCalls(env).length
  await newSessionInWith(page, 'ws-a', 'Muse')
  await expect.poll(() => museCalls(env).length).toBe(before + 1)
  await expect(museRows(page).and(page.locator('.active'))).toHaveClass(/st-waiting/)
  return museCalls(env)[before]
}

test.describe('Muse Code sessions through the real method chooser, status signal, live registry and muse serve, with only the CLI faked', () => {
  test("a Muse session starts from the workspace menu, waits on Muse's trust question in its terminal, and its light follows its status from working to waiting", async ({
    env
  }) => {
    installMuse(env)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await newSessionInWith(page, 'ws-a', 'Muse')
      await expect(page.locator('.term-wrap:visible')).toContainText('Do you trust this workspace?')
      expect(museCalls(env)).toHaveLength(0)
      await runIn(page, centerTerm(page), '')
      await expect.poll(() => museCalls(env).length).toBe(1)
      const call = museCalls(env)[0]
      expect(call.argv).toEqual([])
      expect(fs.existsSync(path.join(call.pathHead, 'open'))).toBe(true)
      const row = museRows(page)
      await expect(row).toHaveClass(/st-waiting/)
      fs.writeFileSync(path.join(env.home, 'fake-muse-delay'), '1500')
      await runIn(page, centerTerm(page), 'hello muse')
      await expect(row).toHaveClass(/st-working/)
      await expect(row).toHaveClass(/st-waiting/)
      await expect(row).toContainText('hello muse')
    } finally {
      await quitAndClose(app)
    }
  })

  test('/clear keeps the tab and moves it to a new session; the cleared one leaves the list for Restore session, which resumes it with muse resume', async ({
    env
  }) => {
    installMuse(env)
    trustInMuse(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const first = await startMuse(page, env)
      await runIn(page, centerTerm(page), 'first topic')
      await expect(museRows(page).filter({ hasText: 'first topic' })).toHaveClass(/st-waiting/)
      await runIn(page, centerTerm(page), '/clear')
      await expect.poll(() => museCalls(env).length).toBe(2)
      const second = museCalls(env)[1]
      expect(second.pid).toBe(first.pid)
      expect(second.sessionId).not.toBe(first.sessionId)
      await runIn(page, centerTerm(page), 'second topic')
      await expect(museRows(page).filter({ hasText: 'second topic' })).toHaveClass(/st-waiting/)
      await expect(museRows(page)).toHaveCount(1)
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'Restore session' }).click()
      const history = page.getByRole('dialog', { name: 'Restore session · ws-a', exact: true })
      await history.getByRole('button').filter({ hasText: 'first topic' }).click()
      await expect.poll(() => museCalls(env).length).toBe(3)
      expect(museCalls(env)[2].argv).toEqual(['resume', first.sessionId])
      expect(museCalls(env)[2].sessionId).toBe(first.sessionId)
    } finally {
      await quitAndClose(app)
    }
  })

  test('a Muse tab still open when Koloft quits comes back running the same session after a restart', async ({
    env
  }) => {
    installMuse(env)
    trustInMuse(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    let app = await launchApp(env)
    try {
      let page = await app.firstWindow()
      await waitBooted(page)
      const first = await startMuse(page, env)
      await quitAndClose(app)
      await expect.poll(() => processAlive(first.pid)).toBe(false)

      app = await launchApp(env)
      page = await app.firstWindow()
      await waitBooted(page)
      await expect.poll(() => museCalls(env).length, { timeout: 30_000 }).toBe(2)
      expect(museCalls(env)[1].argv).toEqual(['resume', first.sessionId])
      await expect(museRows(page)).toHaveCount(1)
      await expect(museRows(page)).toHaveClass(/st-(waiting|idle)/, { timeout: 30_000 })
    } finally {
      await quitAndClose(app)
    }
  })

  test('a Muse worktree session runs in its own worktree folder, trusted for that run because its workspace is', async ({
    env
  }) => {
    installMuse(env)
    trustInMuse(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    gitInit(env.workspaces.a)
    gitCommitAll(env.workspaces.a)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const dialog = await openWorktreeSession(page, 'ws-a')
      await dialog.locator('input').fill('muse-tree')
      await chooseBackend(page, 'other')
      await expect.poll(() => museCalls(env).length).toBe(1)
      const call = museCalls(env)[0]
      expect(call.argv).toEqual(['--trust-workspace'])
      expect(fs.realpathSync(call.cwd)).not.toBe(fs.realpathSync(env.workspaces.a))
      expect(path.basename(call.cwd)).toBe('muse-tree')
      await expect(museRows(page).and(page.locator('.active'))).toHaveClass(/st-waiting/)
    } finally {
      await quitAndClose(app)
    }
  })

  test('closing the tab ends muse; its row stays in the list, cold, and clicking it brings the same session back', async ({
    env
  }) => {
    installMuse(env)
    trustInMuse(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const first = await startMuse(page, env)
      await runIn(page, centerTerm(page), 'keep me')
      await expect(museRows(page)).toContainText('keep me')
      await sendShortcut(app, 'shortcut:close-tab')
      await expect.poll(() => processAlive(first.pid)).toBe(false)
      await expect(museRows(page)).toHaveClass(/cold/)
      await museRows(page).click()
      await expect.poll(() => museCalls(env).length).toBe(2)
      expect(museCalls(env)[1].sessionId).toBe(first.sessionId)
    } finally {
      await quitAndClose(app)
    }
  })

  test('a scheduled job set to run in Muse starts Muse in its own worktree with its task, model and thinking level, never asking, trusted for that run', async ({
    env
  }) => {
    const TASK = '/daily-report now'
    installMuse(env)
    gitInit(env.workspaces.a)
    trustInMuse(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'Scheduled jobs' }).click()
      const dlg = page.locator('.modal.cronjobs')
      await dlg.locator('button.mini', { hasText: 'New job' }).click()
      await dlg.locator('.chip', { hasText: /^Muse$/ }).click()
      await dlg.locator('input[aria-label="Name"]').fill('Nightly report')
      await dlg.locator('[aria-label="What to run"]').fill(TASK)
      await dlg.locator('.chip', { hasText: 'Other…' }).click()
      await dlg.locator('input[aria-label="Model name"]').fill('muse-large')
      await dlg.locator('.chip', { hasText: /^High$/ }).click()
      await expect(dlg.locator('.chip.on', { hasText: 'Never ask' })).toHaveCount(1)
      await dlg.locator('.modal-foot .btn-primary').click()
      await dlg.locator('.job-row button.mini', { hasText: 'Run now' }).click()

      await expect.poll(() => museCalls(env).length, { timeout: 30_000 }).toBe(1)
      expect(museCalls(env)[0].argv).toEqual([
        '--model',
        'muse-large',
        '--reasoning-effort',
        'high',
        '--approval-mode',
        'never',
        '--trust-workspace',
        TASK
      ])
      expect(museCalls(env)[0].cwd).not.toBe(env.workspaces.a)
      await expect
        .poll(
          () => page.evaluate(async () => (await window.api.cron.list()).live.map((l) => l.state)),
          { timeout: 30_000 }
        )
        .toEqual([expect.stringMatching(/^(running|done)$/)])
    } finally {
      await quitAndClose(app)
    }
  })

  test('a Muse job set to "Close it" closes for good once Muse finishes the turn: tab, row and worktree', async ({
    env
  }) => {
    installMuse(env)
    gitInit(env.workspaces.a)
    trustInMuse(env, env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
      await page.locator('.menu .mi', { hasText: 'Scheduled jobs' }).click()
      const dlg = page.locator('.modal.cronjobs')
      await dlg.locator('button.mini', { hasText: 'New job' }).click()
      await dlg.locator('.chip', { hasText: /^Muse$/ }).click()
      await dlg.locator('input[aria-label="Name"]').fill('Nightly report')
      await dlg.locator('[aria-label="What to run"]').fill('/daily-report now')
      await dlg.locator('.chip', { hasText: 'Close it' }).click()
      await dlg.locator('.modal-foot .btn-primary').click()
      await dlg.locator('.job-row button.mini', { hasText: 'Run now' }).click()

      await expect.poll(() => museCalls(env).length, { timeout: 30_000 }).toBe(1)
      await expect(dlg.locator('.hist-row').first()).toContainText('Done — closed itself', {
        timeout: 30_000
      })
      const tree = museCalls(env)[0].cwd
      await expect(page.locator('.terminals .term-wrap')).toHaveCount(0, { timeout: 30_000 })
      await expect(wsRows(page, 'ws-a')).toHaveCount(0, { timeout: 30_000 })
      await expect.poll(() => fs.existsSync(tree), { timeout: 30_000 }).toBe(false)
    } finally {
      await quitAndClose(app)
    }
  })
})
