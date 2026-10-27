const { app, BrowserWindow } = require('electron')

const page = `<!doctype html><html><body style="margin:0">
<div style="height:1500px;background:#eee">top</div>
<button id="b" style="margin:40px;width:200px;height:60px;background:rgb(10,120,250);color:white;font:16px sans-serif;border-radius:8px">Buy now</button>
<script>window.clicks=0;document.getElementById('b').addEventListener('click',()=>{window.clicks++})</script>
</body></html>`
const host = `<!doctype html><html><body style="margin:0"><webview id="w" style="width:800px;height:600px;display:flex" src="data:text/html,${encodeURIComponent(page)}"></webview></body></html>`

const log = (...a) => console.log('PROBE', ...a)
const out = {}

app.whenReady().then(() => {
  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 700,
    webPreferences: { webviewTag: true }
  })
  win.webContents.on('did-attach-webview', (_e, guest) => {
    guest.once('did-finish-load', () =>
      setTimeout(
        () =>
          run(guest)
            .catch((e) => log('ERR', String(e)))
            .finally(() => {
              log(JSON.stringify(out, null, 1))
              app.quit()
            }),
        500
      )
    )
  })
  win.loadURL('data:text/html,' + encodeURIComponent(host))
})

async function run(guest) {
  out.electron = process.versions.electron
  out.chrome = process.versions.chrome
  const d = guest.debugger
  d.attach('1.3')
  try {
    d.attach('1.3')
    out.secondAttach = 'no error'
  } catch (e) {
    out.secondAttach = 'threw: ' + String(e)
  }
  const events = []
  d.on('message', (_e, method, params) => {
    if (method.startsWith('Overlay.')) events.push({ method, params })
  })
  await d.sendCommand('DOM.enable')
  await d.sendCommand('CSS.enable')
  await d.sendCommand('Overlay.enable')
  await d.sendCommand('Overlay.setInspectMode', {
    mode: 'searchForNode',
    highlightConfig: { showInfo: true, contentColor: { r: 111, g: 168, b: 220, a: 0.66 } }
  })
  await guest.executeJavaScript('window.scrollTo(0, 1400)')
  await new Promise((res) => setTimeout(res, 300))
  out.scrollY = await guest.executeJavaScript('window.scrollY')
  const rect = await guest.executeJavaScript(
    'JSON.stringify(document.getElementById("b").getBoundingClientRect())'
  )
  const r = JSON.parse(rect)
  const x = r.x + r.width / 2
  const y = r.y + r.height / 2
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
  await new Promise((res) => setTimeout(res, 300))
  out.overlayEvents = events.map((e) => e.method)
  out.pageClicksDuringInspect = await guest.executeJavaScript('window.clicks')
  const req = events.find((e) => e.method === 'Overlay.inspectNodeRequested')
  if (req) {
    const backendNodeId = req.params.backendNodeId
    const html = await d.sendCommand('DOM.getOuterHTML', { backendNodeId })
    out.outerHTML = html.outerHTML
    await d.sendCommand('DOM.getDocument', { depth: 0 })
    const pushed = await d.sendCommand('DOM.pushNodesByBackendIdsToFrontend', {
      backendNodeIds: [backendNodeId]
    })
    const cs = await d.sendCommand('CSS.getComputedStyleForNode', { nodeId: pushed.nodeIds[0] })
    const want = ['color', 'background-color', 'font-size', 'border-radius', 'width', 'height']
    out.computed = cs.computedStyle.filter((p) => want.includes(p.name))
    out.computedCount = cs.computedStyle.length
    const box = await d.sendCommand('DOM.getBoxModel', { backendNodeId })
    out.boxBorder = box.model.border
    const q = box.model.border
    const clip = { x: q[0], y: q[1], width: q[2] - q[0], height: q[5] - q[1], scale: 1 }
    const shot = await d.sendCommand('Page.captureScreenshot', { format: 'png', clip })
    out.cdpShotBytes = Buffer.from(shot.data, 'base64').length
    out.viewportRect = r
    const centre = (img) => {
      const s = img.getSize()
      const bmp = img.toBitmap()
      const i = (Math.floor(s.height / 2) * s.width + Math.floor(s.width / 4)) * 4
      return { size: s, bgra: [bmp[i], bmp[i + 1], bmp[i + 2], bmp[i + 3]] }
    }
    const { nativeImage } = require('electron')
    out.boxModelClipShot = centre(nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64')))
    const vclip = { x: r.x, y: r.y, width: r.width, height: r.height, scale: 1 }
    const vshot = await d.sendCommand('Page.captureScreenshot', { format: 'png', clip: vclip })
    out.viewportClipShot = centre(nativeImage.createFromBuffer(Buffer.from(vshot.data, 'base64')))
    const lm = await d.sendCommand('Page.getLayoutMetrics')
    const sclip = {
      x: r.x + lm.cssVisualViewport.pageX,
      y: r.y + lm.cssVisualViewport.pageY,
      width: r.width,
      height: r.height,
      scale: 1
    }
    const sshot = await d.sendCommand('Page.captureScreenshot', { format: 'png', clip: sclip })
    out.pageClipShot = centre(nativeImage.createFromBuffer(Buffer.from(sshot.data, 'base64')))
  }
  await d.sendCommand('Overlay.setInspectMode', { mode: 'none', highlightConfig: {} })
  try {
    const img = await guest.capturePage({
      x: Math.round(r.x),
      y: Math.round(r.y),
      width: Math.round(r.width),
      height: Math.round(r.height)
    })
    out.guestCapturePage = img.isEmpty() ? 'empty' : img.getSize()
  } catch (e) {
    out.guestCapturePage = 'threw: ' + String(e)
  }
  d.detach()
}
