// PLATFORM§16
const EMULATOR = String.raw`
function (ev) {
  var doc = document
  var a = doc.activeElement || doc.body
  function editable(el) {
    if (!el) return false
    if (el.isContentEditable) return true
    var t = el.tagName
    if (t === 'TEXTAREA') return !el.disabled && !el.readOnly
    if (t === 'INPUT') {
      var ty = (el.type || 'text').toLowerCase()
      return !el.disabled && !el.readOnly &&
        ['text', 'search', 'url', 'tel', 'email', 'password', 'number', 'date', 'time',
         'datetime-local', 'month', 'week'].indexOf(ty) >= 0
    }
    return false
  }
  function insert(text) {
    if (!text || !editable(a)) return false
    return doc.execCommand('insertText', false, text)
  }
  function tab(back) {
    var all = Array.prototype.slice.call(doc.querySelectorAll('a[href],button,input,select,textarea,[tabindex]'))
      .filter(function (e) { return !e.disabled && e.tabIndex >= 0 && e.offsetParent !== null })
    var i = all.indexOf(a)
    var n = all[(i + (back ? -1 : 1) + all.length) % all.length]
    if (n) { n.focus(); if (n.select) { try { n.select() } catch (e) {} } }
  }
  function move(key, extend) {
    var backward = key === 'ArrowLeft' || key === 'ArrowUp' || key === 'Home'
    var line = key === 'Home' || key === 'End'
    if (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') {
      var s = a.selectionStart, e = a.selectionEnd, len = a.value.length
      if (s == null) return
      var p = line ? (backward ? 0 : len) : Math.max(0, Math.min(len, (backward ? s : e) + (backward ? -1 : 1)))
      if (extend) a.setSelectionRange(Math.min(s, p), Math.max(e, p), p < s ? 'backward' : 'forward')
      else a.setSelectionRange(p, p)
      return
    }
    var sel = doc.getSelection()
    if (sel && sel.modify) sel.modify(extend ? 'extend' : 'move', backward ? 'backward' : 'forward', line ? 'lineboundary' : 'character')
  }

  var mods = ev.modifiers || 0
  var alt = !!(mods & 1), ctrl = !!(mods & 2), meta = !!(mods & 4), shift = !!(mods & 8)
  if (ev.kind === 'insert') return insert(ev.text)
  if (ev.kind === 'mouse') {
    var x = ev.x || 0, y = ev.y || 0
    var el = doc.elementFromPoint(x, y) || doc.documentElement
    var btn = ev.button === 'right' ? 2 : ev.button === 'middle' ? 1 : ev.button === 'back' ? 3 : ev.button === 'forward' ? 4 : 0
    var base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: x, clientY: y, screenX: x, screenY: y, button: btn, buttons: ev.buttons || 0,
      detail: ev.clickCount || 0, altKey: alt, ctrlKey: ctrl, metaKey: meta, shiftKey: shift
    }
    function fire(type, extra) {
      var init = Object.assign({}, base, extra || {})
      var e = type.indexOf('pointer') === 0
        ? new PointerEvent(type, Object.assign({ pointerId: 1, pointerType: 'mouse', isPrimary: true }, init))
        : new MouseEvent(type, init)
      return el.dispatchEvent(e)
    }
    var w = window
    if (ev.type === 'mouseMoved') {
      var last = w.__koloftHover
      if (last !== el) {
        if (last && last.isConnected) {
          last.dispatchEvent(new MouseEvent('mouseout', base))
          last.dispatchEvent(new MouseEvent('mouseleave', Object.assign({}, base, { bubbles: false })))
        }
        el.dispatchEvent(new MouseEvent('mouseover', base))
        el.dispatchEvent(new MouseEvent('mouseenter', Object.assign({}, base, { bubbles: false })))
        w.__koloftHover = el
      }
      fire('pointermove'); fire('mousemove')
      return true
    }
    if (ev.type === 'mousePressed') {
      fire('pointerdown')
      if (fire('mousedown') && btn === 0) {
        // a real mousedown focuses what it hit (or the nearest focusable ancestor); in
        // the page only — an in-page focus() never moves the host's
        var f = el.closest ? el.closest('a[href],button,input,select,textarea,[tabindex],[contenteditable]') : null
        if (f && f.focus) { try { f.focus({ preventScroll: true }) } catch (e) {} }
        else if (doc.activeElement && doc.activeElement !== doc.body && doc.activeElement.blur) doc.activeElement.blur()
      }
      return true
    }
    if (ev.type === 'mouseReleased') {
      fire('pointerup'); fire('mouseup')
      if (btn === 2) fire('contextmenu')
      else if (btn === 1) fire('auxclick')
      else if (btn === 0) { fire('click'); if ((ev.clickCount || 0) >= 2) fire('dblclick') }
      return true
    }
    if (ev.type === 'mouseWheel') {
      var dx = ev.deltaX || 0, dy = ev.deltaY || 0
      var ok = el.dispatchEvent(new WheelEvent('wheel', Object.assign({}, base, { deltaX: dx, deltaY: dy, deltaMode: 0 })))
      if (ok) {
        var sc = el
        while (sc && sc !== doc.body && sc !== doc.documentElement) {
          var cs = getComputedStyle(sc)
          if (/(auto|scroll)/.test(cs.overflowY + cs.overflowX) && (sc.scrollHeight > sc.clientHeight || sc.scrollWidth > sc.clientWidth)) break
          sc = sc.parentElement
        }
        if (sc && sc !== doc.body && sc !== doc.documentElement) sc.scrollBy(dx, dy)
        else w.scrollBy(dx, dy)
      }
      return true
    }
    return true
  }
  if (ev.kind !== 'key') return true
  var init = {
    key: ev.key || '', code: ev.code || '', bubbles: true, cancelable: true, composed: true,
    altKey: alt, ctrlKey: ctrl, metaKey: meta, shiftKey: shift,
    keyCode: ev.keyCode || 0, which: ev.keyCode || 0, repeat: !!ev.repeat, location: ev.location || 0
  }
  if (ev.type === 'keyUp') { a.dispatchEvent(new KeyboardEvent('keyup', init)); return true }
  if (ev.type === 'char') return insert(ev.text)
  // keyDown / rawKeyDown: the page's own handler may cancel the default action
  if (!a.dispatchEvent(new KeyboardEvent('keydown', init))) return true
  if ((ctrl || meta) && !alt) {
    if ((ev.key || '').toLowerCase() === 'a') { if (a.select) a.select(); else doc.execCommand('selectAll') }
    return true // copy / paste / undo are the browser's own — not emulated
  }
  switch (ev.key) {
    case 'Enter':
      if (a.isContentEditable) doc.execCommand('insertParagraph')
      else if (a.tagName === 'TEXTAREA') insert('\n')
      else if (a.tagName === 'INPUT' && a.form) {
        // implicit submission, keypress included: a form listening on either still sees it
        if (a.dispatchEvent(new KeyboardEvent('keypress', init))) {
          if (a.form.requestSubmit) a.form.requestSubmit(); else a.form.submit()
        }
      } else if (a.tagName === 'BUTTON' || a.tagName === 'A') a.click()
      return true
    case 'Backspace': if (editable(a)) doc.execCommand('delete'); return true
    case 'Delete': if (editable(a)) doc.execCommand('forwardDelete'); return true
    case 'Tab': tab(shift); return true
    case 'Escape': return true
    case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': case 'Home': case 'End':
      move(ev.key, shift); return true
    case ' ':
      if (a.tagName === 'BUTTON' || (a.tagName === 'INPUT' && /^(button|submit|reset|checkbox|radio)$/i.test(a.type))) { a.click(); return true }
      break
  }
  var text = ev.text || ''
  if (text && !ctrl && !meta && a.dispatchEvent(new KeyboardEvent('keypress', init))) insert(text)
  return true
}`

interface KeyParams {
  type?: string
  key?: string
  code?: string
  text?: string
  modifiers?: number
  windowsVirtualKeyCode?: number
  autoRepeat?: boolean
  location?: number
}

interface MouseParams {
  type?: string
  x?: number
  y?: number
  button?: string
  buttons?: number
  clickCount?: number
  modifiers?: number
  deltaX?: number
  deltaY?: number
}

export function inputEmulation(method: string, params: unknown): string | null {
  const p = (params ?? {}) as KeyParams
  let ev: Record<string, unknown> | null = null
  if (method === 'Input.insertText') ev = { kind: 'insert', text: p.text ?? '' }
  else if (method === 'Input.dispatchKeyEvent') {
    ev = {
      kind: 'key',
      type: p.type ?? 'keyDown',
      key: p.key ?? '',
      code: p.code ?? '',
      text: p.text ?? '',
      modifiers: p.modifiers ?? 0,
      keyCode: p.windowsVirtualKeyCode ?? 0,
      repeat: p.autoRepeat === true,
      location: p.location ?? 0
    }
  } else if (method === 'Input.imeSetComposition') ev = { kind: 'compose' }
  else if (method === 'Input.dispatchMouseEvent') {
    const m = (params ?? {}) as MouseParams
    ev = {
      kind: 'mouse',
      type: m.type ?? 'mouseMoved',
      x: m.x ?? 0,
      y: m.y ?? 0,
      button: m.button ?? 'none',
      buttons: m.buttons ?? 0,
      clickCount: m.clickCount ?? 0,
      modifiers: m.modifiers ?? 0,
      deltaX: m.deltaX ?? 0,
      deltaY: m.deltaY ?? 0
    }
  }
  if (!ev) return null
  return `(${EMULATOR})(${JSON.stringify(ev)})`
}
