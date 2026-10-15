ObjC.import('CoreGraphics')
ObjC.import('ApplicationServices')
ObjC.import('AppKit')
ObjC.import('Foundation')

const HID_EVENT_TAP = 0
const LEFT_BUTTON = 0
const MOUSE_MOVED = 5
const STEPS = 12
const STEP_SECONDS = 0.03

const sa = Application.currentApplication()
sa.includeStandardAdditions = true

let cur = { x: 0, y: 0 }

function moveTo(x, y) {
  const ev = $.CGEventCreateMouseEvent(null, MOUSE_MOVED, { x, y }, LEFT_BUTTON)
  $.CGEventPost(HID_EVENT_TAP, ev)
  cur = { x, y }
  delay(STEP_SECONDS)
}

function glide(x, y) {
  const from = cur
  for (let i = 1; i <= STEPS; i++) {
    moveTo(Math.round(from.x + ((x - from.x) * i) / STEPS), Math.round(from.y + ((y - from.y) * i) / STEPS))
  }
}

function windowsOf(pid) {
  const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1, 0)))
  return list
    .filter((w) => w.kCGWindowOwnerPID === pid && w.kCGWindowLayer !== 0)
    .map((w) => ({ layer: w.kCGWindowLayer, b: w.kCGWindowBounds, name: w.kCGWindowName || '' }))
}

function frontmost() {
  return ObjC.unwrap($.NSWorkspace.sharedWorkspace.frontmostApplication.localizedName)
}

function read(file) {
  return ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(file, $.NSUTF8StringEncoding, null))
}

function run(argv) {
  const [posFile, prefix, mode, hoversArg, shots] = argv
  const pos = JSON.parse(read(posFile))
  const hovers = Number(hoversArg || 8)
  const log = { trusted: $.AXIsProcessTrusted(), case: pos.case, mode, shots, hovers: [] }
  moveTo(pos.awayX, pos.awayY)
  delay(1.5)
  log.frontBefore = frontmost()
  log.windowsBefore = windowsOf(pos.pid).length
  const seq = []
  for (let h = 1; h <= hovers; h++) {
    const tx = mode === 'edge' ? pos.ex : mode === 'redge' ? pos.rx : pos.cx
    const ty = mode === 'centre' ? pos.cy : pos.ey
    glide(tx, ty)
    delay(2)
    const tips = windowsOf(pos.pid)
    const entry = { hover: h, at: [tx, ty], front: frontmost(), tip: tips.length > 0 }
    seq.push(entry.tip ? 'Y' : 'N')
    if (shots === 'all' || (shots === 'first2' && h <= 2)) {
      const shot = `${prefix}-hover${h}.png`
      sa.doShellScript(`/usr/sbin/screencapture -x -C -R 0,30,620,320 '${shot}'`)
      entry.shot = shot
      entry.tipAfterShot = windowsOf(pos.pid).length > 0
    }
    log.hovers.push(entry)
    glide(pos.awayX, pos.awayY)
    delay(1.5)
  }
  log.seq = seq.join('')
  return JSON.stringify(log)
}
