ObjC.import('CoreGraphics')
ObjC.import('ApplicationServices')
ObjC.import('AppKit')
ObjC.import('Carbon')

const HID_EVENT_TAP = 0
const LEFT_BUTTON = 0
const LEFT_DOWN = 1
const LEFT_UP = 2
const MOUSE_MOVED = 5
const LEFT_DRAGGED = 6
const CLICK_STATE_FIELD = 1
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

function axNumbers(element, name) {
  const text = ObjC.unwrap(ObjC.castRefToObject(attribute(element, name)).description)
  return [...text.matchAll(/[xywh]:(-?[\d.]+)/g)].map((m) => Number(m[1]))
}

function dockItemCenter(appName) {
  const item = dockItem(appName)
  const [x, y] = axNumbers(item, 'AXPosition')
  const [w, h] = axNumbers(item, 'AXSize')
  return `${x + w / 2} ${y + h / 2}`
}

const NOTIFICATION_CENTER = 'com.apple.notificationcenterui'

function inputSources() {
  const list = ObjC.castRefToObject($.TISCreateInputSourceList(null, true))
  const out = []
  for (let i = 0; i < list.count; i++) {
    const source = list.objectAtIndex(i)
    const id = $.TISGetInputSourceProperty(source, $.kTISPropertyInputSourceID)
    out.push({ source, id: ObjC.unwrap(ObjC.castRefToObject(id)) })
  }
  return out
}

function selectInputSource(id) {
  const match = inputSources().find((s) => s.id === id)
  if (!match) throw new Error('no input source ' + id)
  $.TISEnableInputSource(match.source)
  return String($.TISSelectInputSource(match.source))
}

function currentInputSource() {
  const source = $.TISCopyCurrentKeyboardInputSource()
  return ObjC.unwrap(
    ObjC.castRefToObject($.TISGetInputSourceProperty(source, $.kTISPropertyInputSourceID))
  )
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
  if (command === 'input-sources')
    return inputSources()
      .map((s) => s.id)
      .join('\n')
  if (command === 'select-input-source') return selectInputSource(rest[0])
  if (command === 'current-input-source') return currentInputSource()
  if (command === 'notification-center-running')
    return String(processElement(NOTIFICATION_CENTER) !== null)
  if (command === 'banner-texts') {
    const center = processElement(NOTIFICATION_CENTER)
    return center === null ? '' : texts(center, 12, []).join('\n')
  }
  throw new Error('unknown command ' + command)
}
