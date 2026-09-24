import fs from 'fs'
import path from 'path'
import { test, expect, launchApp } from './helpers/app'
import { FAKE_SESSION_TITLE, startSessionIn, waitBooted } from './helpers/p1'

const DEBOUNCED_SAVES_LAND_MS = 1500
const ROOM_FOR_A_WRONG_RESPAWN_MS = 2000

test('restart lands cold (T-LIFE-09 across a real relaunch): session listed unselected, nothing respawns, no session snapshot in layout.json, window bounds return', async ({
  env
}) => {
  const app1 = await launchApp(env)
  const page1 = await app1.firstWindow()
  await page1.waitForLoadState('domcontentloaded')

  await waitBooted(page1)
  await startSessionIn(page1, 'ws-a')
  await expect(page1.locator('.ws-tab-title', { hasText: FAKE_SESSION_TITLE })).toBeVisible({
    timeout: 25_000
  })

  await app1.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setBounds({ x: 80, y: 80, width: 1180, height: 760 })
  })
  await page1.waitForTimeout(DEBOUNCED_SAVES_LAND_MS)
  await app1.close()

  const app2 = await launchApp(env)
  const page2 = await app2.firstWindow()
  await page2.waitForLoadState('domcontentloaded')

  const row = page2.locator('.ws-tab', { hasText: FAKE_SESSION_TITLE })
  await expect(row).toBeVisible({ timeout: 20_000 })
  await expect(row).toHaveClass(/\bcold\b/)
  await expect(row).not.toHaveClass(/\bactive\b/)
  await expect(
    page2.locator('.ws-tab.st-working, .ws-tab.st-waiting, .ws-tab.st-approval, .ws-tab.st-idle')
  ).toHaveCount(0)
  await expect(page2.locator('.center')).toContainText('No running session')
  await page2.waitForTimeout(ROOM_FOR_A_WRONG_RESPAWN_MS)
  const calls = fs.readFileSync(env.claudeCalls, 'utf8').trim().split('\n')
  expect(calls).toHaveLength(1)

  const layout = JSON.parse(fs.readFileSync(path.join(env.userData, 'layout.json'), 'utf8'))
  expect(layout.version).toBe(5)
  expect(layout).not.toHaveProperty('activeSessionId')
  expect(layout).not.toHaveProperty('tabs')
  expect(layout).not.toHaveProperty('aux')

  const bounds = await app2.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds()
  )
  expect(bounds.width).toBe(1180)
  expect(bounds.height).toBe(760)
  await app2.close()
})

test('a window quit in fullscreen restores into fullscreen, and the green button keeps its fullscreen action', async ({
  env
}) => {
  test.skip(
    process.env.KOLOFT_E2E_FULLSCREEN !== '1',
    'grabs a macOS Space / steals the screen — opt in with KOLOFT_E2E_FULLSCREEN=1'
  )
  delete env.launchEnv.KOLOFT_TEST_BACKGROUND
  const app1 = await launchApp(env)
  try {
    const page1 = await app1.firstWindow()
    await page1.waitForLoadState('domcontentloaded')
    await app1.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setFullScreen(true)
    })
    await expect
      .poll(
        () => app1.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()),
        { timeout: 15_000 }
      )
      .toBe(true)
  } finally {
    await app1.close().catch(() => {})
  }

  const app2 = await launchApp(env)
  try {
    const page2 = await app2.firstWindow()
    await page2.waitForLoadState('domcontentloaded')
    await expect
      .poll(
        () => app2.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()),
        { timeout: 15_000 }
      )
      .toBe(true)
    const fullscreenable = await app2.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isFullScreenable()
    )
    expect(fullscreenable).toBe(true)
  } finally {
    await app2.close().catch(() => {})
  }
})
