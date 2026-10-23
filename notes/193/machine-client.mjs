const [mode, url, extra] = process.argv.slice(2)

let printed = false
function out(obj) {
  printed = true
  console.log(JSON.stringify(obj))
}
process.on('exit', (code) => {
  if (!printed)
    console.log(JSON.stringify({ ok: false, exitedWithoutResult: code, node: process.version }))
})

async function wsProbe() {
  const WebSocket = mode === 'ws-native' ? globalThis.WebSocket : (await import('ws')).WebSocket
  const started = Date.now()
  const ws = new WebSocket(url)
  const pending = new Map()
  let nextId = 1
  const call = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      ws.send(JSON.stringify({ id, method, params }))
    })
  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data))
    const p = pending.get(msg.id)
    if (p) {
      pending.delete(msg.id)
      p.resolve(msg)
    }
  }
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('websocket error before open'))
    ws.onclose = (ev) => reject(new Error(`closed before open: ${ev.code} ${ev.reason}`))
  })
  const closed = new Promise((resolve) => {
    ws.onclose = (ev) => resolve({ code: ev.code, reason: ev.reason })
  })
  const opened = Date.now() - started
  const first = await Promise.race([
    call('Browser.getVersion'),
    closed.then((c) => ({ closedInstead: c }))
  ])
  if (first.closedInstead) return out({ ok: false, opened, closed: first.closedInstead })
  const bytes = Number(extra || 0)
  let big = null
  if (bytes) {
    const t = Date.now()
    const r = await call('Probe.big', { bytes })
    big = { bytes: r.result.data.length, ms: Date.now() - t }
  }
  ws.close()
  out({ ok: true, opened, version: first.result, big })
}

async function playwrightProbe() {
  const { chromium } = await import('/opt/probe/playwright-core/index.mjs')
  const t = Date.now()
  const browser = await chromium.connectOverCDP(url)
  const context = browser.contexts()[0] ?? (await browser.newContext())
  const page = await context.newPage()
  await page.goto('data:text/html,<title>across-the-tunnel</title><h1>hi</h1>')
  const title = await page.title()
  const shot = await page.screenshot()
  await page.close()
  await browser.close()
  out({ ok: true, title, screenshotBytes: shot.length, ms: Date.now() - t })
}

try {
  if (mode === 'ws' || mode === 'ws-native') await wsProbe()
  else if (mode === 'pw') await playwrightProbe()
  else throw new Error(`unknown mode ${mode}`)
} catch (err) {
  out({ ok: false, error: String(err && err.message ? err.message : err) })
}
