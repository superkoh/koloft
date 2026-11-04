import { test, expect } from './helpers/app'
import { startSessionIn, wsRows } from './helpers/p1'
import { BROWSER, globeIcon, guestByUrl, newWebTab, openBrowser, typeInAddressBar } from './helpers/browser'
import { startEchoServer } from './helpers/fixtureServer'

test('probe #1464: a second page asking for sign-in while the first one asks', async ({
  app,
  page
}) => {
  test.setTimeout(240_000)
  const server = await startEchoServer()
  try {
    await startSessionIn(page, 'ws-a')
    await expect(globeIcon(page)).toBeVisible({ timeout: 30_000 })
    await openBrowser(page)
    await newWebTab(page)
    await typeInAddressBar(page, server.url('/auth'))
    const modal = page.locator(BROWSER.modal)
    await expect(modal).toBeVisible({ timeout: 40_000 })
    console.log('first dialog text:', await modal.innerText())
    await modal.getByPlaceholder('Username').fill('first-user')
    await modal.getByPlaceholder('Password').fill('first-pass')
    const authBefore = server.count('/auth')

    const tabId = (await wsRows(page, 'ws-a').getAttribute('data-tab-id'))!
    const second = server.localhostUrl('/auth')
    await page.evaluate(([id, line]) => window.api.terminal.write(id, line), [
      tabId,
      `/open ${second}\r`
    ])
    await guestByUrl(app, second)
    await expect.poll(() => server.count('/auth'), { timeout: 30_000 }).toBeGreaterThan(authBefore)
    console.log('/auth requests before / after the second page:', authBefore, server.count('/auth'))
    await page.waitForTimeout(3000)

    console.log('dialogs shown:', await modal.count())
    console.log('dialog text now:', await modal.innerText())
    console.log(
      'fields now:',
      await modal.locator('input').evaluateAll((els) => els.map((el) => (el as HTMLInputElement).value))
    )
    const guest = await guestByUrl(app, second)
    console.log('second page shows:', (await guest.locator('body').innerText()).slice(0, 200))
  } finally {
    await server.close()
  }
})
