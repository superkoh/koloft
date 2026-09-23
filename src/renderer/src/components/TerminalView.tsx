import { useCallback, useEffect, useRef, type JSX } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebglAddon } from '@xterm/addon-webgl'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { consumeAdoptedNudge, useStore } from '../store'
import { activateTerminalLink } from '../termLinks'
import { suppressXtversionReply } from '../xtversionMask'
import { isLayoutDragging, onLayoutDragEnd } from '../resizeGate'
import { exitSyncWindow } from '../syncOutput'
import { acquireWebgl, releaseWebgl, touchWebgl } from '../webglPool'
import { registerWebglRepair, unregisterWebglRepair } from '../webglRepair'

const RESIZE_QUIET_MS = 100
const ADOPTED_REPAINT_AFTER_MS = 1000
const ACK_FLUSH_AT_UTF16_UNITS = 64 * 1024
const ACK_FLUSH_AFTER_MS = 100
export const NO_FOCUS_SIGNAL = 0

export function TerminalView({
  id,
  active,
  onUserInput,
  autoFocus = true,
  scrollbar = true,
  focusSignal,
  onRepainted
}: {
  id: string
  active: boolean
  onUserInput?: () => void
  autoFocus?: boolean
  scrollbar?: boolean
  focusSignal?: number
  onRepainted?: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const onUserInputRef = useRef(onUserInput)
  onUserInputRef.current = onUserInput
  const onRepaintedRef = useRef(onRepainted)
  onRepaintedRef.current = onRepainted
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const webglRef = useRef<WebglAddon | null>(null)
  const repaintedRef = useRef(false)
  const fontFamily = useStore((s) => s.settings.fontFamily)
  const fontSize = useStore((s) => s.settings.fontSize)

  // PLATFORM§20
  const forceRepaint = useCallback((): void => {
    const term = termRef.current
    if (!term || repaintedRef.current) return
    repaintedRef.current = true
    exitSyncWindow(term)
    let repainted = false
    try {
      const rs = (
        term as unknown as {
          _core?: { _renderService?: { handleResize(cols: number, rows: number): void } }
        }
      )._core?._renderService
      if (rs && typeof rs.handleResize === 'function') {
        rs.handleResize(term.cols, term.rows)
        repainted = true
      }
    } catch {}
    if (!repainted) {
      try {
        term.refresh(0, term.rows - 1)
      } catch {}
    }
    onRepaintedRef.current?.()
  }, [])

  const safeFit = useCallback((): void => {
    const el = ref.current
    const fit = fitRef.current
    const term = termRef.current
    if (!el || !fit || !term) return
    // PLATFORM§21
    if (el.clientWidth === 0 || el.clientHeight === 0) return
    try {
      exitSyncWindow(term)
      fit.fit()
      window.api.terminal.resize(id, term.cols, term.rows)
      // ADR-0007
      if (consumeAdoptedNudge(id)) {
        setTimeout(() => {
          repaintedRef.current = false
          forceRepaint()
        }, ADOPTED_REPAINT_AFTER_MS)
      }
    } catch {}
  }, [id, forceRepaint])

  useEffect(() => {
    const ground = getComputedStyle(ref.current!).getPropertyValue('--term-ground').trim()
    const term = new Terminal({
      fontSize: useStore.getState().settings.fontSize,
      fontFamily: useStore.getState().settings.fontFamily,
      cursorBlink: true,
      allowProposedApi: true,
      scrollbar: { showScrollbar: scrollbar },
      linkHandler: { activate: activateTerminalLink },
      theme: {
        background: ground,
        foreground: '#f3f1ee',
        cursor: '#ec9670',
        cursorAccent: ground,
        selectionBackground: 'rgba(236,150,112,0.30)',
        black: '#2a2a2e',
        red: '#e88567',
        green: '#8fc69a',
        yellow: '#d9b07a',
        blue: '#7aa2d6',
        magenta: '#bb9af7',
        cyan: '#7fc7c2',
        white: '#d4d1cc',
        brightBlack: '#908b84',
        brightRed: '#f0997d',
        brightGreen: '#9ac9a1',
        brightYellow: '#e8c690',
        brightBlue: '#92b5e0',
        brightMagenta: '#cbb0f9',
        brightCyan: '#97d6d1',
        brightWhite: '#f3f1ee'
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    // CC§12
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.loadAddon(new WebLinksAddon(activateTerminalLink))
    // CC§12
    suppressXtversionReply(term)
    term.open(ref.current!)
    termRef.current = term
    fitRef.current = fit
    if (window.api.testMode) {
      const reg = ((
        window as unknown as { __koloftTerms?: Record<string, Terminal> }
      ).__koloftTerms ??= {})
      reg[id] = term
    }
    repaintedRef.current = false

    // PLATFORM§20
    let dprCleanup: (() => void) | undefined
    if (!window.api.domRenderer) {
      const attachWebgl = (): void => {
        const t = termRef.current
        if (!t || webglRef.current) return
        try {
          const webgl = new WebglAddon()
          webgl.onContextLoss(() => {
            unregisterWebglRepair(id)
            webgl.dispose()
            webglRef.current = null
            releaseWebgl(id)
          })
          t.loadAddon(webgl)
          webglRef.current = webgl
          registerWebglRepair(id, webgl, () => {
            const t2 = termRef.current
            try {
              t2?.refresh(0, t2.rows - 1)
            } catch {}
          })
        } catch {
          releaseWebgl(id)
        }
      }
      const detachWebgl = (): void => {
        unregisterWebglRepair(id)
        webglRef.current?.dispose()
        webglRef.current = null
      }
      acquireWebgl(id, attachWebgl, detachWebgl)

      // PLATFORM§20
      let dprMql: MediaQueryList | null = null
      const onDpr = (): void => {
        try {
          webglRef.current?.clearTextureAtlas()
        } catch {}
        armDpr()
      }
      const armDpr = (): void => {
        dprMql?.removeEventListener('change', onDpr)
        dprMql = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`)
        dprMql.addEventListener('change', onDpr)
      }
      armDpr()
      dprCleanup = (): void => dprMql?.removeEventListener('change', onDpr)
    }

    const wrapper = ref.current!
    const ta = wrapper.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
    const compView = wrapper.querySelector('.composition-view') as HTMLElement | null
    const compScreen = compView?.closest('.xterm-screen') as HTMLElement | null
    const compositionHelper = (
      term as unknown as {
        _core?: { _compositionHelper?: { updateCompositionElements(): void } }
      }
    )._core?._compositionHelper

    // PLATFORM§22
    let pendingPunct = false
    const forwardInput = (e: Event): void => {
      if (!pendingPunct) return
      pendingPunct = false
      const ie = e as InputEvent
      if (ie.isComposing || ie.inputType !== 'insertText' || !ie.data) return
      window.api.terminal.write(id, ie.data)
      if (ta) ta.value = ''
    }
    ta?.addEventListener('input', forwardInput)

    let composing = false
    let commitGrace = false
    let clampRaf = 0
    let clearTimer: ReturnType<typeof setTimeout> | undefined

    // PLATFORM§22
    const clampCompView = (): void => {
      if (!compView || !compScreen) return
      const left = parseFloat(compView.style.left) || 0
      compView.style.maxWidth = Math.max(0, compScreen.clientWidth - left) + 'px'
      compView.style.overflow = 'hidden'
      compView.style.direction = 'ltr'
    }
    const clampLoop = (): void => {
      clampCompView()
      if (composing) clampRaf = requestAnimationFrame(clampLoop)
    }

    // PLATFORM§22
    const onCompStart = (): void => {
      composing = true
      commitGrace = false
      try {
        compositionHelper?.updateCompositionElements()
      } catch {}
      cancelAnimationFrame(clampRaf)
      clampRaf = requestAnimationFrame(clampLoop)
    }
    // PLATFORM§22
    const onCompEnd = (e: Event): void => {
      composing = false
      cancelAnimationFrame(clampRaf)
      const data = (e as CompositionEvent).data ?? ''
      if (data) {
        commitGrace = true
        onUserInputRef.current?.()
        window.api.terminal.write(id, data)
        setTimeout(() => {
          commitGrace = false
        }, 0)
        if (ta) ta.value = ''
      }
      // PLATFORM§22
      clearTimeout(clearTimer)
      clearTimer = setTimeout(() => {
        if (!composing && ta) ta.value = ''
      }, 0)
    }
    ta?.addEventListener('compositionstart', onCompStart)
    ta?.addEventListener('compositionend', onCompEnd)

    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown') onUserInputRef.current?.()
      // CC§12
      if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.type === 'keydown') window.api.terminal.write(id, '\n')
        return false
      }
      if (e.type === 'keydown') pendingPunct = false
      // PLATFORM§22
      if (ta && !e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
        const cc = e.key.charCodeAt(0)
        if (cc > 0x20 && cc < 0x7f && !/[A-Za-z0-9]/.test(e.key)) {
          if (e.type === 'keydown') pendingPunct = true
          return false
        }
      }
      return true
    })

    safeFit()

    let ackedUtf16Units = 0
    let ackTimer: ReturnType<typeof setTimeout> | null = null
    const flushAck = (): void => {
      if (ackTimer) {
        clearTimeout(ackTimer)
        ackTimer = null
      }
      if (ackedUtf16Units > 0) {
        window.api.terminal.ack(id, ackedUtf16Units)
        ackedUtf16Units = 0
      }
    }
    const noteConsumed = (utf16Units: number): void => {
      ackedUtf16Units += utf16Units
      if (ackedUtf16Units >= ACK_FLUSH_AT_UTF16_UNITS) flushAck()
      else if (!ackTimer) ackTimer = setTimeout(flushAck, ACK_FLUSH_AFTER_MS)
    }
    const offData = window.api.terminal.onData((d) => {
      if (d.id === id) term.write(d.data, () => noteConsumed(d.data.length))
    })
    window.api.terminal.attach(id)
    // PLATFORM§22
    const inputSub = term.onData((data) => {
      if (composing || commitGrace) return
      window.api.terminal.write(id, data)
    })

    let fitTimer: ReturnType<typeof setTimeout> | undefined
    let deferredByDrag = false
    const fitWhenSettled = (): void => {
      if (isLayoutDragging()) {
        deferredByDrag = true
        return
      }
      deferredByDrag = false
      safeFit()
    }
    const scheduleFit = (): void => {
      clearTimeout(fitTimer)
      fitTimer = setTimeout(fitWhenSettled, RESIZE_QUIET_MS)
    }
    const ro = new ResizeObserver(scheduleFit)
    ro.observe(ref.current!)
    const offDragEnd = onLayoutDragEnd(() => {
      if (deferredByDrag) scheduleFit()
    })

    // PLATFORM§21
    let wasHidden = false
    const vis = new IntersectionObserver(
      (entries) => {
        const visible = entries[entries.length - 1].isIntersecting
        if (!visible) {
          wasHidden = true
          repaintedRef.current = false
          return
        }
        if (!wasHidden) return
        wasHidden = false
        forceRepaint()
      },
      { threshold: 0 }
    )
    vis.observe(ref.current!)

    return () => {
      offData()
      flushAck()
      inputSub.dispose()
      cancelAnimationFrame(clampRaf)
      clearTimeout(clearTimer)
      clearTimeout(fitTimer)
      offDragEnd()
      ta?.removeEventListener('input', forwardInput)
      ta?.removeEventListener('compositionstart', onCompStart)
      ta?.removeEventListener('compositionend', onCompEnd)
      ro.disconnect()
      vis.disconnect()
      delete (window as unknown as { __koloftTerms?: Record<string, Terminal> }).__koloftTerms?.[id]
      dprCleanup?.()
      unregisterWebglRepair(id)
      releaseWebgl(id)
      webglRef.current = null
      term.dispose()
    }
  }, [id, safeFit, forceRepaint])

  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontFamily = fontFamily
    term.options.fontSize = fontSize
    safeFit()
  }, [fontFamily, fontSize, id, safeFit])

  // PLATFORM§21
  useEffect(() => {
    if (active) {
      touchWebgl(id)
      let inner = 0
      const raf = requestAnimationFrame(() => {
        const term = termRef.current
        if (!term) return
        safeFit()
        try {
          if (autoFocus) term.focus()
        } catch {}
        inner = requestAnimationFrame(() => {
          forceRepaint()
        })
      })
      return () => {
        cancelAnimationFrame(raf)
        cancelAnimationFrame(inner)
      }
    }
    return undefined
  }, [active, id, safeFit, forceRepaint, autoFocus])

  const answeredFocusSignal = useRef(NO_FOCUS_SIGNAL)
  useEffect(() => {
    if (!focusSignal || !active) return undefined
    if (focusSignal === answeredFocusSignal.current) return undefined
    answeredFocusSignal.current = focusSignal
    const raf = requestAnimationFrame(() => {
      try {
        termRef.current?.focus()
      } catch {}
    })
    return () => cancelAnimationFrame(raf)
  }, [focusSignal, active])

  return <div className="term" ref={ref} />
}
