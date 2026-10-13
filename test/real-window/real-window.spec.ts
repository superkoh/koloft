import fs from 'fs'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as e2eTest, expect, launchApp, quitAndClose } from '../e2e/helpers/app'
import { seedSettings, type E2EEnv } from '../e2e/helpers/env'
import {
  FAKE_SESSION_TITLE,
  boundSessionId,
  centerTerm,
  focusOwner,
  startSessionIn,
  terminalText,
  transcriptFile,
  waitBooted,
  wsRows
} from '../e2e/helpers/p1'
import { claudePrompts } from '../e2e/helpers/workbench'
import {
  ABC_LAYOUT,
  COMMAND_FLAG,
  KEY_P,
  KEY_RETURN,
  KEY_SPACE,
  PINYIN_SIMPLIFIED,
  accessibilityTrusted,
  bannerShowing,
  bannerTexts,
  bareScreenPointOf,
  chooseOnBanner,
  bringFinderToFront,
  dockBadgeDrawn,
  dockItemCenter,
  notificationCenterRunning,
  realClick,
  realDrag,
  realKey,
  typeNihao,
  screenPointOf,
  screenshot,
  selectInputSource,
  windowBounds
} from './helpers/macInput'

const test = e2eTest.extend<{ shown: { app: ElectronApplication; page: Page } }>({
  shown: async ({ env }, use, testInfo) => {
    seedSettings(env, { hintsOff: true })
    env.launchEnv.KOLOFT_TEST_REAL_WINDOW = '1'
    const app = await launchApp(env)
    const page = await app.firstWindow()
    await waitBooted(page)
    await use({ app, page })
    if (testInfo.status !== testInfo.expectedStatus) {
      screenshot(testInfo.outputPath('failed-screen.png'))
      const body = await page
        .locator('body')
        .innerHTML()
        .catch((e: Error) => e.message)
      fs.writeFileSync(testInfo.outputPath('failed-dom.html'), body)
    }
    await quitAndClose(app)
  }
})

test.skip(
  process.env.KOLOFT_REAL_WINDOW !== '1',
  'real-window: set KOLOFT_REAL_WINDOW=1 only on a Mac whose screen this run may take over (scripts/real-window-mac.mjs)'
)

test.beforeAll(() => {
  expect(
    accessibilityTrusted(),
    'macOS drops every posted key and click unless the process running the tests has Accessibility'
  ).toBe(true)
})

// PLATFORM§46
const DOCK_NAME = 'Electron'
const palette = (page: Page) => page.locator('.modal.palette')
const DRAG_BY = { x: 160, y: 90 }
const ROOM_TO_DRAG_IN = { x: 40, y: 60, width: 760, height: 520 }
// PLATFORM§46
const MAC_DRAG_SLACK_PX = 6
const MACOS_ASKS_TO_ALLOW_NOTIFICATIONS = 'Notifications may include'

async function allowNotificationsWhenMacOSAsks(shownAnyway: () => boolean): Promise<void> {
  await expect
    .poll(() => shownAnyway() || bannerShowing(MACOS_ASKS_TO_ALLOW_NOTIFICATIONS), {
      timeout: 30_000
    })
    .toBe(true)
  if (!bannerShowing(MACOS_ASKS_TO_ALLOW_NOTIFICATIONS)) return
  // PLATFORM§46
  expect(chooseOnBanner(MACOS_ASKS_TO_ALLOW_NOTIFICATIONS, 'Allow')).toBe('0')
  await expect.poll(() => bannerShowing(MACOS_ASKS_TO_ALLOW_NOTIFICATIONS)).toBe(false)
}

async function sessionIn(page: Page, ws: string): Promise<string> {
  await startSessionIn(page, ws)
  return (await wsRows(page, ws).first().getAttribute('data-tab-id')) ?? ''
}

function endTurn(page: Page, tabId: string): Promise<void> {
  return page.evaluate(([id, line]) => window.api.terminal.write(id, line), [tabId, '/answer hi\r'])
}

const windowFocused = (app: ElectronApplication): Promise<boolean> =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFocused())

async function clickIntoTerminal(app: ElectronApplication, page: Page): Promise<void> {
  const point = await screenPointOf(app, centerTerm(page))
  realClick(point)
  await expect.poll(() => windowFocused(app)).toBe(true)
  realClick(point)
  await expect.poll(() => focusOwner(page)).toBe('tui')
}

async function goToBackground(app: ElectronApplication): Promise<void> {
  bringFinderToFront()
  await expect.poll(() => windowFocused(app)).toBe(false)
}

async function comeBackThroughTheDock(app: ElectronApplication): Promise<void> {
  realClick(dockItemCenter(DOCK_NAME))
  await expect.poll(() => windowFocused(app)).toBe(true)
}

async function endATurnWhileInBackground(
  app: ElectronApplication,
  page: Page,
  tabId: string
): Promise<void> {
  await goToBackground(app)
  await endTurn(page, tabId)
}

async function promptsStartingWith(
  env: E2EEnv,
  page: Page,
  tabId: string,
  start: string
): Promise<string[]> {
  const sessionId = (await boundSessionId(page, tabId)) ?? ''
  return claudePrompts(transcriptFile(env.home, env.workspaces.a, sessionId)).filter((p) =>
    p.startsWith(start)
  )
}

test.describe('a real Mac screen: keys, mouse, Dock, banners and input methods as macOS itself delivers and draws them', () => {
  test('⌘P typed on the keyboard while the session terminal has focus opens the command palette through the app menu', async ({
    shown: { app, page }
  }, testInfo) => {
    await sessionIn(page, 'ws-a')
    await clickIntoTerminal(app, page)
    realKey(KEY_P, COMMAND_FLAG)
    await expect(palette(page)).toBeVisible()
    await expect(palette(page).getByRole('textbox', { name: 'Ask or jump' })).toBeFocused()
    screenshot(testInfo.outputPath('palette-open.png'))
  })

  test('dragging the title bar with the mouse moves the window along with it', async ({
    shown: { app, page }
  }, testInfo) => {
    await sessionIn(page, 'ws-a')
    await app.evaluate(({ BrowserWindow }, bounds) => {
      BrowserWindow.getAllWindows()[0].setBounds(bounds)
    }, ROOM_TO_DRAG_IN)
    const before = await windowBounds(app)
    const from = await bareScreenPointOf(app, page.locator('.center-top'))
    realDrag(from, { x: from.x + DRAG_BY.x, y: from.y + DRAG_BY.y })
    await expect
      .poll(async () => {
        const after = await windowBounds(app)
        const missedBy = Math.max(
          Math.abs(after.x - before.x - DRAG_BY.x),
          Math.abs(after.y - before.y - DRAG_BY.y)
        )
        return missedBy <= MAC_DRAG_SLACK_PX
      })
      .toBe(true)
    screenshot(testInfo.outputPath('window-moved.png'))
  })

  test('a turn that ends while Koloft is in the background draws its count on the Dock icon, and coming back clears it', async ({
    shown: { app, page }
  }, testInfo) => {
    const tabId = await sessionIn(page, 'ws-a')
    await endATurnWhileInBackground(app, page, tabId)
    await allowNotificationsWhenMacOSAsks(() => dockBadgeDrawn(DOCK_NAME) === '1')
    await expect.poll(() => dockBadgeDrawn(DOCK_NAME)).toBe('1')
    screenshot(testInfo.outputPath('dock-badge.png'))
    await comeBackThroughTheDock(app)
    await expect.poll(() => dockBadgeDrawn(DOCK_NAME)).toBe('')
  })

  test('a turn that ends while Koloft is in the background shows a macOS banner naming the session and what happened, once macOS has asked and been told Allow', async ({
    shown: { app, page }
  }, testInfo) => {
    // PLATFORM§46
    test.skip(!notificationCenterRunning(), 'this Mac runs no Notification Center to draw banners')
    const first = await sessionIn(page, 'ws-a')
    const second = await sessionIn(page, 'ws-b')
    await endATurnWhileInBackground(app, page, first)
    await allowNotificationsWhenMacOSAsks(() => bannerTexts().includes(FAKE_SESSION_TITLE))
    expect(await windowFocused(app)).toBe(false)
    await endTurn(page, second)
    await expect
      .poll(() => bannerTexts(), { timeout: 30_000 })
      .toContain('turn done — your move · ws-b')
    expect(bannerTexts()).toContain(FAKE_SESSION_TITLE)
    screenshot(testInfo.outputPath('banner.png'))
  })

  test('with macOS Pinyin, Return while composing puts the letters in the line without sending it, and Space picks 你好 for the next Return to send', async ({
    shown: { app, page },
    env
  }, testInfo) => {
    const tabId = await sessionIn(page, 'ws-a')
    try {
      await goToBackground(app)
      // PLATFORM§46
      selectInputSource(PINYIN_SIMPLIFIED)
      await comeBackThroughTheDock(app)
      await clickIntoTerminal(app, page)
      typeNihao()
      realKey(KEY_RETURN)
      await expect.poll(async () => (await terminalText(page, tabId)).trimEnd()).toMatch(/> nihao$/)
      typeNihao()
      realKey(KEY_SPACE)
      await expect.poll(async () => (await terminalText(page, tabId)).trimEnd()).toMatch(/你好$/)
      realKey(KEY_RETURN)
      await expect.poll(() => promptsStartingWith(env, page, tabId, 'nihao')).toEqual(['nihao你好'])
      screenshot(testInfo.outputPath('pinyin-sent.png'))
    } finally {
      selectInputSource(ABC_LAYOUT)
    }
  })
})
