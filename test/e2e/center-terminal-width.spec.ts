import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { installCodex, seedSettings, type E2EEnv } from './helpers/env'
import { closeSettings, openSettings } from './helpers/extensions'
import {
  addRemoteWorkspace,
  killFakeRemote,
  launchWithRemote,
  REMOTE_WS_NAME
} from './helpers/remote'
import {
  centerTerm,
  clickAppMenuItem,
  focusOwner,
  openSessionTerminal,
  startSessionIn,
  waitBooted
} from './helpers/p1'
import { seedWorkbenchDefault } from './helpers/workbench'

const CENTER_MAX_COLS = 140
const MIN_SIDE_GUTTER_PX = 24
const SUBPIXEL_PX = 2
const BELOW_THE_WINDOW_MIN_WIDTH_PX = 900
const WIDE_WINDOW_PX = 1720

test.afterEach(({ env }) => killFakeRemote(env))

function shownCenterCols(page: Page): Promise<number | undefined> {
  return page.evaluate(() => {
    const terms = (
      window as unknown as {
        __koloftTerms?: Record<string, { cols: number; element?: HTMLElement }>
      }
    ).__koloftTerms
    return Object.values(terms ?? {}).find((t) => {
      const wrap = t.element?.closest<HTMLElement>('.term-island .term-wrap')
      return !!wrap && wrap.style.display !== 'none' && wrap.style.visibility !== 'hidden'
    })?.cols
  })
}

function shownPanelCols(page: Page): Promise<number | undefined> {
  return page.evaluate(() => {
    const terms = (
      window as unknown as {
        __koloftTerms?: Record<string, { cols: number; element?: HTMLElement }>
      }
    ).__koloftTerms
    return Object.values(terms ?? {}).find(
      (t) => !!t.element?.closest('.wb-term') && !!t.element.getClientRects().length
    )?.cols
  })
}

function centerLayout(page: Page): Promise<{
  leftGap: number
  rightGap: number
  clockGap: number
  termMaxWidth: string
}> {
  return page.evaluate(() => {
    const wrap = [...document.querySelectorAll<HTMLElement>('.term-island .term-wrap')].find(
      (w) => w.style.display !== 'none' && w.style.visibility !== 'hidden'
    )!
    const termEl = wrap.querySelector<HTMLElement>('.term')!
    const term = termEl.getBoundingClientRect()
    const col = document.querySelector('.term-col')!
    let rightNeighbour = col.nextElementSibling
    while (rightNeighbour && getComputedStyle(rightNeighbour).position === 'absolute') {
      rightNeighbour = rightNeighbour.nextElementSibling
    }
    const row = document.querySelector('.center-row')!.getBoundingClientRect()
    const rightEdge = rightNeighbour ? rightNeighbour.getBoundingClientRect().left : row.right
    const clock = document.querySelector('.center-top .wc')!.getBoundingClientRect()
    const colLeft = col.getBoundingClientRect().left
    return {
      leftGap: term.left - colLeft,
      rightGap: rightEdge - term.right,
      clockGap: clock.left - colLeft,
      termMaxWidth: termEl.style.maxWidth
    }
  })
}

async function setWindowWidth(app: ElectronApplication, width: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }, w) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.setSize(w, win.getSize()[1])
  }, width)
}

async function launchWithPanelShut(env: E2EEnv): Promise<{ app: ElectronApplication; page: Page }> {
  seedWorkbenchDefault(env, false)
  seedSettings(env, { hintsOff: true })
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await waitBooted(page)
  return { app, page }
}

test.describe('the center session terminal stops at 140 columns and sits centred, with at least 24 px on each side; the Workbench terminal still fills its pane', () => {
  test('a narrow window fills the Claude tab 24 px in from each side; widened, it holds at 140 columns, centred, the pty told so, while the world clock stays at the left edge, at any font size; a click in the margin lands in the terminal; the Workbench terminal goes past 140', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const { app, page } = await launchWithPanelShut(env)
    try {
      await setWindowWidth(app, BELOW_THE_WINDOW_MIN_WIDTH_PX)
      await startSessionIn(page, 'ws-a')
      await expect.poll(() => shownCenterCols(page), { timeout: 30_000 }).toBeGreaterThan(0)
      expect(await shownCenterCols(page)).toBeLessThan(CENTER_MAX_COLS)
      const narrow = await centerLayout(page)
      expect(Math.abs(narrow.leftGap - MIN_SIDE_GUTTER_PX)).toBeLessThanOrEqual(SUBPIXEL_PX)
      expect(Math.abs(narrow.rightGap - MIN_SIDE_GUTTER_PX)).toBeLessThanOrEqual(SUBPIXEL_PX)
      expect(Math.abs(narrow.clockGap - MIN_SIDE_GUTTER_PX)).toBeLessThanOrEqual(SUBPIXEL_PX)

      await setWindowWidth(app, WIDE_WINDOW_PX)
      await expect.poll(() => shownCenterCols(page), { timeout: 30_000 }).toBe(CENTER_MAX_COLS)
      await expect(centerTerm(page)).toContainText(`[fake-claude] winch ${CENTER_MAX_COLS}x`, {
        timeout: 30_000
      })
      const wide = await centerLayout(page)
      expect(wide.leftGap).toBeGreaterThan(MIN_SIDE_GUTTER_PX + SUBPIXEL_PX)
      expect(Math.abs(wide.leftGap - wide.rightGap)).toBeLessThanOrEqual(SUBPIXEL_PX)
      expect(Math.abs(wide.clockGap - MIN_SIDE_GUTTER_PX)).toBeLessThanOrEqual(SUBPIXEL_PX)

      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur())
      expect(await focusOwner(page)).not.toBe('tui')
      const wrapBox = (await page.locator('.term-island .term-wrap:visible').boundingBox())!
      await page.mouse.click(wrapBox.x + MIN_SIDE_GUTTER_PX / 2, wrapBox.y + wrapBox.height / 2)
      await expect.poll(() => focusOwner(page)).toBe('tui')

      await openSettings(page)
      await page.locator('.set-ni', { hasText: 'Appearance' }).click()
      await page.getByRole('button', { name: 'Smaller' }).click()
      await page.getByRole('button', { name: 'Smaller' }).click()
      await closeSettings(page)
      await expect
        .poll(async () => (await centerLayout(page)).termMaxWidth, { timeout: 20_000 })
        .not.toBe(wide.termMaxWidth)
      expect(await shownCenterCols(page)).toBe(CENTER_MAX_COLS)
      const smaller = await centerLayout(page)
      expect(smaller.leftGap).toBeGreaterThan(wide.leftGap)
      expect(Math.abs(smaller.leftGap - smaller.rightGap)).toBeLessThanOrEqual(SUBPIXEL_PX)
      expect(Math.abs(smaller.clockGap - MIN_SIDE_GUTTER_PX)).toBeLessThanOrEqual(SUBPIXEL_PX)

      await clickAppMenuItem(app, page, 'toggle-sidebar')
      await expect(page.locator('.app.sb-off')).toHaveCount(1)
      await expect
        .poll(async () => (await centerLayout(page)).leftGap, { timeout: 20_000 })
        .toBeGreaterThan(smaller.leftGap)
      const noSidebar = await centerLayout(page)
      expect(Math.abs(noSidebar.leftGap - noSidebar.rightGap)).toBeLessThanOrEqual(SUBPIXEL_PX)
      expect(noSidebar.clockGap).toBeGreaterThan(MIN_SIDE_GUTTER_PX + SUBPIXEL_PX)
      expect(noSidebar.clockGap).toBeLessThan(noSidebar.leftGap)

      await openSessionTerminal(app, page)
      await clickAppMenuItem(app, page, 'toggle-focus-mode')
      await expect
        .poll(() => shownPanelCols(page), { timeout: 20_000 })
        .toBeGreaterThan(CENTER_MAX_COLS)
    } finally {
      await quitAndClose(app)
    }
  })

  test('a local Codex tab stops at 140 columns too', async ({ env }) => {
    test.setTimeout(180_000)
    installCodex(env)
    const { app, page } = await launchWithPanelShut(env)
    try {
      await setWindowWidth(app, WIDE_WINDOW_PX)
      await startSessionIn(page, 'ws-a', { method: 'Codex' })
      await expect.poll(() => shownCenterCols(page), { timeout: 20_000 }).toBe(CENTER_MAX_COLS)
    } finally {
      await quitAndClose(app)
    }
  })

  test('a remote Claude tab stops at 140 columns too', async ({ env }) => {
    test.setTimeout(240_000)
    seedWorkbenchDefault(env, false)
    seedSettings(env, { hintsOff: true })
    const { app, page } = await launchWithRemote(env)
    try {
      await setWindowWidth(app, WIDE_WINDOW_PX)
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      await expect.poll(() => shownCenterCols(page), { timeout: 30_000 }).toBe(CENTER_MAX_COLS)
    } finally {
      await quitAndClose(app)
    }
  })
})
