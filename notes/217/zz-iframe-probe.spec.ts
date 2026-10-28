import fs from 'fs'
import { test, expect } from './helpers/app'
import { startSessionIn, transcriptFile, boundSessionId, waitBooted, wsRows } from './helpers/p1'
import { BROWSER, INSPECT_MODE_SETTLES_MS, openPickPage } from './helpers/browser'
import { claudePrompts } from './helpers/workbench'
import { startEchoServer } from './helpers/fixtureServer'

const OUT = process.env.PROBE_OUT ?? 'iframe-probe.json'

test('probe: a pick inside a cross-origin iframe', async ({ app, page, env }) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  const out: Record<string, unknown> = {}
  try {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const tabId = await wsRows(page, 'ws-a').first().getAttribute('data-tab-id')
    const transcript = transcriptFile(
      env.home,
      env.workspaces.a,
      (await boundSessionId(page, tabId)) ?? ''
    )
    const inner = server
      .page(
        '/inner',
        '<!doctype html><title>Inner</title><button id="in" style="width:160px;height:50px">Inner</button><script>window.clicks=0;document.getElementById("in").onclick=()=>window.clicks++</script>'
      )
      .replace('127.0.0.1', 'localhost')
    const outerUrl = server.page(
      '/outer',
      `<!doctype html><title>Outer</title><p>outer</p><div id="buy">x</div><iframe id="f" src="${inner}" style="width:400px;height:200px;border:0"></iframe>`
    )
    const guest = await openPickPage(app, page, outerUrl)
    const frame = guest.frames().find((f) => f.url() === inner)
    out.frameFound = !!frame
    out.frames = await app.evaluate(({ webContents }, u) => {
      const wc = webContents.getAllWebContents().find((w) => w.getURL() === u)
      return wc?.mainFrame.framesInSubtree.map((f) => ({ url: f.url, processId: f.processId }))
    }, outerUrl)
    const button = page.locator(BROWSER.pickButton)
    await button.click()
    await page.waitForTimeout(INSPECT_MODE_SETTLES_MS)
    const box = await guest.locator('#f').boundingBox()
    if (!box) throw new Error('no iframe box')
    await guest.mouse.move(box.x + 80, box.y + 25)
    await guest.mouse.click(box.x + 80, box.y + 25)
    await page.waitForTimeout(3000)
    out.pressedAfter = await button.getAttribute('aria-pressed')
    out.innerClicks = frame ? await frame.evaluate('window.clicks') : null
    await page.keyboard.type(' IFRAME-PROBE')
    await page.keyboard.press('Enter')
    await page.waitForTimeout(5000)
    out.prompts = claudePrompts(transcript).filter((p) => p.includes('IFRAME-PROBE'))
    if (out.pressedAfter === 'true') {
      await button.click()
      out.stoppedByButton = await button.getAttribute('aria-pressed')
    }
  } finally {
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1))
    await server.close()
  }
  expect(out).toBeTruthy()
})
