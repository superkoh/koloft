ObjC.import('CoreGraphics')
ObjC.import('ApplicationServices')
ObjC.import('AppKit')

const HID_EVENT_TAP = 0
const LEFT_BUTTON = 0
const LEFT_DOWN = 1
const LEFT_UP = 2
const MOUSE_MOVED = 5
const LEFT_DRAGGED = 6
const CLICK_STATE_FIELD = 1
const AX_POINT = 1
const AX_SIZE = 2
const DRAG_STEPS = 20
const STEP_SECONDS = 0.02

function post(event) {
  $.CGEventPost(HID_EVENT_TAP, event)
  delay(STEP_SECONDS)
}

function mouse(type, x, y) {
  const event = $.CGEventCreateMouseEvent(null, type, { x, y }, LEFT_BUTTON)
  if (type !== MOUSE_MOVED) $.CGEventSetIntegerValueField(event, CLICK_STATE_FIELD, 1)
  post(event)
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

function string(element, name) {
  const value = attribute(element, name)
  if (value === null) return null
  const s = ObjC.unwrap(ObjC.castRefToObject(value))
  return typeof s === 'string' ? s : null
}

function children(element) {
  const value = attribute(element, 'AXChildren')
  if (value === null) return []
  const list = ObjC.castRefToObject(value)
  const out = []
  for (let i = 0; i < list.count; i++) out.push(list.objectAtIndex(i))
  return out
}

function texts(element, depth, out) {
  for (const name of ['AXValue', 'AXTitle', 'AXDescription']) {
    const s = string(element, name)
    if (s) out.push(s)
  }
  if (depth > 0) for (const child of children(element)) texts(child, depth - 1, out)
  return out
}

function processElement(bundleId) {
  const first = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundleId).firstObject
  if (first.isNil()) return null
  return $.AXUIElementCreateApplication(first.processIdentifier)
}

function dockItem(appName) {
  const dock = processElement('com.apple.dock')
  for (const list of children(dock))
    for (const item of children(list)) if (string(item, 'AXTitle') === appName) return item
  throw new Error('no Dock item named ' + appName)
}

function axStruct(element, name, type) {
  const out = Ref()
  $.AXValueGetValue(attribute(element, name), type, out)
  return out[0]
}

function dockItemCenter(appName) {
  const item = dockItem(appName)
  const p = axStruct(item, 'AXPosition', AX_POINT)
  const s = axStruct(item, 'AXSize', AX_SIZE)
  return `${p.x + s.width / 2} ${p.y + s.height / 2}`
}

function run(argv) {
  const [command, ...rest] = argv
  const n = rest.map(Number)
  if (command === 'trusted') return String($.AXIsProcessTrusted())
  if (command === 'key') return key(n[0], n[1])
  if (command === 'click') return click(n[0], n[1])
  if (command === 'drag') return drag(n[0], n[1], n[2], n[3])
  if (command === 'dock-badge') return string(dockItem(rest[0]), 'AXStatusLabel') ?? ''
  if (command === 'dock-item-center') return dockItemCenter(rest[0])
  if (command === 'banner-texts') {
    const center = processElement('com.apple.notificationcenterui')
    return center === null ? '' : texts(center, 12, []).join('\n')
  }
  throw new Error('unknown command ' + command)
}
