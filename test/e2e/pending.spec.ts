import fs from 'fs'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import type { E2EEnv } from './helpers/env'
import {
  gitInit,
  menuItemTexts,
  openMenu,
  openPicker,
  pickerDialog,
  processAlive,
  sendShortcut,
  snap,
  waitForCalls
} from './helpers/p1'

const BIND_DELAY_LONG_ENOUGH_TO_DRIVE_THE_MENU_MS = '20000'

async function launch(env: E2EEnv): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
  return { app, page }
}

async function startMainSession(app: ElectronApplication, page: Page): Promise<void> {
  await openPicker(app, page)
  await page.keyboard.press('Enter')
  await expect(pickerDialog(page)).toHaveCount(0)
}

test.describe('pending row: what a launch owns before Claude reports a session id — promote, cancel, die before binding', () => {
  test('T-LIFE-01: a launch shows a pending row, then promotes in place when it binds — the same single row, never a second one', async ({
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    fs.writeFileSync(env.claudeDelayFile, '4000')

    const { app, page } = await launch(env)
    try {
      await startMainSession(app, page)

      const pending = page.locator('.ws-tab.st-pending')
      await expect(pending).toHaveCount(1, { timeout: 20_000 })
      await expect(pending.locator('.ws-tab-title')).toHaveText('Starting…')
      await expect(pending.locator('.ws-tab-sub')).toHaveText('main')
      await expect(pending).toHaveClass(/\bactive\b/)
      await expect(page.locator('.term-wrap:visible').first()).toContainText('delayed bind', {
        timeout: 30_000
      })
      await expect(page.locator('.ws-tab')).toHaveCount(1)
      await snap(page, 'T-LIFE-01')

      const row = page.locator('.ws-tab', { hasText: 'Fake session: project notes' })
      await expect(row).toHaveCount(1, { timeout: 40_000 })
      await expect(page.locator('.ws-tab')).toHaveCount(1)
      await expect(page.locator('.ws-tab.st-pending')).toHaveCount(0)
      await expect(row.locator('.ws-tab-sub')).toHaveText('main')
      await expect(row).not.toHaveClass(/\bcold\b/)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('T-LIFE-02 (= T-KEY-02): a pending row offers only Cancel; Cancel and ⌘W both kill the launch', async ({
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    fs.writeFileSync(env.claudeDelayFile, BIND_DELAY_LONG_ENOUGH_TO_DRIVE_THE_MENU_MS)

    const { app, page } = await launch(env)
    try {
      await startMainSession(app, page)
      const pending = page.locator('.ws-tab.st-pending')
      await expect(pending).toHaveCount(1, { timeout: 20_000 })
      const [first] = await waitForCalls(env, 1)

      await openMenu(page, pending)
      expect(await menuItemTexts(page)).toEqual(['Cancel'])
      await snap(page, 'T-LIFE-02')
      await page.locator('.menu .mi', { hasText: 'Cancel' }).click()

      await expect(page.locator('.ws-tab')).toHaveCount(0, { timeout: 30_000 })
      await expect.poll(() => processAlive(first.pid), { timeout: 30_000 }).toBe(false)

      await startMainSession(app, page)
      await expect(pending).toHaveCount(1, { timeout: 20_000 })
      await expect(pending).toHaveClass(/\bactive\b/)
      const calls = await waitForCalls(env, 2)
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(page.locator('.ws-tab')).toHaveCount(0, { timeout: 30_000 })
      await expect.poll(() => processAlive(calls[1].pid), { timeout: 30_000 }).toBe(false)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('T-LIFE-03: a launch that dies before binding leaves nothing behind, and the exit is said out loud', async ({
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    fs.writeFileSync(env.claudeExitFile, '1')

    const { app, page } = await launch(env)
    try {
      await startMainSession(app, page)
      await expect(page.locator('.ws-tab.st-pending')).toHaveCount(1, { timeout: 20_000 })
      await waitForCalls(env, 1)
      await expect(page.locator('.toast-msg')).toContainText('exit code 1', { timeout: 20_000 })
      await expect(page.locator('.term-island .term-wrap')).toHaveCount(0, { timeout: 20_000 })
      await expect(page.locator('.ws-tab')).toHaveCount(0, { timeout: 30_000 })
    } finally {
      await app.close().catch(() => {})
    }
  })
})
