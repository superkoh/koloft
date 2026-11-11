const http = require('http')
const fs = require('fs')
const path = require('path')
const { app, BrowserWindow, powerMonitor, webContents, nativeImage } = require('electron')

const STATE = process.env.PROBE_STATE || 'never-shown'
const ROUNDS = Number(process.env.PROBE_ROUNDS || 1)
const EVERY_S = Number(process.env.PROBE_EVERY_S || 10)
const OUT = process.env.PROBE_OUT || ''

if (STATE === 'never-shown' && process.platform === 'darwin') {
  app.setActivationPolicy('accessory')
  app.dock?.hide()
}

const hits = []

const FRAME = `<!doctype html><meta charset="utf-8">
<body style="margin:0">
<button id="b" style="display:block;width:400px;height:150px;border:0;margin:0;background:#ff0000">in the iframe</button>
<input id="i" style="display:block;width:380px;height:80px;margin:30px 0 0 0;font-size:30px">
<script>
const g = new URLSearchParams(location.search).get('g')
const say = (q) => fetch('/hit?g=' + g + '&' + q)
say('kind=load')
b.addEventListener('click', (e) => say('kind=click&trusted=' + e.isTrusted))
i.addEventListener('input', () => say('kind=key&value=' + encodeURIComponent(i.value)))
</script>`

const parent = (port) => `<!doctype html><meta charset="utf-8">
<body style="margin:0;background:#0000ff">
<script>
const g = new URLSearchParams(location.search).get('g')
const f = document.createElement('iframe')
f.src = 'http://localhost:${port}/frame?g=' + g
f.style = 'position:absolute;left:100px;top:150px;width:400px;height:300px;border:0'
document.body.appendChild(f)
addEventListener('click', (e) => fetch('/hit?g=' + g + '&kind=parentClick&trusted=' + e.isTrusted))
</script>`

const host = (port) => `<!doctype html><meta charset="utf-8">
<body style="margin:0">
<input id="hostInput" autofocus>
<webview id="g1" src="http://127.0.0.1:${port}/parent?g=1" style="display:flex;width:1200px;height:500px"></webview>
<webview id="g2" src="http://127.0.0.1:${port}/parent?g=2" style="display:flex;width:1200px;height:500px;visibility:hidden"></webview>`

const IFRAME_TOP_HALF = { x: 100, y: 150, width: 400, height: 150 }
const BUTTON = { x: 300, y: 225 }
const FIELD = { x: 300, y: 370 }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const within = (p, ms) =>
  Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(`no answer in ${ms} ms`)))])

function centre(image) {
  const { width, height } = image.getSize()
  if (!width || !height) return 'empty image'
  const scale = image.getBitmap().length / 4 / (width * height)
  const px = Math.sqrt(scale)
  const w = Math.round(width * px)
  const at = (Math.floor((height * px) / 2) * w + Math.floor(w / 2)) * 4
  const b = image.getBitmap()
  return `rgba(${b[at + 2]},${b[at + 1]},${b[at]},${b[at + 3]}) of ${w}x${Math.round(height * px)}`
}

const GUEST_WIDTH = 1200

function pixel(image, x, y) {
  const { width, height } = image.getSize()
  if (!width || !height) return 'empty image'
  const b = image.toBitmap()
  const px = width / GUEST_WIDTH
  const at = (Math.floor(y * px) * width + Math.floor(x * px)) * 4
  return `rgba(${b[at + 2]},${b[at + 1]},${b[at]},${b[at + 3]}) of ${width}x${height}`
}

const hostState = (win) =>
  win.webContents.executeJavaScript(
    `({active: document.activeElement.id || document.activeElement.tagName, hasFocus: document.hasFocus(), hostInput: document.getElementById('hostInput').value})`
  )

async function refocusHost(win) {
  if (win.isVisible()) win.webContents.focus()
  await win.webContents.executeJavaScript(`document.getElementById('hostInput').focus()`)
  await sleep(200)
  return hostState(win)
}

async function attempt(run) {
  try {
    return await within(run(), 8000)
  } catch (e) {
    return `FAILED: ${e.message}`
  }
}

function focusNow(win) {
  return {
    focusedWindow: BrowserWindow.getFocusedWindow()?.id ?? null,
    windowVisible: win.isVisible(),
    windowFocused: win.isFocused(),
    appHidden: app.isHidden?.() ?? null,
    focusedWebContents: webContents.getFocusedWebContents()?.id ?? null
  }
}

const hitsOf = (g, kind) => hits.filter((h) => h.g === g && h.kind === kind)

async function cdpClick(wc, at) {
  const base = { x: at.x, y: at.y, button: 'left', clickCount: 1 }
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved' })
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', {
    ...base,
    type: 'mousePressed',
    buttons: 1
  })
  await wc.debugger.sendCommand('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' })
}

async function checkGuest(win, wc, g) {
  const out = { guest: g, webContentsId: wc.id, iframeLoads: hitsOf(g, 'load').length }
  let asked = Date.now()
  out.viewport = await attempt(() => wc.executeJavaScript(`innerWidth + 'x' + innerHeight`))
  out.viewportAnsweredInMs = Date.now() - asked
  asked = Date.now()
  out.cdpEvaluateOnThePage = await attempt(async () => {
    const r = await wc.debugger.sendCommand('Runtime.evaluate', {
      expression: `document.visibilityState + ' ' + innerWidth + 'x' + innerHeight`,
      returnByValue: true
    })
    return r.result.value
  })
  out.cdpEvaluateAnsweredInMs = Date.now() - asked
  out.iframeTargets = await attempt(async () => {
    const r = await wc.debugger.sendCommand('Target.getTargets')
    return r.targetInfos.filter((t) => t.type === 'iframe').map((t) => t.url)
  })
  out.capturePage = await attempt(async () => centre(await wc.capturePage(IFRAME_TOP_HALF)))
  out.cdpScreenshot = await attempt(async () => {
    const r = await wc.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png',
      clip: { ...IFRAME_TOP_HALF, scale: 1 }
    })
    return centre(nativeImage.createFromBuffer(Buffer.from(r.data, 'base64')))
  })
  let wholeImage
  const whole = await attempt(async () => (wholeImage = await wc.capturePage()).toPNG())
  out.capturePageWhole = Buffer.isBuffer(whole)
    ? `${whole.length} bytes, iframe button pixel ${pixel(wholeImage, BUTTON.x, BUTTON.y)}, pixel at (300,75) ${pixel(wholeImage, 300, 75)}`
    : whole
  const twoPixels = (image) =>
    `iframe button pixel ${pixel(image, BUTTON.x, BUTTON.y)}, pixel at (300,75) ${pixel(image, 300, 75)}`
  out.wholeByCapturePageRect = await attempt(async () =>
    twoPixels(await wc.capturePage({ x: 0, y: 0, width: GUEST_WIDTH, height: 500 }))
  )
  out.wholeByCdpClip = await attempt(async () => {
    const r = await wc.debugger.sendCommand('Page.captureScreenshot', {
      format: 'png',
      clip: { x: 0, y: 0, width: GUEST_WIDTH, height: 500, scale: 1 }
    })
    return twoPixels(nativeImage.createFromBuffer(Buffer.from(r.data, 'base64')))
  })
  out.whereThePageSaysTheIframeIs = await attempt(async () => {
    const r = await wc.debugger.sendCommand('Runtime.evaluate', {
      expression: `(() => { const r = document.querySelector('iframe').getBoundingClientRect(); return 'scroll ' + scrollX + ',' + scrollY + ' iframe at ' + r.x + ',' + r.y + ' inner ' + innerWidth + 'x' + innerHeight + ' doc ' + document.documentElement.scrollWidth + 'x' + document.documentElement.scrollHeight })()`,
      returnByValue: true
    })
    return r.result.value
  })
  if (OUT && g === '1' && Buffer.isBuffer(whole))
    fs.writeFileSync(path.join(OUT, `guest-${STATE}-${Date.now()}.png`), whole)

  out.hostWithItsFieldFocused = await attempt(() => refocusHost(win))
  out.throughTheIframesOwnSession = await attempt(async () => {
    const got = {}
    const { targetInfos } = await wc.debugger.sendCommand('Target.getTargets')
    const frame = targetInfos.find((t) => t.type === 'iframe' && t.url.endsWith(`g=${g}`))
    const { sessionId } = await wc.debugger.sendCommand('Target.attachToTarget', {
      targetId: frame.targetId,
      flatten: true
    })
    const send = (method, params) => wc.debugger.sendCommand(method, params, sessionId)
    const click = async (x, y) => {
      const base = { x, y, button: 'left', clickCount: 1 }
      await send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 })
      await send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased' })
    }
    try {
      got.screenshot = await within(
        send('Page.captureScreenshot', {
          format: 'png',
          clip: { x: 0, y: 0, width: 400, height: 150, scale: 1 }
        }).then((r) => centre(nativeImage.createFromBuffer(Buffer.from(r.data, 'base64')))),
        4000
      ).catch((e) => `FAILED: ${e.message}`)
      const clicksBefore = hitsOf(g, 'click').length
      await click(200, 75)
      await sleep(500)
      got.clickHits = hitsOf(g, 'click').slice(clicksBefore)
      got.focusAfterClick = focusNow(win)
      const keysBefore = hitsOf(g, 'key').length
      await click(200, 220)
      await sleep(200)
      await send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'a',
        code: 'KeyA',
        text: 'a',
        windowsVirtualKeyCode: 65
      })
      await send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65
      })
      await send('Input.insertText', { text: 'b' })
      await sleep(500)
      got.fieldAfterKeyAndInsertText = hitsOf(g, 'key')
        .slice(keysBefore)
        .map((h) => h.value)
      got.fieldHasFocus = (
        await send('Runtime.evaluate', {
          expression: `document.activeElement.id + ' hasFocus=' + document.hasFocus()`
        })
      ).result.value
      got.hostAfter = await hostState(win)
      return got
    } finally {
      await wc.debugger.sendCommand('Target.detachFromTarget', { sessionId }).catch(() => {})
    }
  })

  await attempt(() => refocusHost(win))
  const parentBefore = hitsOf(g, 'parentClick').length
  out.cdpClickOnParent = (await attempt(() => cdpClick(wc, { x: 50, y: 50 }))) ?? 'sent'
  await sleep(500)
  out.cdpClickOnParentHits = hitsOf(g, 'parentClick').slice(parentBefore)
  out.hostAfterClickOnParent = await attempt(() => hostState(win))

  await attempt(() => refocusHost(win))
  let before = hitsOf(g, 'click').length
  await attempt(() =>
    wc.executeJavaScript(
      `document.elementFromPoint(${BUTTON.x},${BUTTON.y}).dispatchEvent(new MouseEvent('click',{bubbles:true,clientX:${BUTTON.x},clientY:${BUTTON.y}}))`
    )
  )
  await sleep(500)
  out.inPageClickHits = hitsOf(g, 'click').length - before

  out.focusBeforeRealClick = focusNow(win)
  before = hitsOf(g, 'click').length
  out.cdpClick = (await attempt(() => cdpClick(wc, BUTTON))) ?? 'sent'
  await sleep(500)
  out.cdpClickHits = hitsOf(g, 'click').slice(before)
  out.clicksThatLandedOnTheParentSoFar = hitsOf(g, 'parentClick').length
  out.focusAfterRealClick = focusNow(win)
  out.hostAfterRealClick = await attempt(() => hostState(win))

  before = hitsOf(g, 'click').length
  for (const type of ['mouseDown', 'mouseUp'])
    wc.sendInputEvent({ type, x: BUTTON.x, y: BUTTON.y, button: 'left', clickCount: 1 })
  await sleep(500)
  out.sendInputEventHits = hitsOf(g, 'click').slice(before)

  before = hitsOf(g, 'key').length
  await attempt(() => cdpClick(wc, FIELD))
  await sleep(200)
  out.cdpKey =
    (await attempt(async () => {
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'a',
        code: 'KeyA',
        text: 'a',
        windowsVirtualKeyCode: 65
      })
      await wc.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'a',
        code: 'KeyA',
        windowsVirtualKeyCode: 65
      })
      await wc.debugger.sendCommand('Input.insertText', { text: 'b' })
    })) ?? 'sent'
  await sleep(500)
  out.fieldAfterKeys = hitsOf(g, 'key')
    .slice(before)
    .map((h) => h.value)
  out.hostAfterKeys = await attempt(() => hostState(win))
  return out
}

app.whenReady().then(async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    if (url.pathname === '/hit') {
      hits.push(Object.fromEntries(url.searchParams))
      res.end('ok')
      return
    }
    res.setHeader('content-type', 'text/html')
    const port = server.address().port
    res.end(
      url.pathname === '/frame' ? FRAME : url.pathname === '/parent' ? parent(port) : host(port)
    )
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  const port = server.address().port

  const win = new BrowserWindow({
    width: 1300,
    height: 1100,
    show: STATE !== 'never-shown',
    webPreferences: {
      webviewTag: true,
      backgroundThrottling: process.env.PROBE_THROTTLING !== 'off'
    }
  })
  const guests = []
  win.webContents.on('did-attach-webview', (_e, wc) => guests.push(wc))
  await win.loadURL(`http://127.0.0.1:${port}/host`)
  await sleep(4000)
  if (STATE === 'shown-then-hidden') {
    win.hide()
    if (process.env.PROBE_THROTTLING === 'lifted-after-hide') {
      win.webContents.setBackgroundThrottling(false)
      for (const wc of guests) wc.setBackgroundThrottling(false)
    }
    await sleep(1500)
  }
  console.log(
    JSON.stringify({
      state: STATE,
      throttling: process.env.PROBE_THROTTLING || 'on',
      electron: process.versions.electron,
      guestsAttached: guests.length
    })
  )
  for (const wc of guests) {
    try {
      wc.debugger.attach('1.3')
    } catch (e) {
      console.log(JSON.stringify({ attachFailed: e.message }))
    }
  }
  for (let round = 1; round <= ROUNDS; round++) {
    if (round > 1 && OUT) while (!fs.existsSync(path.join(OUT, `go-${round}`))) await sleep(500)
    const report = {
      round,
      at: new Date().toISOString().slice(11, 19),
      idleState: powerMonitor.getSystemIdleState(60),
      idleSeconds: powerMonitor.getSystemIdleTime(),
      guests: []
    }
    for (const wc of guests) {
      const g = new URL(wc.getURL()).searchParams.get('g')
      report.guests.push(await checkGuest(win, wc, g))
    }
    console.log(JSON.stringify(report, null, 1))
    console.log(
      'SUMMARY ' +
        JSON.stringify({
          state: STATE,
          throttling: process.env.PROBE_THROTTLING || 'on',
          round,
          idleState: report.idleState,
          guests: report.guests.map((r) => ({
            guest: r.guest === '1' ? 'visible box' : 'visibility:hidden',
            picture: String(r.capturePage).startsWith('rgba(225,0,0')
              ? 'iframe drawn'
              : r.capturePage,
            wholePicture: r.capturePageWhole,
            wholeByCapturePageRect: r.wholeByCapturePageRect,
            wholeByCdpClip: r.wholeByCdpClip,
            pageSays: r.whereThePageSaysTheIframeIs,
            clickThroughIframeSession:
              r.throughTheIframesOwnSession.clickHits?.length ?? r.throughTheIframesOwnSession,
            keysThroughIframeSession:
              r.throughTheIframesOwnSession.fieldAfterKeyAndInsertText?.length ?? 0,
            rootClickOnParent: r.cdpClickOnParentHits.length,
            rootClickOnIframe: r.cdpClickHits.length,
            noAnswerIn8s: JSON.stringify(r).split('no answer in 8000 ms').length - 1
          }))
        })
    )
    if (OUT) fs.writeFileSync(path.join(OUT, `done-${round}`), '')
    else if (round < ROUNDS) await sleep(EVERY_S * 1000)
  }
  app.exit(0)
})
