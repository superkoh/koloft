import { test, expect } from './helpers/app'
import { openSessionTerminal, panelTerm, runIn, startSessionIn, waitBooted } from './helpers/p1'

test.describe('background test launch (KOLOFT_TEST_BACKGROUND=1): the suite runs on a live developer machine and must never be seen', () => {
  test('a test launch is invisible — no focus, no on-screen window — yet fully drivable', async ({
    app,
    page
  }) => {
    test.setTimeout(180_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await openSessionTerminal(app, page)

    await runIn(page, panelTerm(page), 'echo "BG-$((40+2))-OK"')
    await expect(panelTerm(page)).toContainText('BG-42-OK', { timeout: 15_000 })

    const win = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0]
      return { visible: w.isVisible(), focused: w.isFocused() }
    })
    expect(win.visible).toBe(false)
    expect(win.focused).toBe(false)
    const dockVisible = await app.evaluate(({ app: a }) =>
      process.platform === 'darwin' ? a.dock?.isVisible() : false
    )
    expect(dockVisible).toBe(false)
  })
})
