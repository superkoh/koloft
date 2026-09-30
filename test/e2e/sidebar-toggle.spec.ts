import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  notesArea,
  sendShortcut,
  settingsOnDisk,
  snap,
  waitBooted,
  workspaceNames
} from './helpers/p1'
import { answerFileDialog } from './helpers/workbench'
import type { E2EEnv } from './helpers/env'

const SIDEBAR_BUTTON = '.aux-ico.sb-toggle'

async function open(env: E2EEnv): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitBooted(page)
  return { app, page }
}

async function centerLeft(page: Page): Promise<number> {
  return (await page.locator('.center').boundingBox())?.x ?? -1
}

test.describe('Sidebar: the button by the traffic lights hides and shows it, and the choice survives a restart', () => {
  test('SB01: hiding gives the centre the whole width, stays hidden after a restart, and showing brings back the old width', async ({
    env
  }) => {
    test.setTimeout(180_000)
    let { app, page } = await open(env)
    let width = 0
    try {
      await expect(page.locator('.side')).toBeVisible({ timeout: 20_000 })
      width = (await page.locator('.side').boundingBox())?.width ?? 0
      expect(width).toBeGreaterThan(0)

      await page.locator(SIDEBAR_BUTTON).click()
      await expect(page.locator('.side')).toBeHidden()
      expect(await centerLeft(page)).toBe(0)
      await expect.poll(() => settingsOnDisk(env).sidebarHidden, { timeout: 5_000 }).toBe(true)
      await snap(page, 'SB01-hidden')
    } finally {
      await quitAndClose(app)
    }

    ;({ app, page } = await open(env))
    try {
      await expect(page.locator(SIDEBAR_BUTTON)).toBeVisible({ timeout: 20_000 })
      await expect(page.locator('.side')).toBeHidden()

      await page.locator(SIDEBAR_BUTTON).click()
      await expect(page.locator('.side')).toBeVisible()
      expect((await page.locator('.side').boundingBox())?.width).toBe(width)
      await expect.poll(() => settingsOnDisk(env).sidebarHidden, { timeout: 5_000 }).toBe(false)
    } finally {
      await quitAndClose(app)
    }
  })

  test('SB02: ⌥⌘N while the sidebar is hidden shows it and puts the caret in the note', async ({
    app,
    page
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    await expect(notesArea(page)).toBeVisible({ timeout: 20_000 })
    await page.locator(SIDEBAR_BUTTON).click()
    await expect(page.locator('.side')).toBeHidden()

    await sendShortcut(app, 'shortcut:focus-notes')
    await expect(page.locator('.side')).toBeVisible()
    await expect(notesArea(page)).toBeFocused()
  })

  test('SB03: adding a new workspace with ⇧⌘O while the sidebar is hidden shows it with the new workspace', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)
    await page.locator(SIDEBAR_BUTTON).click()
    await expect(page.locator('.side')).toBeHidden()

    const dir = path.join(env.home, 'ws-new')
    fs.mkdirSync(dir)
    answerFileDialog(env, dir)
    await sendShortcut(app, 'shortcut:add-workspace')
    await expect(page.locator('.side')).toBeVisible({ timeout: 20_000 })
    expect(await workspaceNames(page)).toContain('ws-new')
  })
})
