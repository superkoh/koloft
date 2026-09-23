import { test, expect, pendingAttention } from './helpers/app'
import {
  centerTerm,
  processAlive,
  readCalls,
  runIn,
  startSessionIn,
  termIds,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'

const ROOM_FOR_A_WRONG_FORCE_CLOSE_MODAL_MS = 1500

test.describe("a renderer reload re-adopts main's live ptys instead of orphaning them, proven on process boundaries rather than DOM", () => {
  test('T-REL-01: a reload re-adopts the session — same pty, one claude, repaint, typing works', async ({
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const [launch] = await waitForCalls(env, 1)
    const idsBefore = await termIds(page)
    expect(idsBefore).toHaveLength(1)
    const row = wsRows(page, 'ws-a').first()

    await page.reload()
    await waitBooted(page)
    await expect.poll(() => termIds(page), { timeout: 30_000 }).toEqual(idsBefore)
    await expect(centerTerm(page)).toContainText('[fake-claude] winch', { timeout: 30_000 })

    await expect(row).not.toHaveClass(/\bcold\b/)
    await row.click()
    await page.waitForTimeout(ROOM_FOR_A_WRONG_FORCE_CLOSE_MODAL_MS)
    await expect(page.locator('.modal')).toHaveCount(0)

    await runIn(page, centerTerm(page), 'after-reload-marker')
    await expect(centerTerm(page)).toContainText('handled: after-reload-marker', {
      timeout: 30_000
    })
    expect(readCalls(env)).toHaveLength(1)
    expect(processAlive(launch.pid)).toBe(true)
  })

  test('T-REL-02: attention markers and the active tab survive the reload — the tab the user was on is reselected, not the last one adopted', async ({
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await waitForCalls(env, 1)
    await runIn(page, centerTerm(page), 'marker-a')
    await expect(centerTerm(page)).toContainText('handled: marker-a', { timeout: 30_000 })
    await startSessionIn(page, 'ws-b')
    await waitForCalls(env, 2)
    await runIn(page, centerTerm(page), 'marker-b')
    await expect(centerTerm(page)).toContainText('handled: marker-b', { timeout: 30_000 })
    await expect.poll(() => pendingAttention(page), { timeout: 15_000 }).toHaveLength(2)
    const rowA = wsRows(page, 'ws-a').first()
    await rowA.click()
    await expect(rowA).toHaveClass(/\bactive\b/)
    await expect.poll(() => pendingAttention(page), { timeout: 15_000 }).toHaveLength(1)
    const ids = await termIds(page)
    expect(ids).toHaveLength(2)

    await page.reload()
    await waitBooted(page)
    await expect.poll(() => termIds(page), { timeout: 30_000 }).toEqual(ids)
    await expect(rowA).toHaveClass(/\bactive\b/, { timeout: 30_000 })
    await expect(wsRows(page, 'ws-b').first()).not.toHaveClass(/\bactive\b/)
    await expect.poll(() => pendingAttention(page), { timeout: 15_000 }).toHaveLength(1)
    await wsRows(page, 'ws-b').first().click()
    await expect.poll(() => pendingAttention(page), { timeout: 15_000 }).toHaveLength(0)
  })

  test('T-REL-03: a crashed renderer auto-recovers and re-adopts (the production path)', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    // PLATFORM§18
    const inRenderer = <T>(expr: string): Promise<T> =>
      app.evaluate(
        ({ BrowserWindow }, js) =>
          BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(js) as Promise<T>,
        expr
      )

    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const [launch] = await waitForCalls(env, 1)
    const idsBefore = await termIds(page)

    const crashed = page.waitForEvent('crash')
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.webContents.forcefullyCrashRenderer()
    })
    await crashed
    // PLATFORM§18
    await page.waitForEvent('domcontentloaded', { timeout: 30_000 })
    await expect
      .poll(
        () =>
          inRenderer<boolean>(
            '!!(window.__koloftShortcutsReady && window.__koloftRowsReady)'
          ).catch(() => false),
        { timeout: 30_000 }
      )
      .toBe(true)
    await expect
      .poll(() => inRenderer<string[]>('Object.keys(window.__koloftTerms ?? {})'), {
        timeout: 30_000
      })
      .toEqual(idsBefore)
    await inRenderer<void>(
      `window.api.terminal.write(${JSON.stringify(idsBefore[0])}, 'after-crash-marker\\r')`
    )
    await expect
      .poll(
        () =>
          inRenderer<string>(
            `(() => { const t = (window.__koloftTerms ?? {})[${JSON.stringify(idsBefore[0])}];
             if (!t) return '';
             const b = t.buffer.active; const out = [];
             for (let i = 0; i < b.length; i++) out.push(b.getLine(i)?.translateToString(true) ?? '');
             return out.join('\\n') })()`
          ),
        { timeout: 30_000 }
      )
      .toContain('handled: after-crash-marker')
    expect(readCalls(env)).toHaveLength(1)
    expect(processAlive(launch.pid)).toBe(true)
  })

  test('T-REL-05: closing the window and opening it again (macOS keeps the app alive) brings back the tab the user was on, though that path runs the renderer teardown twice', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await waitForCalls(env, 1)
    await startSessionIn(page, 'ws-b')
    await waitForCalls(env, 2)
    const rowA = wsRows(page, 'ws-a').first()
    await rowA.click()
    await expect(rowA).toHaveClass(/\bactive\b/)
    const ids = await termIds(page)
    expect(ids).toHaveLength(2)

    const closed = page.waitForEvent('close')
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
    await closed
    const opened = app.waitForEvent('window')
    await app.evaluate(({ app }) => app.emit('activate'))
    const reopened = await opened
    await waitBooted(reopened)

    await expect.poll(() => termIds(reopened), { timeout: 30_000 }).toEqual(ids)
    await expect(wsRows(reopened, 'ws-a').first()).toHaveClass(/\bactive\b/, { timeout: 30_000 })
    await expect(wsRows(reopened, 'ws-b').first()).not.toHaveClass(/\bactive\b/)
    expect(readCalls(env)).toHaveLength(2)
  })
})
