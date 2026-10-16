const { app, BrowserWindow } = require('electron')
const fs = require('fs')
const path = require('path')

const caseArg = process.argv.find((a) => a.startsWith('--case='))
const caseId = caseArg ? caseArg.slice(7) : 'a'
const out = process.env.TIP_OUT || '/Users/admin/out'

app.whenReady().then(async () => {
  fs.mkdirSync(out, { recursive: true })
  const clickFile = path.join(out, `click-${caseId}.txt`)
  fs.writeFileSync(clickFile, 'none')
  const win = new BrowserWindow({
    x: 40,
    y: 60,
    width: 520,
    height: 260,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 }
  })
  win.webContents.on('page-title-updated', (_e, title) => {
    if (title.startsWith('CLICK')) fs.writeFileSync(clickFile, title)
  })
  await win.loadFile(path.join(__dirname, 'index.html'), { query: { case: caseId } })
  app.focus({ steal: true })
  win.focus()
  await new Promise((r) => setTimeout(r, 800))
  const r = await win.webContents.executeJavaScript(
    `(() => { const b = document.getElementById('target').getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height } })()`
  )
  const c = win.getContentBounds()
  const pos = {
    case: caseId,
    pid: process.pid,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    content: c,
    rect: r,
    cx: Math.round(c.x + r.x + r.w / 2),
    cy: Math.round(c.y + r.y + r.h / 2),
    ex: Math.round(c.x + r.x + 1),
    ey: Math.round(c.y + r.y + r.h / 2),
    rx: Math.floor(c.x + r.x + r.w - 1),
    awayX: c.x + 420,
    awayY: c.y + 220,
    clickFile
  }
  fs.writeFileSync(path.join(out, `pos-${caseId}.json`), JSON.stringify(pos))
})
