import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, quitAndClose } from './helpers/app'
import { launchSettled } from './helpers/blackbox'
import {
  clickAppMenuItem,
  notesArea,
  sendShortcut,
  settingsOnDisk,
  snap,
  startSessionIn,
  waitBooted,
  workspaceNames
} from './helpers/p1'
import { answerFileDialog } from './helpers/workbench'

const SIDEBAR_BUTTON = '.aux-ico.sb-toggle'

async function centerLeft(page: Page): Promise<number> {
  return (await page.locator('.center').boundingBox())?.x ?? -1
}

// PLATFORM§24
function dragsWindowAt(page: Page, x: number, y: number): Promise<boolean> {
  return page.evaluate(
    ([px, py]) => {
      let drag = false
      for (const el of Array.from(document.querySelectorAll('*'))) {
        const region = getComputedStyle(el).getPropertyValue('app-region').trim()
        if (region !== 'drag' && region !== 'no-drag') continue
        const r = el.getBoundingClientRect()
        if (px >= r.left && px < r.right && py >= r.top && py < r.bottom) drag = region === 'drag'
      }
      return drag
    },
    [x, y]
  )
}

test.describe('Sidebar: the button by the traffic lights hides and shows it, and the choice survives a restart', () => {
  test('SB01: hiding gives the centre the whole width, stays hidden after a restart, and showing brings back the old width', async ({
    env
  }) => {
    test.setTimeout(180_000)
    let { app, page } = await launchSettled(env)
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

    ;({ app, page } = await launchSettled(env))
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

  test('SB04: the sidebar button comes after both title-bar drag strips in the document, so the window drag never swallows its clicks', async ({
    page
  }) => {
    test.setTimeout(60_000)
    await waitBooted(page)
    const order = await page.evaluate((sel) => {
      const button = document.querySelector(sel)
      const after = (other: string): boolean => {
        const el = document.querySelector(other)
        return (
          !!button &&
          !!el &&
          (el.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0
        )
      }
      return { titlebar: after('.titlebar'), centerTop: after('.center-top') }
    }, SIDEBAR_BUTTON)
    expect(order).toEqual({ titlebar: true, centerTop: true })
  })

  test('SB05: in macOS full screen, with no traffic lights, the sidebar button moves to the left edge and comes back after', async ({
    app,
    page
  }) => {
    test.setTimeout(60_000)
    await waitBooted(page)
    const left = async (): Promise<number> =>
      (await page.locator(SIDEBAR_BUTTON).boundingBox())?.x ?? -1
    const windowed = await left()
    const fullscreen = (on: boolean): Promise<void> =>
      app.evaluate(({ BrowserWindow }, v) => {
        BrowserWindow.getAllWindows()[0]?.webContents.send('window:fullscreen', v)
      }, on)

    await fullscreen(true)
    await expect.poll(left).toBeLessThan(windowed)
    await fullscreen(false)
    await expect.poll(left).toBe(windowed)
  })

  test('SB06: with the sidebar hidden and the Workbench full width, the empty band above the Workbench still drags the window', async ({
    app,
    page
  }) => {
    test.setTimeout(120_000)
    await startSessionIn(page, 'ws-a')
    await page.locator(SIDEBAR_BUTTON).click()
    await expect(page.locator('.side')).toBeHidden()
    await clickAppMenuItem(app, page, 'toggle-focus-mode')
    await expect(page.locator('.wb-col.full')).toBeVisible()

    const band = await page.evaluate(() => {
      const wb = document.querySelector('.wb-col.full')!.getBoundingClientRect()
      return { x: wb.left + wb.width / 2, y: wb.top / 2 }
    })
    expect(await dragsWindowAt(page, band.x, band.y)).toBe(true)
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
    await expect.poll(() => workspaceNames(page), { timeout: 20_000 }).toContain('ws-new')
  })
})
