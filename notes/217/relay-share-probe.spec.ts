import fs from 'fs'
import { test, expect } from './helpers/app'
import { startSessionIn, waitBooted } from './helpers/p1'
import { cdpEndpointOf, connectCdp } from './helpers/browser'
import { startEchoServer } from './helpers/fixtureServer'

const OUT = process.env.PROBE_OUT ?? 'share-probe.json'

test('a pick through the relay-held debugger leaves the agent Playwright working', async ({
  app,
  page,
  env
}) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  const url = server.page(
    '/pick',
    '<!doctype html><title>Pick</title><div style="height:1500px">top</div><button id="b" style="width:200px;height:60px;background:rgb(10,120,250)">Buy</button><script>window.clicks=0;document.getElementById("b").onclick=()=>window.clicks++</script>'
  )
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  const endpoint = await cdpEndpointOf(env)
  const browser = await connectCdp(page, endpoint)
  const agentPage = await browser.contexts()[0].newPage()
  await agentPage.goto(url)
  await agentPage.locator('#b').scrollIntoViewIfNeeded()
  const handle = await agentPage.$('#b')
  await agentPage.click('#b')
  const out: Record<string, unknown> = {}
  out.clicksBefore = await agentPage.evaluate('window.clicks')

  out.pick = await app.evaluate(async ({ webContents }, pageUrl) => {
    const wc = webContents.getAllWebContents().find((w) => w.getURL() === pageUrl)
    if (!wc) return { error: 'no guest' }
    const d = wc.debugger
    const r: Record<string, unknown> = { attachedBefore: d.isAttached() }
    const events: { method: string; params: { backendNodeId?: number } }[] = []
    const onMsg = (_e: unknown, method: string, params: { backendNodeId?: number }): void => {
      if (method.startsWith('Overlay.')) events.push({ method, params })
    }
    d.on('message', onMsg as never)
    await d.sendCommand('DOM.enable')
    await d.sendCommand('CSS.enable')
    await d.sendCommand('Overlay.enable')
    await d.sendCommand('Overlay.setInspectMode', {
      mode: 'searchForNode',
      highlightConfig: { contentColor: { r: 111, g: 168, b: 220, a: 0.66 } }
    })
    const rect = JSON.parse(
      (await wc.executeJavaScript(
        'JSON.stringify(document.getElementById("b").getBoundingClientRect())'
      )) as string
    )
    const x = rect.x + rect.width / 2
    const y = rect.y + rect.height / 2
    await d.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await d.sendCommand('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      clickCount: 1
    })
    await d.sendCommand('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x,
      y,
      button: 'left',
      clickCount: 1
    })
    await new Promise((res) => setTimeout(res, 400))
    r.events = events.map((e) => e.method)
    const req = events.find((e) => e.method === 'Overlay.inspectNodeRequested')
    if (req?.params.backendNodeId) {
      const backendNodeId = req.params.backendNodeId
      r.html = (
        (await d.sendCommand('DOM.getOuterHTML', { backendNodeId })) as { outerHTML: string }
      ).outerHTML
      await d.sendCommand('DOM.getDocument', { depth: 0 })
      const pushed = (await d.sendCommand('DOM.pushNodesByBackendIdsToFrontend', {
        backendNodeIds: [backendNodeId]
      })) as { nodeIds: number[] }
      const cs = (await d.sendCommand('CSS.getComputedStyleForNode', {
        nodeId: pushed.nodeIds[0]
      })) as { computedStyle: unknown[] }
      r.computedCount = cs.computedStyle.length
      const box = (await d.sendCommand('DOM.getBoxModel', { backendNodeId })) as {
        model: { border: number[] }
      }
      const lm = (await d.sendCommand('Page.getLayoutMetrics')) as {
        cssVisualViewport: { pageX: number; pageY: number }
      }
      const q = box.model.border
      const shot = (await d.sendCommand('Page.captureScreenshot', {
        format: 'png',
        clip: {
          x: q[0] + lm.cssVisualViewport.pageX,
          y: q[1] + lm.cssVisualViewport.pageY,
          width: q[2] - q[0],
          height: q[5] - q[1],
          scale: 1
        }
      })) as { data: string }
      r.shotBytes = Buffer.from(shot.data, 'base64').length
    }
    await d.sendCommand('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} })
    d.off('message', onMsg as never)
    r.attachedAfter = d.isAttached()
    r.clicksDuringPick = await wc.executeJavaScript('window.clicks')
    return r
  }, url)

  await agentPage.click('#b')
  out.clicksAfter = await agentPage.evaluate('window.clicks')
  out.oldHandleText = await handle?.textContent()
  out.locatorText = await agentPage.locator('#b').textContent()
  out.agentShotBytes = (await agentPage.screenshot()).length
  await agentPage.goto(server.page('/second', '<!doctype html><title>Second</title><p id="p">two'))
  out.afterNavigate = await agentPage.locator('#p').textContent()
  fs.writeFileSync(OUT, JSON.stringify(out, null, 1))
  await browser.close()
  await server.close()
  expect(out.clicksAfter).toBe(2)
})
