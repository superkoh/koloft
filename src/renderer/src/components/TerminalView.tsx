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

/** how long the container box must hold still before a resize is fitted — see the
 *  ResizeObserver below. Long enough to swallow the frames of a window resize (or the
 *  layout settling after a drag is released), short enough to reflow in the same beat. */
const RESIZE_QUIET_MS = 100

/**
 * One xterm instance bound to a pty id. The instance is kept alive while the tab
 * exists (the wrapper is hidden via display:none when inactive) so background
 * terminals keep receiving output.
 *
 * Focus: becoming active normally means the user switched to this terminal, so it takes
 * the focus. A Workbench terminal tab opts out (`autoFocus={false}`, R8) — every live
 * conversation tab's shells stay mounted, so becoming active is routine and must never
 * steal the caret — and is handed the focus explicitly through `focusSignal` instead.
 */
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
  /** A person typed in here — a key press, or an IME commit. */
  onUserInput?: () => void
  autoFocus?: boolean
  /** xterm's own scrollbar (and the 14px column the fit addon reserves for it). The
   *  Claude TUI on the centre goes without: the bar drew a fat track over the bare
   *  ground and its reserved column made the right margin read wider than the left
   * ; the wheel still scrolls the buffer. A shell tab keeps it. */
  scrollbar?: boolean
  /** Monotonic nonce: every CHANGE of it asks this terminal (when active) to take the
   *  focus. 0 means "not for you" — the initial value, and what a shell the current
   *  request does not name is handed. Each value is acted on at most once (see below). */
  focusSignal?: number
  /** Called once per show, after this terminal's full repaint has run (forceRepaint) —
   *  the moment the island may drop the loading mask it held over the switch. */
  onRepainted?: () => void
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  // read through a ref so a new callback identity never tears down the terminal
  const onUserInputRef = useRef(onUserInput)
  onUserInputRef.current = onUserInput
  const onRepaintedRef = useRef(onRepainted)
  onRepaintedRef.current = onRepainted
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const webglRef = useRef<WebglAddon | null>(null)
  // Latches a single full repaint per tab show: both re-show triggers (the [active]
  // effect's rAF and the visibility observer) call forceRepaint, but the heavy
  // handleResize (a full GPU backing-store reallocation) must run once, not twice. Reset
  // when the tab hides and when the terminal is (re)created.
  const repaintedRef = useRef(false)
  const fontFamily = useStore((s) => s.settings.fontFamily)
  const fontSize = useStore((s) => s.settings.fontSize)

  // Full repaint when a backgrounded tab is shown again.
  //
  // A hidden tab is display:none, so the compositor discards its WebGL drawing buffer.
  // term.refresh() only re-runs the renderer into that STALE buffer — it never re-creates
  // it — so the tab stays blank/garbled until something re-establishes the buffer. The
  // ONLY thing that did was a manual window resize: a resize re-assigns the WebGL canvas's
  // backing store (`_canvas.width = …`), which reallocates a fresh GPU buffer, then redraws.
  // Drive that exact path here via RenderService.handleResize (the same call a real resize
  // makes), so a tab switch recovers on its own. It re-establishes the buffer even when
  // cols/rows are unchanged, and defers safely if xterm is still paused (its un-pause
  // flushes the deferred task). No-ops harmlessly on the DOM renderer.
  //
  // The glyph atlas is deliberately NOT cleared here (dropped). It is shared by
  // every terminal, and clearing it on each show made the repaint re-rasterize every glyph
  // on the screen on the main thread: measured 0.1–0.4s per switch at 2560×1440 on a
  // CJK-filled screen (every char × colour is its own glyph), on top of the same again
  // for the first show — the "click, nothing, then the switch" stall. The clear was a
  // belt-and-braces for the garbled atlas, whose real causes are handled where they
  // arise: too many WebGL contexts (webglPool) and GPU memory invalidated by sleep or a
  // display change (webglRepair, which still clears on that signal).
  // `onRepainted` reports the repaint having run — App holds its switch mask until then.
  // (Declared before safeFit: the adoption nudge inside safeFit schedules it.)
  const forceRepaint = useCallback((): void => {
    const term = termRef.current
    if (!term || repaintedRef.current) return
    repaintedRef.current = true
    // handleResize below wipes the WebGL buffer unconditionally; inside a DEC-2026
    // window its repaint would be swallowed for up to 1s (syncOutput.ts) — the same
    // black flash on tab re-show that safeFit prevents on box changes.
    exitSyncWindow(term)
    let repainted = false
    try {
      const rs = (
        term as unknown as {
          _core?: { _renderService?: { handleResize(cols: number, rows: number): void } }
        }
      )._core?._renderService
      if (rs && typeof rs.handleResize === 'function') {
        // handleResize re-establishes the buffer AND issues a full refresh, so we're done —
        // no separate term.refresh() needed (that would be a second full repaint).
        rs.handleResize(term.cols, term.rows)
        repainted = true
      }
    } catch {
      /* _core shape changed across an xterm bump — fall through to the refresh fallback */
    }
    if (!repainted) {
      // Fallback only (handleResize unavailable/threw): refresh can't reallocate a discarded
      // buffer, but it's the best we can do without the internal renderer handle.
      try {
        term.refresh(0, term.rows - 1)
      } catch {
        /* ignore */
      }
    }
    onRepaintedRef.current?.()
  }, [])

  // Fit to the container — but ONLY when the element actually has a layout box.
  // While a tab is display:none, getComputedStyle(el).height resolves to "100%"
  // (not 0), so FitAddon would compute a tiny geometry (~6 rows / ~10 cols) and
  // shrink BOTH xterm and the pty. On re-show the rows grow back, but for an
  // alt-screen TUI (Claude Code) there is no scrollback to backfill them, so the
  // regrown rows stay blank — the "half the screen is empty" band that no repaint
  // can fill. Guarding every fit() on a non-zero client box keeps a backgrounded
  // tab at its real size, so there is nothing to corrupt and nothing to recover.
  const safeFit = useCallback((): void => {
    const el = ref.current
    const fit = fitRef.current
    const term = termRef.current
    if (!el || !fit || !term) return
    if (el.clientWidth === 0 || el.clientHeight === 0) return
    try {
      // A resize landing inside a DEC-2026 window wipes the WebGL buffer and the
      // repaint is swallowed until the 1s safety timeout — up to a second of black
      // terminal (syncOutput.ts). Drop out of the window first so the resize's own
      // full refresh paints immediately.
      exitSyncWindow(term)
      fit.fit()
      window.api.terminal.resize(id, term.cols, term.rows)
      // M5: an adopted tab's xterm starts blank (main buffers no
      // scrollback), and when the reload didn't change the window the fit above
      // lands on the pty's unchanged size — no SIGWINCH, no repaint, blank forever.
      // Jiggle the PTY rows once (xterm keeps its own size) so the claude alt-screen
      // TUI redraws its full frame into the fresh buffer. Deliberately inside the
      // fit guards: the first successful fit WHILE VISIBLE is the first moment a
      // repaint has a correctly-sized buffer to land in — nudging a hidden 80×24
      // xterm would bake a full-width frame into a narrow buffer instead.
      if (consumeAdoptedNudge(id)) {
        // Main pre-shrank this adopted pty by one row when it served the inventory,
        // so the resize the fit just sent above IS the nudge: one genuine SIGWINCH,
        // fired at the first moment the xterm is visible at its real size — claude
        // repaints exactly one full frame into a matching buffer. (Manual-round F1
        // killed every renderer-side jiggle variant: back-to-back resizes coalesce
        // into a no-change SIGWINCH claude ignores, and a pty-only or held shrink
        // makes claude draw into a mismatched xterm — statusline ghosts.) All that
        // remains here is the render-side belt: re-establish the WebGL buffer once
        // after the repaint's round trip, the same recovery a re-shown tab gets.
        setTimeout(() => {
          repaintedRef.current = false
          forceRepaint()
        }, 1000)
      }
    } catch {
      /* ignore */
    }
  }, [id, forceRepaint])

  useEffect(() => {
    // The colour under the cells is the HOST's: `--term-ground` is set by whichever
    // surface mounts this component (styles.css — the frameless TUI paints the centre's
    // ground, a shell tab in the Workbench paints the island's fill), read once here so
    // the theme and the CSS agree without the literal living in two files.
    const ground = getComputedStyle(ref.current!).getPropertyValue('--term-ground').trim()
    const term = new Terminal({
      fontSize: useStore.getState().settings.fontSize,
      fontFamily: useStore.getState().settings.fontFamily,
      cursorBlink: true,
      allowProposedApi: true,
      scrollbar: { showScrollbar: scrollbar },
      // §05B row 6 / F1 again, for the OTHER kind of link: an OSC 8 hyperlink is
      // xterm's own provider, registered ahead of any addon, so the web-links handler
      // below never sees one. Left unset it falls back to a native confirm and a
      // window.open the app denies (SEC-2) — the click dead-ends outside Koloft's routing
      // table, which is the escape this whole feature exists to close. Everything that
      // prints real hyperlinks (Claude Code's own links, gh, ls --hyperlink) arrives here.
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
    // Unicode 11 width tables so CJK/emoji occupy the same cell count Claude Code
    // (Ink / string-width) assumes — otherwise wide chars drift and clip at the edge.
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.loadAddon(new WebLinksAddon(activateTerminalLink))
    // Keep the terminal unidentified to guest apps — an XTVERSION reply flips Claude
    // Code's wheel scrolling to a fixed-pace profile (see xtversionMask.ts).
    suppressXtversionReply(term)
    term.open(ref.current!)
    termRef.current = term
    fitRef.current = fit
    // e2e seam: the xterm buffer is the only place the resize damage the specs assert on
    // (junk lines, cursor row) is observable — the DOM renderer shows the viewport alone.
    if (window.api.testMode) {
      const reg = ((
        window as unknown as { __koloftTerms?: Record<string, Terminal> }
      ).__koloftTerms ??= {})
      reg[id] = term
    }
    repaintedRef.current = false // fresh terminal — let the first show repaint it

    // Renderer backend: WebGL, always — there is no user-facing choice. Its glyph atlas
    // scrambles CJK when the renderer process runs out of WebGL contexts (Chromium caps
    // them at ~16, shared across all tabs), so live contexts are pooled (webglPool); a
    // lost context reverts to xterm's built-in DOM renderer and frees its slot, and a
    // DPI change re-clears the atlas. KOLOFT_DOM_RENDERER=1 (test-only seam) skips the
    // addon so e2e can assert terminal text as real DOM nodes.
    let dprCleanup: (() => void) | undefined
    if (!window.api.domRenderer) {
      const attachWebgl = (): void => {
        const t = termRef.current
        if (!t || webglRef.current) return
        try {
          const webgl = new WebglAddon()
          webgl.onContextLoss(() => {
            // A context can still be lost outside the pool's control (OS sleep, GPU
            // OOM, driver reset). Drop the GL context and free the pool slot; the
            // terminal reverts to the built-in DOM renderer.
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
            } catch {
              /* ignore */
            }
          })
        } catch {
          // WebGL2 unavailable — leave the pool; the terminal keeps its DOM renderer.
          releaseWebgl(id)
        }
      }
      const detachWebgl = (): void => {
        unregisterWebglRepair(id)
        webglRef.current?.dispose()
        webglRef.current = null
      }
      acquireWebgl(id, attachWebgl, detachWebgl)

      // Moving the window between monitors of different DPI re-rasterizes glyphs at the
      // new scale and can corrupt the atlas; re-clear it on each devicePixelRatio change.
      let dprMql: MediaQueryList | null = null
      const onDpr = (): void => {
        try {
          webglRef.current?.clearTextureAtlas()
        } catch {
          /* ignore */
        }
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

    // xterm's hidden input target; the IME commits its (fullwidth) characters here.
    const wrapper = ref.current!
    const ta = wrapper.querySelector('.xterm-helper-textarea') as HTMLTextAreaElement | null
    // The overlay xterm paints the in-progress preedit (pinyin) into, and its composition
    // helper — both internal. Reached via the proposed-API _core handle (allowProposedApi
    // is set above) to re-sync the textarea at composition start; see onCompStart below.
    const compView = wrapper.querySelector('.composition-view') as HTMLElement | null
    // The .xterm-screen container is stable for the terminal's whole life (never recreated
    // between renders), so resolve it once instead of re-walking the DOM every clamp frame.
    const compScreen = compView?.closest('.xterm-screen') as HTMLElement | null
    const compositionHelper = (
      term as unknown as {
        _core?: { _compositionHelper?: { updateCompositionElements(): void } }
      }
    )._core?._compositionHelper

    // ── IME workarounds: provenance and upgrade path ─────────────────────────────
    // The two IME symptoms handled below — a leading space at line start, and the
    // pinyin preedit overlapping earlier text on long lines — are upstream xterm.js
    // defects, not Koloft bugs: xtermjs/xterm.js#5454 → PR #5759 (preedit anchored to a
    // stale cursor), PR #5747 (preedit overflow), and #6012 (leading space, still OPEN
    // upstream). Since the 6.1.0-beta upgrade, #5759/#5747 ARE in the shipped xterm —
    // but this layer stays: the compositionend textarea clear covers #6012 (unmerged
    // upstream), upstream's #5747 clamp sets `direction: rtl`, which renders CJK
    // preedit BACKWARDS (#5760) and is re-overridden to LTR by the clamp loop below,
    // and the onData double-send dedupe is Koloft's own commit-path concern. The now
    // redundant-but-idempotent pieces (the compositionstart resync duplicating
    // upstream #5759) are candidates for removal after a real-IME manual pass.
    // Do not stack another symptom patch on this layer: renderer-level patching
    // provably cannot fix #6012 on its own.

    // A bare ASCII-punctuation key was suppressed on keydown so the next textarea
    // 'input' event (carrying the IME's substitution) is the one we forward.
    let pendingPunct = false
    const forwardInput = (e: Event): void => {
      if (!pendingPunct) return
      pendingPunct = false
      const ie = e as InputEvent
      if (ie.isComposing || ie.inputType !== 'insertText' || !ie.data) return
      window.api.terminal.write(id, ie.data)
      if (ta) ta.value = '' // don't let committed punctuation accumulate in the textarea
    }
    ta?.addEventListener('input', forwardInput)

    // ── De-dupe IME commits (esp. committing un-selected pinyin by switching IME) ──
    // xterm's CompositionHelper writes composition text into onData via TWO internal
    // paths: (1) while composing, a keydown (keyCode 229) triggers
    // _handleAnyTextareaChanges() which incrementally sends; (2) on compositionend,
    // _finalizeComposition() sends the whole buffer in a setTimeout. For a normal CJK
    // candidate pick the two reconcile via _dataAlreadySent and only one send reaches
    // the pty. But when you type pinyin and commit it WITHOUT picking a candidate — by
    // switching the input method — the IME rewrites the textarea (e.g. "ni'hao"→"nihao"),
    // the bookkeeping desyncs, and both paths fire: the letters reach the pty twice (in
    // a plain terminal AND the Claude TUI). Both sends go through term.onData, bypassing
    // every input event, so the only place to fix it is the onData outlet itself.
    // Strategy: suppress xterm's own onData for the whole composition (while composing
    // plus a brief post-commit window) and send the text exactly once from
    // compositionend using its authoritative e.data. Works for every commit path
    // (candidate pick, input-method switch, plain ASCII) without relying on xterm's
    // (mismatched) internal accounting.
    let composing = false
    let commitGrace = false // post-compositionend window covering _finalizeComposition's deferred send
    let clampRaf = 0 // rAF id of the composition-view overflow clamp loop (symptom 2)
    let clearTimer: ReturnType<typeof setTimeout> | undefined // deferred helper-textarea clear (symptom 1)

    // ── Symptom 2 (preedit overlap): clamp the composition-view to the terminal width ──
    // xterm (≤6.0) parks the overlay at the cursor but leaves it `white-space: nowrap`, so a
    // long preedit overflows past the right edge — and because Koloft themes the box opaque,
    // it stamps over whatever it covers. Upstream added a width clamp in
    // xtermjs/xterm.js#5747, but with `direction: rtl`, which renders CJK preedit
    // BACKWARDS (#5760); we keep LTR. It rides every animation frame because xterm
    // re-parks the overlay on each render (onRender → updateCompositionElements), so its
    // `left` drifts as the TUI repaints and the clamp must follow.
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

    const onCompStart = (): void => {
      composing = true
      commitGrace = false
      // Re-sync the helper textarea + composition-view to the CURRENT cursor. Claude
      // Code reprints its TUI aggressively; while not composing, xterm's
      // updateCompositionElements() early-returns, so the textarea stays parked at the
      // cursor's PREVIOUS position and the IME anchors the preedit to stale coords — the
      // pinyin then paints over already-entered text ("the pinyin fully overlaps the text typed before"). xterm's own
      // compositionstart listener (registered before ours) has already flipped
      // _isComposing true, so this call re-parks both elements at once. Upstream
      // root-cause fix: xtermjs/xterm.js#5759 (issue #5454, "IME input far from cursor
      // with AI CLIs"). Not in any stable xterm release (6.0.0 included) — backported here.
      try {
        compositionHelper?.updateCompositionElements()
      } catch {
        /* _core shape changed across an xterm bump — resync silently skipped */
      }
      cancelAnimationFrame(clampRaf)
      clampRaf = requestAnimationFrame(clampLoop)
    }
    const onCompEnd = (e: Event): void => {
      composing = false
      cancelAnimationFrame(clampRaf)
      const data = (e as CompositionEvent).data ?? ''
      if (data) {
        // Take over: send the final text once, and swallow xterm's own resend that
        // lands in the next macrotask (_finalizeComposition's setTimeout) and any
        // trailing insertText. commitGrace closes on a setTimeout(0) — xterm's resend
        // is scheduled first (its compositionend listener registered before ours), so
        // it runs while commitGrace is still true and gets suppressed.
        commitGrace = true
        onUserInputRef.current?.()
        window.api.terminal.write(id, data)
        setTimeout(() => {
          commitGrace = false
        }, 0)
        // We took over this commit, so reset xterm's helper textarea. xterm only clears
        // it on Enter/Ctrl+C; left alone it accumulates every committed string
        // ("你好世界…") because our onData suppression keeps xterm from ever draining it.
        if (ta) ta.value = ''
      }
      // data === '' (a few IMEs commit via a trailing insertText instead) → don't take
      // over; let xterm send it through normally.
      // ── Symptom 1 (leading space): always drain the helper textarea one tick later ──
      // xterm's _handleAnyTextareaChanges() (a keyCode-229 keydown while not composing)
      // diffs `newValue.replace(oldValue, '')` over the textarea; String.replace's
      // first-match semantics leak a stray char — a leading space — when committed text
      // is still in it (xtermjs/xterm.js#6012, still OPEN upstream). The synchronous
      // clear above only covers the take-over (non-empty data) branch; IMEs that commit
      // through the empty-data path (WeChat among them) left the buffer populated, so the
      // next non-composing keystroke diffed it back out. Defer the clear past xterm's own
      // _finalizeComposition read — its setTimeout(0) is scheduled before ours, so it runs
      // first and the commit is already sent by the time we drain — keeping the diff
      // anchored to an empty baseline without dropping the input.
      clearTimeout(clearTimer)
      clearTimer = setTimeout(() => {
        if (!composing && ta) ta.value = ''
      }, 0)
    }
    ta?.addEventListener('compositionstart', onCompStart)
    ta?.addEventListener('compositionend', onCompEnd)

    term.attachCustomKeyEventHandler((e) => {
      // A key pressed with this terminal focused: a person is here. xterm's onData
      // would be the wrong place to notice — it also carries the answers xterm sends
      // by itself (focus reports, mouse reports, device replies).
      if (e.type === 'keydown') onUserInputRef.current?.()
      // Shift+Enter inserts a newline in Claude Code's input box (same as Ctrl+J);
      // a plain Enter still sends CR to submit. Suppress xterm on every phase
      // (keydown *and* keypress) — otherwise the keypress would still emit a CR
      // that submits — but write the newline only once, on keydown.
      if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
        if (e.type === 'keydown') window.api.terminal.write(id, '\n')
        return false
      }
      // Defer bare ASCII punctuation to the textarea's 'input' event so a Chinese
      // IME can substitute its fullwidth form (，。？！). xterm would otherwise emit
      // the halfwidth byte on keydown and preventDefault the IME's conversion.
      // Letters/digits keep xterm's fast keydown path; CJK keeps flowing through
      // its composition handling (keyCode 229).
      if (e.type === 'keydown') pendingPunct = false
      if (ta && !e.ctrlKey && !e.altKey && !e.metaKey && e.key.length === 1) {
        const cc = e.key.charCodeAt(0)
        if (cc > 0x20 && cc < 0x7f && !/[A-Za-z0-9]/.test(e.key)) {
          if (e.type === 'keydown') pendingPunct = true
          return false // suppress xterm's keydown + keypress emission for this key
        }
      }
      return true
    })

    safeFit()

    // Ack consumed output back to main for flow control (main/flowControl.ts).
    // Each term.write callback fires once xterm has parsed that chunk; acks are
    // aggregated (64KB or 100ms) so a flood doesn't cause an IPC storm on the return
    // path, while staying prompt enough that main pumps held backlog without a
    // visible stall. Units are string code units — the metric main counted on send.
    let ackedUnits = 0
    let ackTimer: ReturnType<typeof setTimeout> | null = null
    const flushAck = (): void => {
      if (ackTimer) {
        clearTimeout(ackTimer)
        ackTimer = null
      }
      if (ackedUnits > 0) {
        window.api.terminal.ack(id, ackedUnits)
        ackedUnits = 0
      }
    }
    const noteConsumed = (units: number): void => {
      ackedUnits += units
      if (ackedUnits >= 64 * 1024) flushAck()
      else if (!ackTimer) ackTimer = setTimeout(flushAck, 100)
    }
    const offData = window.api.terminal.onData((d) => {
      if (d.id === id) term.write(d.data, () => noteConsumed(d.data.length))
    })
    // only now do forwarded chunks have a consumer that acks them — tell main to
    // start counting this tab against its send window (pre-mount chunks never count)
    window.api.terminal.attach(id)
    const inputSub = term.onData((data) => {
      // During composition (and the brief post-commit window) xterm emits the
      // composition text here itself — incrementally mid-compose and again on commit.
      // onCompEnd already sent the final text from its authoritative e.data, so drop
      // xterm's own (duplicate, sometimes desynced) emissions in that window.
      if (composing || commitGrace) return
      window.api.terminal.write(id, data)
    })

    // Fires 0×0 on the display:none transition too — safeFit() no-ops while hidden so
    // backgrounding a tab never shrinks it (the root cause of the empty-band bug).
    //
    // Coalesced, and — while a gutter is being dragged — held entirely (resizeGate).
    // Dragging hands us a new box every frame, and each fit resizes the pty: one
    // SIGWINCH per intermediate size, ~10-15 of them per hand-paced trip to a pane's
    // size floor and back. A shell reprints its prompt on every one of them, scrolling
    // when the transient box is shorter than the prompt — and scrolled lines join the
    // scrollback for keeps, so the reclaimed rows come back filled with redraw debris
    // that stacks with every drag. §08 already refuses to animate the height for exactly
    // this reason. So the pty is shown one size per gesture: the one the user let go at.
    // The view lags the box for the duration (the island clips it, .island is
    // overflow:hidden) and snaps back on release — cheaper than junk that never leaves.
    // Every other caller (mount, tab activation, font change) still fits synchronously,
    // and a window resize — nobody's drag — still reflows live through the quiet window.
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
    // Released: fit once, on the same quiet window as any other box change — the last
    // mousemove's layout may still be landing, and collapsing it with the release keeps
    // the whole gesture at a single resize. A drag that never touched this terminal's
    // box deferred nothing and stays untouched.
    const offDragEnd = onLayoutDragEnd(() => {
      if (deferredByDrag) scheduleFit()
    })

    // Deterministic repaint when this tab is shown again — the timing-exact backstop to
    // the frame-deferred repaint in the [active] effect below. While the tab is
    // display:none, xterm's own RenderService IntersectionObserver sets _isPaused=true.
    // This observer shares the browser's intersection-observer delivery, so on re-show its
    // callback runs in the SAME task as xterm's un-pause. forceRepaint() drives the resize
    // path (handleResize), which re-establishes the WebGL buffer and full-redraws whether
    // it runs before or after xterm un-pauses (handleResize defers via _pausedResizeTask
    // while paused, and xterm's un-pause flushes it). Independent trigger (DOM visibility)
    // from the [active] effect's rAF (React prop), so the two cover each other if frame
    // ordering slips under load.
    let wasHidden = false
    const vis = new IntersectionObserver(
      (entries) => {
        const visible = entries[entries.length - 1].isIntersecting
        if (!visible) {
          wasHidden = true
          repaintedRef.current = false // re-arm the once-per-show repaint latch
          return
        }
        if (!wasHidden) return // initial observe of the freshly-rendered mount — nothing stale
        wasHidden = false
        forceRepaint()
      },
      { threshold: 0 }
    )
    vis.observe(ref.current!)

    return () => {
      offData()
      flushAck() // report any tail consumption so the gate never strands paused
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

  // apply font changes live, then refit
  useEffect(() => {
    const term = termRef.current
    if (!term) return
    term.options.fontFamily = fontFamily
    term.options.fontSize = fontSize
    safeFit()
  }, [fontFamily, fontSize, id, safeFit])

  // refit + repaint + focus when this tab becomes active (it was display:none).
  // The WebGL renderer only repaints rows the pty marks dirty; while the tab was hidden
  // the compositor discarded its GPU drawing buffer, so on re-show the static
  // (non-updating) rows — typically the top of a TUI — stay blank/garbled until the buffer
  // is re-established. forceRepaint() drives the renderer's resize path to do exactly that.
  //
  // Two requestAnimationFrames are required, not one. xterm's RenderService pauses
  // rendering via an IntersectionObserver on the screen element: while hidden it sets
  // _isPaused=true, and refreshRows() then early-returns (it only sets a sticky
  // _needsFullRefresh flag, never schedules a paint). The observer un-pauses on
  // re-show, but its callback is delivered as a task AFTER this frame's rAF step. We
  // therefore do the layout-sensitive work (fit, which reads the now block-sized box; the
  // pty resize; focus, kept in frame 1 so a fast switch never drops the IME composition
  // target) in the first frame, then defer only the repaint to a second rAF — by which
  // point the observer has flipped _isPaused back to false, so handleResize re-establishes
  // the buffer immediately rather than deferring.
  useEffect(() => {
    if (active) {
      // Bump this tab to most-recently-used so the WebGL pool keeps (or restores) its
      // GPU context. No-op for tabs already holding a context.
      touchWebgl(id)
      let inner = 0
      const raf = requestAnimationFrame(() => {
        const term = termRef.current
        if (!term) return
        safeFit()
        try {
          if (autoFocus) term.focus()
        } catch {
          /* ignore */
        }
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

  // Explicit focus request (⌃`, the titlebar icon, ＋ ▸ New terminal, ⌘T, ⇧⌘B).
  // Deferred a frame like the activation focus above: the caller usually un-hides this
  // terminal in the same commit, and focus() on a hidden element does nothing.
  // Signal 0 is the initial value and never focuses — only a real gesture does.
  //
  // ONCE PER VALUE, which `active` being a dependency is what makes necessary: the effect
  // re-runs on every false→true, and re-running it against a signal that was answered
  // minutes ago is a shell grabbing the caret out of whatever the user just clicked. The
  // latch starts at 0 rather than at the current value on purpose — a shell that was just
  // created mounts with its own request already raised, and seeding from the prop would
  // make that one, the only one that must always be answered, the one that never is.
  const answeredFocus = useRef(0)
  useEffect(() => {
    if (!focusSignal || !active) return undefined
    if (focusSignal === answeredFocus.current) return undefined
    answeredFocus.current = focusSignal
    const raf = requestAnimationFrame(() => {
      try {
        termRef.current?.focus()
      } catch {
        /* ignore */
      }
    })
    return () => cancelAnimationFrame(raf)
  }, [focusSignal, active])

  return <div className="term" ref={ref} />
}
