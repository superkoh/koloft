import fs from 'fs'
import path from 'path'
import { test, expect, launchApp, pendingAttention, pretendWindowFocused } from './helpers/app'
import { FAKE_SESSION_TITLE, readCalls, resumedId, startSessionIn, waitBooted } from './helpers/p1'

const DEBOUNCED_SAVES_LAND_MS = 1500
const ROOM_FOR_A_WRONG_RESPAWN_MS = 2000
const MACOS_CLOSES_THE_OLD_FULLSCREEN_SPACE_MS = 3000

test('restart (T-LIFE-09 across a real relaunch): the open session comes back running and selected, resumed once, with no session snapshot in layout.json, and window bounds return', async ({
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
  await expect(row).toHaveClass(/\bst-(working|waiting|idle)\b/, { timeout: 30_000 })
  await expect(row).toHaveClass(/\bactive\b/)
  await page2.waitForTimeout(ROOM_FOR_A_WRONG_RESPAWN_MS)
  const calls = readCalls(env)
  expect(calls).toHaveLength(2)
  expect(resumedId(calls[1])).toBe(calls[0].sessionId)

  const layout = JSON.parse(fs.readFileSync(path.join(env.userData, 'layout.json'), 'utf8'))
  expect(layout.version).toBe(6)
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

test('an unread red dot survives a real relaunch on the session’s row, which comes back running, and clicking the row in a focused window clears it', async ({
  env
}) => {
  const app1 = await launchApp(env)
  const page1 = await app1.firstWindow()
  await page1.waitForLoadState('domcontentloaded')
  await waitBooted(page1)
  await startSessionIn(page1, 'ws-a')
  await expect(page1.locator('.ws-tab.st-waiting .ws-tab-unread')).toHaveCount(1, {
    timeout: 25_000
  })
  await app1.close()

  const app2 = await launchApp(env)
  const page2 = await app2.firstWindow()
  await page2.waitForLoadState('domcontentloaded')
  const row = page2.locator('.ws-tab', { hasText: FAKE_SESSION_TITLE })
  await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 30_000 })
  await expect(row.locator('.ws-tab-unread')).toHaveCount(1)
  await expect.poll(() => pendingAttention(page2)).toMatchObject([{ kind: 'turn-done' }])

  await pretendWindowFocused(app2)
  await row.click()
  await expect(row.locator('.ws-tab-unread')).toHaveCount(0)
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
  // PLATFORM§5
  await new Promise((r) => setTimeout(r, MACOS_CLOSES_THE_OLD_FULLSCREEN_SPACE_MS))

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
