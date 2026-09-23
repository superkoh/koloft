import { test, expect } from './helpers/app'
import { openSessionTerminal, panelTerm, runIn, startSessionIn, waitBooted } from './helpers/p1'

// Requirement: the suite runs on a developer's LIVE machine — a test launch must be
// completely imperceptible: never steal macOS focus, and never put a window on the
// screen at all (even an unfocused window draws over the user's app — worst on a
// fullscreen Space). Background test mode (KOLOFT_TEST_BACKGROUND=1, set for every
// launch by helpers/env.ts) runs the app as a never-activating accessory whose
// window is never shown, yet stays fully drivable via CDP. If this test fails, the
// suite is interrupting real work.
test('a test launch is invisible — no focus, no on-screen window — yet fully drivable', async ({
  app,
  page
}) => {
  test.setTimeout(180_000)
  await waitBooted(page)
  // D1: a shell only exists inside a live session's panel now, so the session comes
  // first. It is not scenery — starting one is itself part of "fully drivable while hidden".
  await startSessionIn(page, 'ws-a')
  await openSessionTerminal(app, page)

  // fully drivable while hidden: keystrokes reach the pty and output renders
  await runIn(page, panelTerm(page), 'echo "BG-$((40+2))-OK"')
  await expect(panelTerm(page)).toContainText('BG-42-OK', { timeout: 15_000 })

  // ...and at no point did anything reach the user's screen, focus, or Dock
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
