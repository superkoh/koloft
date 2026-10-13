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
const ENABLED_INPUT_SOURCE_SETTLES_SECONDS = 0.5
const NOTIFICATION_CENTER = 'com.apple.notificationcenterui'
const BANNER_TREE_DEPTH = 14

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
    $.CGEventSetFlags(event, down ? flags : 0)
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

function unwrap(ref) {
  return ObjC.unwrap(ObjC.castRefToObject(ref))
}

function attribute(element, name) {
  const value = Ref()
  if ($.AXUIElementCopyAttributeValue(element, $(name), value) !== 0) return null
  return value[0]
}

function string(element, name) {
  const value = attribute(element, name)
  const s = value === null ? null : unwrap(value)
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

function labels(element) {
  return ['AXValue', 'AXTitle', 'AXDescription'].map((n) => string(element, n)).filter(Boolean)
}

function texts(element, depth, out) {
  out.push(...labels(element))
  if (depth > 0) for (const child of children(element)) texts(child, depth - 1, out)
  return out
}

function findByText(element, needle, depth) {
  if (labels(element).some((s) => s.includes(needle))) return element
  if (depth > 0)
    for (const child of children(element)) {
      const found = findByText(child, needle, depth - 1)
      if (found) return found
    }
  return null
}

function processElement(bundleId) {
  const first = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(bundleId).firstObject
  if (first.isNil()) return null
  return $.AXUIElementCreateApplication(first.processIdentifier)
}

function dockItem(appName) {
  for (const list of children(processElement('com.apple.dock')))
    for (const item of children(list)) {
      if (string(item, 'AXTitle') !== appName) continue
      const running = attribute(item, 'AXIsApplicationRunning')
      if (running !== null && unwrap(running)) return item
    }
  throw new Error('no running Dock item named ' + appName)
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

function banner(text) {
  const center = processElement(NOTIFICATION_CENTER)
  return center === null ? null : findByText(center, text, BANNER_TREE_DEPTH)
}

function chooseOnBanner(text, choice) {
  const found = banner(text)
  if (!found) return 'no banner'
  const actions = Ref()
  $.AXUIElementCopyActionNames(found, actions)
  const action = ObjC.deepUnwrap(ObjC.castRefToObject(actions[0])).find((a) =>
    a.startsWith(`Name:${choice}\n`)
  )
  if (!action) return 'no action ' + choice
  return String($.AXUIElementPerformAction(found, $(action)))
}

function selectInputSource(id) {
  const list = ObjC.castRefToObject($.TISCreateInputSourceList(null, true))
  let match = null
  for (let i = 0; i < list.count; i++) {
    const source = list.objectAtIndex(i)
    const sourceId = unwrap($.TISGetInputSourceProperty(source, $.kTISPropertyInputSourceID))
    if (id !== sourceId && !id.startsWith(sourceId + '.')) continue
    $.TISEnableInputSource(source)
    if (id === sourceId) match = source
  }
  if (!match) throw new Error('no input source ' + id)
  delay(ENABLED_INPUT_SOURCE_SETTLES_SECONDS)
  $.TISSelectInputSource(match)
}

function run(argv) {
  const [command, ...rest] = argv
  const n = rest.map(Number)
  if (command === 'trusted') return String($.AXIsProcessTrusted())
  if (command === 'key') return key(n[0], n[1])
  if (command === 'keys') return n.forEach((code) => key(code, 0))
  if (command === 'click') return click(n[0], n[1])
  if (command === 'drag') return drag(n[0], n[1], n[2], n[3])
  if (command === 'dock-badge') return string(dockItem(rest[0]), 'AXStatusLabel') ?? ''
  if (command === 'dock-item-center') return dockItemCenter(rest[0])
  if (command === 'select-input-source') return selectInputSource(rest[0])
  if (command === 'notification-center-running')
    return String(processElement(NOTIFICATION_CENTER) !== null)
  if (command === 'banner-texts') {
    const center = processElement(NOTIFICATION_CENTER)
    return center === null ? '' : texts(center, BANNER_TREE_DEPTH, []).join('\n')
  }
  if (command === 'banner-showing') return String(banner(rest[0]) !== null)
  if (command === 'banner-action') return chooseOnBanner(rest[0], rest[1])
  throw new Error('unknown command ' + command)
}
