import { test, expect } from './helpers/app'
import { guestByUrl } from './helpers/browser'
import { startEchoServer, type FixtureServer } from './helpers/fixtureServer'
import { centerTerm, runIn, startSessionIn } from './helpers/p1'
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

test.describe('C2 hover menu:resting the pointer on a row opens it, dragging a selection across a row never does', () => {
  test('T-HM-01: a text selection dragged out of a web page across a session row opens no menu, and a plain hover still does', async ({
    app,
    page
  }) => {
    test.setTimeout(180_000)
    await startSessionIn(page, 'ws-a')
    await runIn(page, centerTerm(page), `/open ${server.page('/text', TEXT_PAGE)}`)
    await wbTabs(page).nth(1).click()
    const guestPage = await guestByUrl(app, '/text')
    await guestPage.locator('p').waitFor()

    const guest = await page.locator('.wb-panel webview').boundingBox()
    const row = await page.locator('.ws-tab').first().boundingBox()
    await page.mouse.move(guest!.x + 200, guest!.y + 60)
    await page.mouse.down()
    await page.mouse.move(row!.x + row!.width / 2, row!.y + row!.height / 2, { steps: 20 })
    await page.waitForTimeout(PAST_HOVER_INTENT_DELAY_MS)
    await expect(page.locator('.menu')).toHaveCount(0)
    await page.mouse.up()
    expect(await guestPage.evaluate(() => getSelection()?.toString().length)).toBeGreaterThan(0)
    await page.waitForTimeout(PAST_HOVER_INTENT_DELAY_MS)
    await expect(page.locator('.menu')).toHaveCount(0)

    await page.mouse.move(600, 400)
    await page.locator('.ws-tab').first().hover()
    await expect(page.locator('.menu')).toBeVisible()
  })
})
