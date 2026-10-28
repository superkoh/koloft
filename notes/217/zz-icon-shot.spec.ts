import { test } from './helpers/app'
import { startSessionIn, waitBooted } from './helpers/p1'
import { BROWSER, openPickPage, PICK_PAGE } from './helpers/browser'
import { startEchoServer } from './helpers/fixtureServer'

const OUT = process.env.SHOT_DIR ?? '.'

test('shot: the address bar before and after the pick button', async ({ app, page }) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  try {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await openPickPage(app, page, server.page('/pick', PICK_PAGE))
    const bar = page.locator(BROWSER.addressBar)
    await page.mouse.move(0, 0)
    const hide = await page.addStyleTag({
      content: '.baddr [aria-label="Pick an element"]{display:none !important}'
    })
    await bar.screenshot({ path: `${OUT}/bar-before-1x.png` })
    await hide.evaluate((el) => el.remove())
    await bar.screenshot({ path: `${OUT}/bar-after-1x.png` })
    await page.locator(BROWSER.pickButton).click()
    await page.mouse.move(0, 0)
    await bar.screenshot({ path: `${OUT}/bar-picking-1x.png` })
    await page.keyboard.press('Escape')
    await page.evaluate(() => {
      const el = document.querySelector('.baddr') as HTMLElement
      el.style.zoom = '4'
    })
    const hide4 = await page.addStyleTag({
      content: '.baddr [aria-label="Pick an element"]{display:none !important}'
    })
    await bar.screenshot({ path: `${OUT}/bar-before-4x.png` })
    await hide4.evaluate((el) => el.remove())
    await bar.screenshot({ path: `${OUT}/bar-after-4x.png` })
  } finally {
    await server.close()
  }
})
