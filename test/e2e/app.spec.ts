import { test, expect } from './helpers/app'
import { sendShortcut } from './helpers/p1'

test('the green traffic-light button can enter native fullscreen, and a fresh launch does not open in fullscreen', async ({
  app
}) => {
  await app.firstWindow()
  // PLATFORM§5
  const state = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    return { fullscreenable: win.isFullScreenable(), fullscreen: win.isFullScreen() }
  })
  expect(state.fullscreenable).toBe(true)
  expect(state.fullscreen).toBe(false)
})

test('T-LIFE-09: app launches with the isolated koloft-dev home and shows the empty state', async ({
  page
}) => {
  await expect(page.locator('.isl-sessions')).toBeVisible()
  await expect(page.locator('.ws-name', { hasText: 'ws-a' })).toBeVisible()
  await expect(page.locator('.ws-name', { hasText: 'ws-b' })).toBeVisible()
  await expect(page.locator('.ws-tab')).toHaveCount(0)
  await expect(page.locator('.center')).toContainText('No running session')
  await expect(page.locator('.dev-badge')).toBeVisible()
})

test('⌘, opens Settings', async ({ app, page }) => {
  await expect(page.locator('.isl-sessions')).toBeVisible()
  await sendShortcut(app, 'shortcut:open-settings')
  await expect(page.locator('.settings-modal')).toBeVisible()
})
