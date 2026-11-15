import type { Locator } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  centerTerm,
  gitInit,
  startSessionIn,
  waitBooted,
  worktreeDialog,
  wsRows
} from './helpers/p1'

const PAST_HOVER_INTENT_DELAY_MS = 600

const centerOf = async (el: Locator): Promise<{ x: number; y: number }> => {
  const box = (await el.boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

test.describe('C2 hover menu — resting the pointer on a row opens it, dragging a selection across a row never does', () => {
  test('T-HM-01: a mouse release the window never saw pressed — what a release inside a web page also sends the window — neither opens a row menu nor hovers the row, and a plain hover still opens it', async ({
    page
  }) => {
    await startSessionIn(page, 'ws-a')
    const row = wsRows(page, 'ws-a').first()
    const menu = page.locator('.menu')
    const host = await page.context().newCDPSession(page)
    await host.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...(await centerOf(row)),
      button: 'left',
      clickCount: 1
    })
    await page.waitForTimeout(PAST_HOVER_INTENT_DELAY_MS)
    await expect(menu).toHaveCount(0)
    expect(await row.evaluate((el) => el.matches(':hover'))).toBe(false)

    await centerTerm(page).hover()
    await row.hover()
    await expect(menu).toBeVisible()
  })

  test('T-HM-03: clicking a row to switch to its session opens no menu while the pointer rests there', async ({
    page
  }) => {
    await startSessionIn(page, 'ws-a')
    await startSessionIn(page, 'ws-b')
    const row = wsRows(page, 'ws-a').first()
    await centerTerm(page).hover()
    await row.click()
    await expect(row).toHaveClass(/\bactive\b/)
    await page.waitForTimeout(PAST_HOVER_INTENT_DELAY_MS)
    await expect(page.locator('.menu')).toHaveCount(0)
  })

  test('T-HM-04: a worktree session made from the folder row’s icon opens no menu at any moment while the pointer rests on the icon, and moving on the row still opens it', async ({
    env
  }) => {
    test.setTimeout(120_000)
    gitInit(env.workspaces.a)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const head = page.locator('.ws-head', { hasText: 'ws-a' })
      await head.getByRole('button', { name: /^New worktree session/ }).click()
      const dlg = worktreeDialog(page)
      await expect(dlg).toBeVisible()
      await page.evaluate(() => {
        const seen = window as unknown as { menuEverShown?: boolean }
        new MutationObserver(() => {
          if (document.querySelector('.menu')) seen.menuEverShown = true
        }).observe(document.body, { childList: true, subtree: true })
      })
      await page.keyboard.type('feat1')
      await page.keyboard.press('Enter')
      await expect(dlg).toHaveCount(0)
      await expect(wsRows(page, 'ws-a').first()).toHaveClass(/st-working|st-waiting/, {
        timeout: 60_000
      })
      await page.waitForTimeout(PAST_HOVER_INTENT_DELAY_MS)
      const menuEverShown = await page.evaluate(
        () => (window as unknown as { menuEverShown?: boolean }).menuEverShown ?? false
      )
      expect(menuEverShown).toBe(false)

      const name = await centerOf(head.locator('.ws-name'))
      await page.mouse.move(name.x, name.y, { steps: 5 })
      await expect(page.locator('.menu')).toBeVisible()
    } finally {
      await quitAndClose(app)
    }
  })

  test('T-HM-02: a terminal selection dragged across a session row opens no menu', async ({
    page
  }) => {
    await startSessionIn(page, 'ws-a')
    const row = wsRows(page, 'ws-a').first()
    const term = (await centerTerm(page).boundingBox())!
    await page.mouse.move(term.x + 200, term.y + 40)
    await page.mouse.down()
    const rowCenter = await centerOf(row)
    await page.mouse.move(rowCenter.x, rowCenter.y, { steps: 20 })
    await page.waitForTimeout(PAST_HOVER_INTENT_DELAY_MS)
    await expect(page.locator('.menu')).toHaveCount(0)
    await page.mouse.up()
  })
})
