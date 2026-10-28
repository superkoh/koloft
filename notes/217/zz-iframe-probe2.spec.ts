import fs from 'fs'
import { test, expect } from './helpers/app'
import { startSessionIn, waitBooted } from './helpers/p1'
import { openPickPage } from './helpers/browser'
import { startEchoServer } from './helpers/fixtureServer'

const OUT = process.env.PROBE_OUT ?? 'iframe-probe2.json'

test('probe: inspect mode inside a cross-origin iframe through its own session', async ({
  app,
  page
}) => {
  test.setTimeout(180_000)
  const server = await startEchoServer()
  let out: unknown = null
  try {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const inner = server
      .page(
        '/inner',
        '<!doctype html><title>Inner</title><div style="height:30px"></div><button id="in" style="width:160px;height:50px;background:rgb(200,10,10)">Inner</button><script>window.clicks=0;document.getElementById("in").onclick=()=>window.clicks++</script>'
      )
      .replace('127.0.0.1', 'localhost')
    const outerUrl = server.page(
      '/outer',
      `<!doctype html><title>Outer</title><div style="height:1200px">tall</div><div id="buy">x</div><iframe id="f" src="${inner}" style="width:400px;height:200px;border:0;margin-left:40px"></iframe>`
    )
    const guest = await openPickPage(app, page, outerUrl)
    await guest.locator('#f').scrollIntoViewIfNeeded()
    const box = await guest.locator('#f').boundingBox()
    if (!box) throw new Error('no box')
    const frame = guest.frames().find((f) => f.url() === inner)
    const clickAt = { x: box.x + 80, y: box.y + 30 + 25 }

    out = await app.evaluate(
      async ({ webContents, nativeImage }, { u, at }) => {
        const wc = webContents.getAllWebContents().find((w) => w.getURL() === u)
        if (!wc) return { error: 'no guest' }
        const d = wc.debugger
        const r: Record<string, unknown> = {}
        const events: { method: string; params: Record<string, unknown>; sessionId?: string }[] = []
        const onMsg = (
          _e: unknown,
          method: string,
          params: Record<string, unknown>,
          sessionId?: string
        ): void => {
          events.push({ method, params, sessionId })
        }
        d.attach('1.3')
        d.on('message', onMsg as never)
        const send = (m: string, p?: object, s?: string): Promise<unknown> =>
          s ? d.sendCommand(m, p, s) : d.sendCommand(m, p)
        try {
          r.targets = await send('Target.getTargets').catch((e) => String(e))
          const infos =
            (r.targets as { targetInfos?: { targetId: string; type: string; url: string }[] })
              .targetInfos ?? []
          const iframe = infos.find((t) => t.type === 'iframe')
          r.iframe = iframe ?? null
          let sub: string | undefined
          if (iframe) {
            const a = (await send('Target.attachToTarget', {
              targetId: iframe.targetId,
              flatten: true
            }).catch((e) => ({ error: String(e) }))) as { sessionId?: string; error?: string }
            r.attach = a
            sub = a.sessionId
          }
          const hl = { showInfo: true, contentColor: { r: 111, g: 168, b: 220, a: 0.66 } }
          for (const s of [undefined, sub]) {
            if (s === undefined && sub === undefined && s !== undefined) continue
            await send('DOM.enable', {}, s)
            await send('CSS.enable', {}, s)
            await send('Overlay.enable', {}, s)
            await send('Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: hl }, s)
          }
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y })
          await send('Input.dispatchMouseEvent', {
            type: 'mousePressed',
            x: at.x,
            y: at.y,
            button: 'left',
            clickCount: 1
          })
          await send('Input.dispatchMouseEvent', {
            type: 'mouseReleased',
            x: at.x,
            y: at.y,
            button: 'left',
            clickCount: 1
          })
          await new Promise((res) => setTimeout(res, 600))
          const req = events.find((e) => e.method === 'Overlay.inspectNodeRequested')
          r.request = req ?? null
          r.overlayEvents = events
            .filter((e) => e.method.startsWith('Overlay.'))
            .map((e) => [e.method, e.sessionId ?? ''])
          r.targetEvents = events
            .filter((e) => e.method.startsWith('Target.'))
            .map((e) => [e.method, e.sessionId ?? '', JSON.stringify(e.params).slice(0, 200)])
          r.eventSessions = [...new Set(events.map((e) => e.sessionId ?? ''))]
          if (req && sub && req.sessionId === sub) {
            const id = req.params.backendNodeId as number
            r.html = (
              (await send('DOM.getOuterHTML', { backendNodeId: id }, sub)) as { outerHTML: string }
            ).outerHTML
            r.innerBox = (
              (await send('DOM.getBoxModel', { backendNodeId: id }, sub)) as {
                model: { border: number[] }
              }
            ).model.border
            const tree = (await send('Page.getFrameTree', {}, sub)) as {
              frameTree: { frame: { id: string } }
            }
            const owner = (await send('DOM.getFrameOwner', {
              frameId: tree.frameTree.frame.id
            }).catch((e) => ({ error: String(e) }))) as { backendNodeId?: number; error?: string }
            r.owner = owner
            if (owner.backendNodeId) {
              const ob = (await send('DOM.getBoxModel', {
                backendNodeId: owner.backendNodeId
              })) as { model: { content: number[] } }
              r.ownerContent = ob.model.content
              const lm = (await send('Page.getLayoutMetrics')) as {
                cssVisualViewport: { pageX: number; pageY: number }
              }
              const ib = r.innerBox as number[]
              const oc = ob.model.content
              const clip = {
                x: ib[0] + oc[0] + lm.cssVisualViewport.pageX,
                y: ib[1] + oc[1] + lm.cssVisualViewport.pageY,
                width: ib[2] - ib[0],
                height: ib[5] - ib[1],
                scale: 1
              }
              r.clip = clip
              const shot = (await send('Page.captureScreenshot', { format: 'png', clip })) as {
                data: string
              }
              const buf = Buffer.from(shot.data, 'base64')
              r.shotBytes = buf.length
              const img = nativeImage.createFromBuffer(buf)
              const size = img.getSize()
              const bmp = img.toBitmap()
              const i = (Math.floor(size.height / 2) * size.width + Math.floor(size.width / 2)) * 4
              r.centre = [bmp[i + 2], bmp[i + 1], bmp[i], bmp[i + 3]]
              const centreOf = (b: Buffer): number[] => {
                const im = nativeImage.createFromBuffer(b)
                const sz = im.getSize()
                const bm = im.toBitmap()
                const j = (Math.floor(sz.height / 2) * sz.width + Math.floor(sz.width / 2)) * 4
                return [bm[j + 2], bm[j + 1], bm[j], bm[j + 3], sz.width, sz.height]
              }
              const ownerClip = {
                x: oc[0] + lm.cssVisualViewport.pageX,
                y: oc[1] + lm.cssVisualViewport.pageY,
                width: oc[2] - oc[0],
                height: oc[5] - oc[1],
                scale: 1
              }
              const whole = (await send('Page.captureScreenshot', {
                format: 'png',
                clip: ownerClip
              })) as { data: string }
              r.ownerCentre = centreOf(Buffer.from(whole.data, 'base64'))
              const beyond = (await send('Page.captureScreenshot', {
                format: 'png',
                clip,
                captureBeyondViewport: true
              })) as { data: string }
              r.beyondCentre = centreOf(Buffer.from(beyond.data, 'base64'))
              const page2 = await wc.capturePage({
                x: ib[0] + oc[0],
                y: ib[1] + oc[1],
                width: ib[2] - ib[0],
                height: ib[5] - ib[1]
              })
              r.capturePageCentre = centreOf(page2.toPNG())
              r.viewport = await wc.executeJavaScript('[innerWidth, innerHeight, scrollY]')
            }
          }
          for (const s of [undefined, sub])
            await send('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} }, s).catch(
              () => {}
            )
          if (sub)
            await send('Target.detachFromTarget', { sessionId: sub }).catch(
              (e) => (r.detachErr = String(e))
            )
          await new Promise((res) => setTimeout(res, 300))
          r.targetEventsAfterDetach = events
            .filter((e) => e.method.startsWith('Target.'))
            .map((e) => [e.method, e.sessionId ?? '', JSON.stringify(e.params).slice(0, 200)])
        } finally {
          d.off('message', onMsg as never)
          d.detach()
        }
        return r
      },
      { u: outerUrl, at: clickAt }
    )
    ;(out as Record<string, unknown>).innerClicks = frame
      ? await frame.evaluate('window.clicks')
      : null
  } finally {
    fs.writeFileSync(OUT, JSON.stringify(out, null, 1))
    await server.close()
  }
  expect(out).toBeTruthy()
})
