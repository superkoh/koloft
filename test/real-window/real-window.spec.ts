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
  COMMAND_FLAG,
  KEY_ESCAPE,
  KEY_P,
  accessibilityTrusted,
  bannerTexts,
  bareScreenPointOf,
  bringFinderToFront,
  dockBadgeDrawn,
  dockItemCenter,
  notificationCenterRunning,
  selectInputSource,
  currentInputSource,
  realType,
  KEY_RETURN,
  KEY_SPACE,
  PINYIN_SIMPLIFIED,
  ABC_LAYOUT,
  realClick,
  realDrag,
  realKey,
  screenPointOf,
  screenshot,
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

async function sessionInWsA(page: Page): Promise<void> {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
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

async function endATurnWhileInBackground(app: ElectronApplication, page: Page): Promise<void> {
  bringFinderToFront()
  await expect.poll(() => windowFocused(app)).toBe(false)
  const tabId = (await wsRows(page, 'ws-a').first().getAttribute('data-tab-id')) ?? ''
  await page.evaluate(([id, line]) => window.api.terminal.write(id, line), [tabId, '/answer hi\r'])
}

test.describe('a real Mac screen: keys, mouse, Dock and banners as macOS itself delivers and draws them', () => {
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
    await sessionInWsA(page)
    await endATurnWhileInBackground(app, page)
    await expect.poll(() => dockBadgeDrawn(DOCK_NAME), { timeout: 30_000 }).toBe('1')
    screenshot(testInfo.outputPath('dock-badge.png'))
    realClick(dockItemCenter(DOCK_NAME))
    await expect.poll(() => windowFocused(app)).toBe(true)
    await expect.poll(() => dockBadgeDrawn(DOCK_NAME)).toBe('')
  })

  test('PROBE: macOS Pinyin in the session terminal, Return while composing and Space-then-Return', async ({
    shown: { app, page }
  }, testInfo) => {
    await sessionInWsA(page)
    const tabId = (await wsRows(page, 'ws-a').first().getAttribute('data-tab-id')) ?? ''
    await clickIntoTerminal(app, page)
    await page.evaluate(() => {
      const log: unknown[] = []
      ;(window as unknown as { __keyLog: unknown[] }).__keyLog = log
      for (const type of [
        'keydown',
        'keyup',
        'compositionstart',
        'compositionupdate',
        'compositionend',
        'input'
      ])
        document.addEventListener(
          type,
          (e) => {
            const k = e as KeyboardEvent & { data?: string; inputType?: string }
            log.push({
              type: e.type,
              key: k.key,
              keyCode: k.keyCode,
              isComposing: k.isComposing,
              data: k.data,
              inputType: k.inputType
            })
          },
          true
        )
    })
    const dump = async (name: string): Promise<void> => {
      screenshot(testInfo.outputPath(`${name}.png`))
      fs.writeFileSync(
        testInfo.outputPath(`${name}.json`),
        JSON.stringify(
          {
            source: currentInputSource(),
            focus: await focusOwner(page),
            keys: await page.evaluate(() =>
              (window as unknown as { __keyLog: unknown[] }).__keyLog.splice(0)
            ),
            terminal: (await terminalText(page, tabId)).split('\n').filter(Boolean).slice(-8)
          },
          null,
          2
        )
      )
    }
    try {
      selectInputSource(PINYIN_SIMPLIFIED)
      await page.waitForTimeout(1000)
      realType('nihao')
      await page.waitForTimeout(800)
      await dump('1-composing')
      realKey(KEY_RETURN)
      await page.waitForTimeout(1500)
      await dump('2-after-return')
      realType('nihao')
      await page.waitForTimeout(800)
      realKey(KEY_SPACE)
      await page.waitForTimeout(800)
      await dump('3-after-space')
      realKey(KEY_RETURN)
      await page.waitForTimeout(1500)
      await dump('4-after-second-return')
      selectInputSource(ABC_LAYOUT)
      await page.waitForTimeout(800)
      realType('hi')
      realKey(KEY_RETURN)
      await page.waitForTimeout(1500)
      await dump('5-plain-hi-return')
    } finally {
      selectInputSource(ABC_LAYOUT)
    }
  })

  test('a turn that ends while Koloft is in the background shows a macOS banner naming the session and what happened', async ({
    shown: { app, page }
  }, testInfo) => {
    // PLATFORM§46
    test.skip(!notificationCenterRunning(), 'this Mac runs no Notification Center to draw banners')
    await sessionInWsA(page)
    await endATurnWhileInBackground(app, page)
    await expect
      .poll(() =>
        app.evaluate(() => (globalThis as { __koloftOsNotifCount?: number }).__koloftOsNotifCount)
      )
      .toBe(1)
    await expect.poll(() => bannerTexts(), { timeout: 30_000 }).toContain(FAKE_SESSION_TITLE)
    expect(bannerTexts()).toContain('turn done — your move · ws-a')
    screenshot(testInfo.outputPath('banner.png'))
  })
})
