import { test, expect } from './helpers/app'
import { guestByUrl, openViaAgent } from './helpers/browser'
import { startEchoServer, type FixtureServer } from './helpers/fixtureServer'
import { centerTerm, startSessionIn, wsRows } from './helpers/p1'
import { wbTabs } from './helpers/workbench'

let server: FixtureServer

test.beforeAll(async () => {
  server = await startEchoServer()
})

test.afterAll(async () => {
  await server?.close()
})

const TEXT_PAGE = `<!doctype html><title>Text</title>
<p style="font-size:20px;line-height:40px">${'lorem ipsum dolor sit amet '.repeat(200)}</p>`
const PAST_HOVER_INTENT_DELAY_MS = 600

test.describe('C2 hover menu — resting the pointer on a row opens it, dragging a selection across a row never does', () => {
  test('T-HM-01: a text selection released inside a web page, whose release the host also gets at the page-local point over a session row, neither opens the menu nor hovers the row, and a plain hover still opens it', async ({
    app,
    page
  }) => {
    test.setTimeout(180_000)
    await startSessionIn(page, 'ws-a')
    await openViaAgent(page, server.page('/text', TEXT_PAGE))
    await wbTabs(page).nth(1).click()
    const guestPage = await guestByUrl(app, '/text')
    await guestPage.locator('p').waitFor()

    const row = wsRows(page, 'ws-a').first()
    const menu = page.locator('.menu')
    const rowBox = await row.boundingBox()
    const pageLocalRelease = {
      x: rowBox!.x + rowBox!.width / 2,
      y: rowBox!.y + rowBox!.height / 2
    }
    await guestPage.mouse.move(400, pageLocalRelease.y)
    await guestPage.mouse.down()
    await guestPage.mouse.move(pageLocalRelease.x, pageLocalRelease.y, { steps: 10 })
    await guestPage.mouse.up()
    expect(await guestPage.evaluate(() => getSelection()?.toString().length)).toBeGreaterThan(0)
    const host = await page.context().newCDPSession(page)
    await host.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...pageLocalRelease,
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
    const rowBox = await row.boundingBox()
    const term = await centerTerm(page).boundingBox()
    await page.mouse.move(term!.x + 200, term!.y + 40)
    await page.mouse.down()
    await page.mouse.move(rowBox!.x + rowBox!.width / 2, rowBox!.y + rowBox!.height / 2, {
      steps: 20
    })
    await page.waitForTimeout(PAST_HOVER_INTENT_DELAY_MS)
    await expect(page.locator('.menu')).toHaveCount(0)
    await page.mouse.up()
  })
})
