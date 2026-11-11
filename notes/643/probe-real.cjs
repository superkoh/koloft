const fs = require('fs')
const path = require('path')
const { app, BrowserWindow } = require('electron')

const URL_TO_OPEN = process.env.PROBE_URL
const FRAME = process.env.PROBE_FRAME || ''
const CLICK = process.env.PROBE_CLICK
const OUT = process.env.PROBE_OUT || ''
const NAME = process.env.PROBE_NAME || 'page'

if (process.platform === 'darwin') {
  app.setActivationPolicy('accessory')
  app.dock?.hide()
}
app.userAgentFallback = app.userAgentFallback
  .replace(/\sElectron\/\S+/, '')
  .replace(new RegExp(`\\s${app.getName()}/\\S+`), '')

const FIND = `(() => {
  const q = 'button,[role=button],[role=checkbox],input[type=checkbox],a[href],[tabindex]:not([tabindex="-1"])'
  const out = []
  let closedShadowHosts = 0
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) walk(el.shadowRoot)
      if (!el.matches(q)) continue
      const r = el.getBoundingClientRect()
      if (r.width < 8 || r.height < 8) continue
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none') continue
      out.push({
        tag: el.tagName, role: el.getAttribute('role'),
        label: (el.getAttribute('aria-label') || el.innerText || '').slice(0, 40),
        checked: el.getAttribute('aria-checked'),
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height)
      })
    }
  }
  walk(document)
  return { size: innerWidth + 'x' + innerHeight, body: document.body ? document.body.innerText.slice(0, 80) : '', found: out }
})()`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const within = (p, ms) =>
  Promise.race([p, sleep(ms).then(() => Promise.reject(new Error(`no answer in ${ms} ms`)))])

async function frames(wc) {
  const { targetInfos } = await wc.debugger.sendCommand('Target.getTargets')
  const own = (await wc.debugger.sendCommand('Target.getTargetInfo')).targetInfo.targetId
  const list = []
  for (const t of targetInfos.filter((t) => t.type === 'iframe')) {
    const entry = {
      url: t.url.slice(0, 90),
      parentIsThePage: t.parentId === own,
      targetId: t.targetId
    }
    try {
      const { sessionId } = await within(
        wc.debugger.sendCommand('Target.attachToTarget', { targetId: t.targetId, flatten: true }),
        4000
      )
      entry.sessionId = sessionId
      const r = await within(
        wc.debugger.sendCommand(
          'Runtime.evaluate',
          { expression: FIND, returnByValue: true },
          sessionId
        ),
        4000
      )
      Object.assign(entry, r.result.value)
    } catch (e) {
      entry.error = e.message
    }
    list.push(entry)
  }
  const { frameTree } = await wc.debugger.sendCommand('Page.getFrameTree')
  for (const child of frameTree.childFrames || []) {
    const entry = {
      url: child.frame.url.slice(0, 90),
      inThePagesOwnProcess: true,
      targetId: child.frame.id
    }
    try {
      const { executionContextId } = await wc.debugger.sendCommand('Page.createIsolatedWorld', {
        frameId: child.frame.id
      })
      const r = await wc.debugger.sendCommand('Runtime.evaluate', {
        expression: FIND,
        returnByValue: true,
        contextId: executionContextId
      })
      Object.assign(entry, r.result.value)
    } catch (e) {
      entry.error = e.message
    }
    list.push(entry)
  }
  await wc.debugger.sendCommand('DOM.getDocument', { depth: 0 })
  for (const entry of list) {
    try {
      const owner = await wc.debugger.sendCommand('DOM.getFrameOwner', { frameId: entry.targetId })
      const { model } = await wc.debugger.sendCommand('DOM.getBoxModel', {
        backendNodeId: owner.backendNodeId
      })
      entry.at = { x: Math.round(model.content[0]), y: Math.round(model.content[1]) }
    } catch (e) {
      entry.at = `unknown: ${e.message}`
    }
  }
  return list
}

const shown = (list) =>
  list
    .map(({ sessionId, targetId, ...rest }) => rest)
    .filter((f) => !FRAME || f.url.includes(FRAME) || f.found?.length)

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: 1300,
    height: 950,
    show: false,
    webPreferences: { webviewTag: true }
  })
  let wc
  win.webContents.on('did-attach-webview', (_e, guest) => (wc = guest))
  await win.loadURL(
    `data:text/html,<body style="margin:0"><webview src="${URL_TO_OPEN}" style="display:flex;width:1280px;height:900px"></webview>`
  )
  await sleep(9000)
  wc.debugger.attach('1.3')
  console.log(
    JSON.stringify({
      title: wc.getTitle(),
      url: wc.getURL().slice(0, 80),
      userAgent: wc.getUserAgent()
    })
  )
  let list = await frames(wc)
  console.log('BEFORE', JSON.stringify(shown(list), null, 1))
  const save = async (tag) => {
    if (!OUT) return
    const image = await within(wc.capturePage(), 8000).catch((e) =>
      console.log(`capture failed: ${e.message}`)
    )
    if (image) fs.writeFileSync(path.join(OUT, `${NAME}-${tag}.png`), image.toPNG())
  }
  await save('before')
  if (process.env.PROBE_NO_CLICK_CONTROL) {
    await sleep(9500)
    console.log(JSON.stringify({ titleWithNoClick: wc.getTitle() }))
  }
  if (CLICK !== undefined) {
    const point = /^(\d+),(\d+)$/.exec(CLICK)
    const frame = list.find(
      (f) => f.url.includes(FRAME) && (point || f.found?.some((e) => e.role === CLICK))
    )
    const el = point
      ? { x: Number(point[1]), y: Number(point[2]), w: 0, h: 0 }
      : frame?.found.find((e) => e.role === CLICK)
    if (!el) console.log('nothing to click')
    else {
      const own = frame.inThePagesOwnProcess
      const at = {
        x: el.x + el.w / 2 + (own ? frame.at.x : 0),
        y: el.y + el.h / 2 + (own ? frame.at.y : 0),
        button: 'left',
        clickCount: 1
      }
      const send = (type, more) =>
        own
          ? wc.debugger.sendCommand('Input.dispatchMouseEvent', { ...at, type, ...more })
          : wc.debugger.sendCommand(
              'Input.dispatchMouseEvent',
              { ...at, type, ...more },
              frame.sessionId
            )
      await send('mouseMoved', { button: 'none' })
      await sleep(150)
      await send('mousePressed', { buttons: 1 })
      await sleep(80)
      await send('mouseReleased')
      console.log(
        `clicked ${JSON.stringify(el)} through ${own ? "the page's session" : "the iframe's own session"}`
      )
      await sleep(9000)
      console.log(JSON.stringify({ titleAfter: wc.getTitle() }))
      list = await frames(wc)
      console.log('AFTER', JSON.stringify(shown(list), null, 1))
      await save('after')
    }
  }
  app.exit(0)
})
