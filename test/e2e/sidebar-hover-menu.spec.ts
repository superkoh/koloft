import type { Locator } from '@playwright/test'
import { test, expect } from './helpers/app'
import { centerTerm, startSessionIn, wsRows } from './helpers/p1'

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
