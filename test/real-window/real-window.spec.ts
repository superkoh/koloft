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
  BROWSER,
  INSPECT_MODE_SETTLES_MS,
  PICKED_LABEL,
  PICK_PAGE,
  cdpEndpointOf,
  connectCdp,
  openPickPage
} from '../e2e/helpers/browser'
import { startEchoServer } from '../e2e/helpers/fixtureServer'
import {
  ABC_LAYOUT,
  COMMAND_FLAG,
  KEY_K,
  KEY_O,
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

// PLATFORM§52
const DOCK_NAME = 'Electron'
const palette = (page: Page) => page.locator('.modal.palette')
const DRAG_BY = { x: 160, y: 90 }
const ROOM_TO_DRAG_IN = { x: 40, y: 60, width: 760, height: 520 }
// PLATFORM§52
const MAC_DRAG_SLACK_PX = 6
const MACOS_ASKS_TO_ALLOW_NOTIFICATIONS = 'Notifications may include'
const TIME_FOR_COMING_BACK_TO_CLEAR_ANYTHING_MS = 3_000
const TIME_FOR_A_MENU_KEY_TO_LAND_MS = 1_500

async function allowNotificationsWhenMacOSAsks(shownAnyway: () => boolean): Promise<void> {
  await expect
    .poll(() => shownAnyway() || bannerShowing(MACOS_ASKS_TO_ALLOW_NOTIFICATIONS), {
      timeout: 30_000
    })
    .toBe(true)
  if (!bannerShowing(MACOS_ASKS_TO_ALLOW_NOTIFICATIONS)) return
  // PLATFORM§52
  expect(chooseOnBanner(MACOS_ASKS_TO_ALLOW_NOTIFICATIONS, 'Allow')).toBe('0')
  await expect.poll(() => bannerShowing(MACOS_ASKS_TO_ALLOW_NOTIFICATIONS)).toBe(false)
}

async function sessionIn(page: Page, ws: string): Promise<string> {
  await startSessionIn(page, ws)
  return (await wsRows(page, ws).first().getAttribute('data-tab-id')) ?? ''
}

function typeInSession(page: Page, tabId: string, line: string): Promise<void> {
  return page.evaluate(([id, text]) => window.api.terminal.write(id, text), [tabId, line])
}

function endTurn(page: Page, tabId: string): Promise<void> {
  return typeInSession(page, tabId, '/answer hi\r')
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

  // PLATFORM§7
  test('⌘⏎ typed on the keyboard in ⌘P, with a session open and Focus Mode ready on ⌘⏎, reaches the palette and starts the words, and Focus Mode stays off', async ({
    shown: { app, page }
  }) => {
    await page.evaluate(() => window.api.settings.set({ assist: { on: false, backend: 'claude' } }))
    await sessionIn(page, 'ws-a')
    await clickIntoTerminal(app, page)
    realKey(KEY_P, COMMAND_FLAG)
    const field = palette(page).getByRole('textbox', { name: 'Ask or jump' })
    await expect(field).toBeFocused()
    await field.fill('read the readme')
    expect(
      await app.evaluate(
        ({ Menu }) => Menu.getApplicationMenu()?.getMenuItemById('toggle-focus-mode')?.enabled
      )
    ).toBe(true)
    realKey(KEY_RETURN, COMMAND_FLAG)
    await expect(page.getByRole('dialog', { name: 'New Session in…' })).toBeVisible()
    await expect(palette(page)).toHaveCount(0)
    const terminalShown = (): Promise<boolean> =>
      page.evaluate(
        () => ((document.querySelector('.term-island') as HTMLElement | null)?.offsetWidth ?? 0) > 0
      )
    await page.waitForTimeout(TIME_FOR_A_MENU_KEY_TO_LAND_MS)
    expect(await terminalShown()).toBe(true)
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

  test('a turn that ends while Koloft is in the background draws its count on the Dock icon; coming back keeps it, and only the session working again clears it', async ({
    shown: { app, page }
  }, testInfo) => {
    const tabId = await sessionIn(page, 'ws-a')
    await endATurnWhileInBackground(app, page, tabId)
    await allowNotificationsWhenMacOSAsks(() => dockBadgeDrawn(DOCK_NAME) === '1')
    await expect.poll(() => dockBadgeDrawn(DOCK_NAME)).toBe('1')
    screenshot(testInfo.outputPath('dock-badge.png'))
    await comeBackThroughTheDock(app)
    await page.waitForTimeout(TIME_FOR_COMING_BACK_TO_CLEAR_ANYTHING_MS)
    expect(dockBadgeDrawn(DOCK_NAME)).toBe('1')
    await typeInSession(page, tabId, '/busy\r')
    await expect.poll(() => dockBadgeDrawn(DOCK_NAME)).toBe('')
  })

  test('a turn that ends while Koloft is in the background shows a macOS banner naming the session and what happened, once macOS has asked and been told Allow', async ({
    shown: { app, page }
  }, testInfo) => {
    // PLATFORM§52
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
      // PLATFORM§52
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

  // PLATFORM§10
  test('with macOS Pinyin, a word half typed in one session survives another session’s agent clicking into a field of its Workbench page; the click lands once the word is picked', async ({
    shown: { app, page },
    env
  }, testInfo) => {
    const server = await startEchoServer()
    await sessionIn(page, 'ws-a')
    const browser = await connectCdp(page, await cdpEndpointOf(env))
    const typing = await sessionIn(page, 'ws-b')
    try {
      const driven = await browser.contexts()[0].newPage()
      await driven.goto(server.page('/form', '<body><input id="name"></body>'))
      await goToBackground(app)
      // PLATFORM§52
      selectInputSource(PINYIN_SIMPLIFIED)
      await comeBackThroughTheDock(app)
      await clickIntoTerminal(app, page)
      const before = (await terminalText(page, typing)).trimEnd()
      typeNihao()
      const clicked = driven.click('#name')
      await page.waitForTimeout(1_000)
      realKey(KEY_SPACE)
      await expect
        .poll(async () =>
          (await terminalText(page, typing)).trimEnd().slice(before.length).replace(/\s/g, '')
        )
        .toBe('你好')
      await clicked
      expect(await driven.evaluate(() => document.activeElement?.id)).toBe('name')
      screenshot(testInfo.outputPath('pinyin-kept.png'))
    } finally {
      selectInputSource(ABC_LAYOUT)
      await browser.close().catch(() => {})
      await server.close()
    }
  })

  test('an element picked with the real mouse lands in the session, and the words typed next on the real keyboard go to the session, not the page', async ({
    shown: { app, page },
    env
  }, testInfo) => {
    const server = await startEchoServer()
    try {
      const tabId = await sessionIn(page, 'ws-a')
      const url = server.page('/pick', PICK_PAGE)
      const guest = await openPickPage(app, page, url)
      await clickIntoTerminal(app, page)

      realClick(await screenPointOf(app, page.locator(BROWSER.pickButton)))
      await expect(page.locator(BROWSER.pickButton)).toHaveAttribute('aria-pressed', 'true')
      await page.waitForTimeout(INSPECT_MODE_SETTLES_MS)
      const content = await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].getContentBounds()
      )
      const host = await page.evaluate((u) => {
        const el = [...document.querySelectorAll('webview')].find(
          (w) => (w as unknown as { getURL(): string }).getURL() === u
        )
        const r = el?.getBoundingClientRect()
        return r ? { x: r.x, y: r.y } : null
      }, url)
      const inGuest = await guest.locator('#buy').boundingBox()
      if (!host || !inGuest) throw new Error('the picked button has no place on screen')
      realClick({
        x: content.x + host.x + inGuest.x + inGuest.width / 2,
        y: content.y + host.y + inGuest.y + inGuest.height / 2
      })
      await expect(page.locator(BROWSER.pickButton)).toHaveAttribute('aria-pressed', 'false')
      await expect.poll(() => focusOwner(page)).toBe('tui')
      realKey(KEY_O)
      realKey(KEY_K)
      realKey(KEY_RETURN)

      await expect
        .poll(() => promptsStartingWith(env, page, tabId, 'Element picked'), { timeout: 30_000 })
        .toHaveLength(1)
      const [prompt] = await promptsStartingWith(env, page, tabId, 'Element picked')
      expect(prompt).toContain(`Element: ${PICKED_LABEL}`)
      expect(prompt.endsWith('ok')).toBe(true)
      expect(await guest.evaluate('window.clicks')).toBe(0)
      screenshot(testInfo.outputPath('picked.png'))
    } finally {
      await server.close()
    }
  })
})
