import fs from 'fs'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as e2eTest, expect, launchApp, quitAndClose } from '../e2e/helpers/app'
import { seedSettings } from '../e2e/helpers/env'
import {
  FAKE_SESSION_TITLE,
  centerTerm,
  focusOwner,
  startSessionIn,
  terminalText,
  waitBooted,
  wsRows
} from '../e2e/helpers/p1'
import {
  ABC_LAYOUT,
  COMMAND_FLAG,
  KEY_ESCAPE,
  KEY_P,
  KEY_RETURN,
  KEY_SPACE,
  PINYIN_SIMPLIFIED,
  accessibilityTrusted,
  bannerTexts,
  bareScreenPointOf,
  bringFinderToFront,
  dockBadgeDrawn,
  dockItemCenter,
  notificationCenterRunning,
  realClick,
  realDrag,
  realKey,
  realType,
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

const UNPACKAGED_BUILD_RUNS_AS_ELECTRON_APP = 'Electron'
const DOCK_NAME = UNPACKAGED_BUILD_RUNS_AS_ELECTRON_APP
const palette = (page: Page) => page.locator('.modal.palette')
const DRAG_BY = { x: 160, y: 90 }
const ROOM_TO_DRAG_IN = { x: 40, y: 60, width: 760, height: 520 }
// PLATFORM§46
const MAC_DRAG_SLACK_PX = 6

async function sessionInWsA(page: Page): Promise<string> {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  return (await wsRows(page, 'ws-a').first().getAttribute('data-tab-id')) ?? ''
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
  await page.evaluate(([id, line]) => window.api.terminal.write(id, line), [tabId, '/answer hi\r'])
}

async function sentPrompts(page: Page, tabId: string): Promise<string[]> {
  const unwrapped = (await terminalText(page, tabId)).replace(/\n/g, '')
  return [...unwrapped.matchAll(/\[fake-claude\] handled: (.*?)>/g)].map((m) => m[1].trim())
}

test.describe('a real Mac screen: keys, mouse, Dock, banners and input methods as macOS itself delivers and draws them', () => {
  test('⌘P typed on the keyboard while the session terminal has focus opens the command palette through the app menu', async ({
    shown: { app, page }
  }, testInfo) => {
    await sessionInWsA(page)
    await clickIntoTerminal(app, page)
    realKey(KEY_P, COMMAND_FLAG)
    await expect(palette(page)).toBeVisible()
    await expect(palette(page).getByRole('textbox', { name: 'Ask or jump' })).toBeFocused()
    screenshot(testInfo.outputPath('palette-open.png'))
    realKey(KEY_ESCAPE)
    await expect(palette(page)).toHaveCount(0)
  })

  test('dragging the title bar with the mouse moves the window along with it', async ({
    shown: { app, page }
  }, testInfo) => {
    await sessionInWsA(page)
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
    const tabId = await sessionInWsA(page)
    await endATurnWhileInBackground(app, page, tabId)
    await expect.poll(() => dockBadgeDrawn(DOCK_NAME), { timeout: 30_000 }).toBe('1')
    screenshot(testInfo.outputPath('dock-badge.png'))
    await comeBackThroughTheDock(app)
    await expect.poll(() => dockBadgeDrawn(DOCK_NAME)).toBe('')
  })

  test('a turn that ends while Koloft is in the background shows a macOS banner naming the session and what happened', async ({
    shown: { app, page }
  }, testInfo) => {
    // PLATFORM§46
    test.skip(!notificationCenterRunning(), 'this Mac runs no Notification Center to draw banners')
    const tabId = await sessionInWsA(page)
    await endATurnWhileInBackground(app, page, tabId)
    for (let i = 0; i < 10; i++) {
      screenshot(testInfo.outputPath(`probe-${i}.png`))
      fs.appendFileSync(testInfo.outputPath('probe.txt'), `--- ${i}\n${bannerTexts()}\n`)
      await page.waitForTimeout(400)
    }
    await expect.poll(() => bannerTexts(), { timeout: 30_000 }).toContain(FAKE_SESSION_TITLE)
    expect(bannerTexts()).toContain('turn done — your move · ws-a')
    screenshot(testInfo.outputPath('banner.png'))
  })

  test('with macOS Pinyin, Return while composing puts the letters in the line without sending it, and Space picks 你好 for the next Return to send', async ({
    shown: { app, page }
  }, testInfo) => {
    const tabId = await sessionInWsA(page)
    try {
      await goToBackground(app)
      // PLATFORM§18
      selectInputSource(PINYIN_SIMPLIFIED)
      await comeBackThroughTheDock(app)
      await clickIntoTerminal(app, page)
      realType('nihao')
      realKey(KEY_RETURN)
      await expect.poll(async () => (await terminalText(page, tabId)).trimEnd()).toMatch(/> nihao$/)
      realType('nihao')
      realKey(KEY_SPACE)
      await expect.poll(async () => (await terminalText(page, tabId)).trimEnd()).toMatch(/你好$/)
      screenshot(testInfo.outputPath('pinyin-picked.png'))
      realKey(KEY_RETURN)
      await expect.poll(() => sentPrompts(page, tabId)).toEqual(['nihao你好'])
    } finally {
      selectInputSource(ABC_LAYOUT)
    }
  })
})
