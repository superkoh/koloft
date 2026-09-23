import { test, expect } from './helpers/app'
import { sendShortcut } from './helpers/p1'

test('the green traffic-light button can enter native fullscreen', async ({ app }) => {
  // both flags are fixed at BrowserWindow construction — no renderer state needed
  await app.firstWindow()
  // A fresh launch has no saved window state (fullScreen: false). Electron treats an
  // explicit `fullscreen: false` construction option as "disable the macOS fullscreen
  // button" (it degrades to zoom/maximize-only), observable as isFullScreenable() ===
  // false — a macOS-only coupling, so that guard is meaningful only on darwin.
  const state = await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    return { fullscreenable: win.isFullScreenable(), fullscreen: win.isFullScreen() }
  })
  expect(state.fullscreenable).toBe(true)
  // ...and omitting the option must not tip the other way: a fresh launch with no
  // saved state must open as a normal window, not INTO fullscreen
  expect(state.fullscreen).toBe(false)
})

test('app launches with the isolated home and shows the empty state', async ({ page }) => {
  // the Sessions island is the left navigation in the islandized shell
  await expect(page.locator('.isl-sessions')).toBeVisible()
  // the seeded fixture workspaces are pinned but have no sessions yet, and nothing
  // is running or selected → the center shows the v2 empty state (T-LIFE-09 shape)
  await expect(page.locator('.ws-name', { hasText: 'ws-a' })).toBeVisible()
  await expect(page.locator('.ws-name', { hasText: 'ws-b' })).toBeVisible()
  await expect(page.locator('.ws-tab')).toHaveCount(0)
  await expect(page.locator('.center')).toContainText('No running session')
  // the dev-build badge confirms we are on the koloft-dev userData namespace (isolated)
  await expect(page.locator('.dev-badge')).toBeVisible()
})

test('⌘, opens Settings', async ({ app, page }) => {
  await expect(page.locator('.isl-sessions')).toBeVisible()
  await sendShortcut(app, 'shortcut:open-settings')
  await expect(page.locator('.settings-modal')).toBeVisible()
})
