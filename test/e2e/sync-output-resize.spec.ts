import { test, expect, launchApp } from './helpers/app'
import { startSessionIn, waitBooted } from './helpers/p1'

const REPAINT_BUDGET_UNDER_1S_SYNC_SAFETY_TIMEOUT_MS = 600

test('a fit landing inside a DEC-2026 sync window still repaints promptly, with no second of black terminal on resize', async ({
  env
}) => {
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

    const controlDelay = await fitRenderDelay(-80)
    expect(controlDelay).toBeLessThan(REPAINT_BUDGET_UNDER_1S_SYNC_SAFETY_TIMEOUT_MS)

    // PLATFORM§21 CC§12
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
    expect(bugDelay).toBeLessThan(REPAINT_BUDGET_UNDER_1S_SYNC_SAFETY_TIMEOUT_MS)

    expect(errors).toEqual([])
  } finally {
    await app.close().catch(() => {})
  }
})
