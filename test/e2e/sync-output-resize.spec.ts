import { test, expect, launchApp } from './helpers/app'
import { startSessionIn, waitBooted } from './helpers/p1'

/**
 * Repro for the occasional black terminal on resize (happens now and then on drag release / aux layout change).
 *
 * xterm 6.0 buffers ALL row refreshes while DEC private mode 2026 (synchronized
 * output) is set — RenderService.refreshRows routes them into SynchronizedOutputHandler
 * until `?2026l` arrives or a 1000ms safety timeout fires. Claude Code wraps every TUI
 * frame in `?2026h … ?2026l` (verified in the 2.1.232 binary), so while it streams,
 * sync windows are open a large share of wall time.
 *
 * RenderService.handleResize is NOT gated on that mode: it immediately runs the
 * renderer's handleResize — under WebGL that reassigns `_canvas.width`, which wipes
 * the drawing buffer on the spot — and only then requests a full refresh, which the
 * sync window swallows. Net effect: a fit landing inside a sync window blanks the
 * canvas and nothing repaints it until the safety timeout (~1s of black screen).
 *
 * The trigger here is the REAL user path: an app-window resize moves the terminal's
 * box → TerminalView's ResizeObserver → the 100ms quiet window → safeFit → fit() →
 * RenderService.handleResize. (A gutter drag release lands in the same safeFit.)
 *
 * This spec asserts the DESIRED contract: that fit must repaint promptly even when it
 * lands inside a sync window. It is RED on current code (measured delay ≈ quiet window
 * + the 1000ms safety timeout) and turns green with the sync-exit fix in safeFit. The
 * control phase (same window resize, no sync window) pins the harness itself: renders
 * do flow promptly in the hidden test window (backgroundThrottling is disabled there),
 * so a red bug phase can only mean the refresh was swallowed, not that rendering is
 * generally stalled.
 *
 * The swallow lives in RenderService (renderer-agnostic), so the repro holds under the
 * WebGL renderer and its GPU-less DOM fallback alike; KOLOFT_DOM_RENDERER is dropped so a
 * GPU machine exercises the real production path (where the wiped canvas is what makes
 * the swallow user-visible as a black screen).
 */
test('fit landing inside a DEC-2026 sync window still repaints promptly', async ({ env }) => {
  delete env.launchEnv.KOLOFT_DOM_RENDERER

  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    const errors: string[] = []
    page.on('pageerror', (e) => errors.push(String(e)))

    await expect(page.locator('.center')).toContainText('No running session', {
      timeout: 20_000
    })
    // the centre TUI is the surface the bug was reported on. It was also the only one whose
    // box followed the window height, back when the terminal island kept its own (D10);
    // retired the island and every shell is inside the panel now.
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')

    const setup = await page.evaluate(() => {
      type Term = {
        rows: number
        write(data: string, cb?: () => void): void
        onRender(cb: () => void): void
      }
      const w = window as unknown as {
        __koloftTerms?: Record<string, Term>
        __syncSpec?: { renders: number; term: Term }
      }
      const term = Object.values(w.__koloftTerms ?? {})[0]
      if (!term) throw new Error('no terminal in __koloftTerms')
      w.__syncSpec = { renders: 0, term }
      term.onRender(() => {
        w.__syncSpec!.renders += 1
      })
      return { rows: term.rows }
    })
    expect(setup.rows).toBeGreaterThan(4)

    // Shrink the app window → the terminal's box shrinks → safeFit fires after the
    // 100ms quiet window and resizes the grid. Waits until the render that follows
    // (or the timeout ceiling), returning the delay from the window-resize call.
    const fitRenderDelay = async (dh: number): Promise<number> => {
      await page.evaluate(() => {
        const w = window as unknown as { __syncSpec?: { renders: number; mark?: number } }
        w.__syncSpec!.mark = w.__syncSpec!.renders
      })
      await app.evaluate(({ BrowserWindow }, delta) => {
        const win = BrowserWindow.getAllWindows()[0]
        const [width, height] = win.getSize()
        win.setSize(width, height + delta)
      }, dh)
      return page.evaluate(async () => {
        const w = window as unknown as { __syncSpec?: { renders: number; mark?: number } }
        const s = w.__syncSpec!
        const t0 = performance.now()
        while (performance.now() - t0 < 3000) {
          if (s.renders > s.mark!) return performance.now() - t0
          await new Promise((r) => setTimeout(r, 20))
        }
        return Infinity
      })
    }

    // control: no sync window open — the fit repaints within the quiet window + a frame
    const controlDelay = await fitRenderDelay(-80)
    expect(controlDelay).toBeLessThan(600)

    // bug: open a sync window (what Claude Code's TUI does around every frame), then
    // move the box again. write() resolves after the parser has applied the mode.
    await page.evaluate(
      () =>
        new Promise<void>((r) => {
          const w = window as unknown as {
            __syncSpec?: { term: { write(d: string, cb?: () => void): void } }
          }
          w.__syncSpec!.term.write('\x1b[?2026h', r)
        })
    )
    const bugDelay = await fitRenderDelay(80)
    // the contract under repair: a fit inside a sync window must not leave the
    // (already wiped) canvas unpainted until the 1s safety timeout
    expect(bugDelay).toBeLessThan(600)

    expect(errors).toEqual([])
  } finally {
    await app.close().catch(() => {})
  }
})
