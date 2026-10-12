ObjC.import('CoreGraphics')
ObjC.import('ApplicationServices')
ObjC.import('AppKit')

const HID_EVENT_TAP = 0
const LEFT_BUTTON = 0
const LEFT_DOWN = 1
const LEFT_UP = 2
const MOUSE_MOVED = 5
const LEFT_DRAGGED = 6
const DRAG_STEPS = 20
const STEP_SECONDS = 0.02

function post(event) {
  $.CGEventPost(HID_EVENT_TAP, event)
  delay(STEP_SECONDS)
}

function mouse(type, x, y) {
  post($.CGEventCreateMouseEvent(null, type, { x, y }, LEFT_BUTTON))
}

function key(code, flags) {
  for (const down of [true, false]) {
    const event = $.CGEventCreateKeyboardEvent(null, code, down)
    $.CGEventSetFlags(event, flags)
    post(event)
  }
}

function click(x, y) {
  mouse(MOUSE_MOVED, x, y)
  mouse(LEFT_DOWN, x, y)
  mouse(LEFT_UP, x, y)
}

function drag(x1, y1, x2, y2) {
  mouse(MOUSE_MOVED, x1, y1)
  mouse(LEFT_DOWN, x1, y1)
  for (let i = 1; i <= DRAG_STEPS; i++) {
    mouse(LEFT_DRAGGED, x1 + ((x2 - x1) * i) / DRAG_STEPS, y1 + ((y2 - y1) * i) / DRAG_STEPS)
  }
  mouse(LEFT_UP, x2, y2)
}

function attribute(element, name) {
  const value = Ref()
  if ($.AXUIElementCopyAttributeValue(element, $(name), value) !== 0) return null
  return value[0]
}

function texts(element, depth, out) {
  const value = attribute(element, 'AXValue')
  const title = attribute(element, 'AXTitle')
  const description = attribute(element, 'AXDescription')
  const label = attribute(element, 'AXStatusLabel')
  for (const v of [value, title, description, label]) {
    const s = v === null ? '' : ObjC.unwrap(ObjC.castRefToObject(v))
    if (typeof s === 'string' && s) out.push(s)
  }
  if (depth <= 0) return out
  const children = attribute(element, 'AXChildren')
  if (children === null) return out
  const list = ObjC.castRefToObject(children)
  for (let i = 0; i < list.count; i++) texts(list.objectAtIndex(i), depth - 1, out)
  return out
}

function processElement(bundleId) {
  const running = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundleId)
  if (running.count === 0) return null
  return $.AXUIElementCreateApplication(running.objectAtIndex(0).processIdentifier)
}

function dockBadge(appName) {
  const dock = processElement('com.apple.dock')
  const list = ObjC.castRefToObject(attribute(dock, 'AXChildren')).objectAtIndex(0)
  const items = ObjC.castRefToObject(attribute(list, 'AXChildren'))
  for (let i = 0; i < items.count; i++) {
    const item = items.objectAtIndex(i)
    const title = attribute(item, 'AXTitle')
    if (title === null || ObjC.unwrap(ObjC.castRefToObject(title)) !== appName) continue
    const label = attribute(item, 'AXStatusLabel')
    return label === null ? '' : ObjC.unwrap(ObjC.castRefToObject(label))
  }
  return 'no dock item named ' + appName
}

function run(argv) {
  const [command, ...rest] = argv
  const n = rest.map(Number)
  if (command === 'trusted') return String($.AXIsProcessTrusted())
  if (command === 'key') return key(n[0], n[1])
  if (command === 'click') return click(n[0], n[1])
  if (command === 'drag') return drag(n[0], n[1], n[2], n[3])
  if (command === 'dock-badge') return dockBadge(rest[0])
  if (command === 'banner-texts') {
    const center = processElement('com.apple.notificationcenterui')
    return center === null ? '' : texts(center, 12, []).join('\n')
  }
  throw new Error('unknown command ' + command)
}
