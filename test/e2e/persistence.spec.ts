import fs from 'fs'
import path from 'path'
import { test, expect, launchApp } from './helpers/app'
import { FAKE_SESSION_TITLE, startSessionIn, waitBooted } from './helpers/p1'

// Only the `env` fixture is used, so the auto app/page fixtures are never created —
// this spec owns two launches against the SAME isolated home to verify restore.
//
// Requirement (layout v2, T-LIFE-09): a restart lands COLD — sessions live in Claude's
// storage, Koloft persists only workspaces + aux state (A10). Relaunching must
//  · re-list the session as a cold row (no pty spawned, no auto --resume),
//  · select nothing (no active row, the center shows the empty state),
//  · persist no activeSessionId / tab snapshot in layout.json,
//  · still reopen the window with its last bounds instead of the 1440×920 default.
test('restart lands cold: session listed unselected, nothing respawns, window bounds return', async ({
  env
}) => {
  const app1 = await launchApp(env)
  const page1 = await app1.firstWindow()
  await page1.waitForLoadState('domcontentloaded')

  await waitBooted(page1)
  await startSessionIn(page1, 'ws-a')
  await expect(page1.locator('.ws-tab-title', { hasText: FAKE_SESSION_TITLE })).toBeVisible({
    timeout: 25_000
  })

  // give the window a distinctive geometry for the relaunch to restore
  await app1.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setBounds({ x: 80, y: 80, width: 1180, height: 760 })
  })
  await page1.waitForTimeout(1500) // let the debounced saves land
  await app1.close()

  // relaunch against the same home
  const app2 = await launchApp(env)
  const page2 = await app2.firstWindow()
  await page2.waitForLoadState('domcontentloaded')

  // the session is re-aggregated from Claude's storage as a COLD, UNSELECTED row
  const row = page2.locator('.ws-tab', { hasText: FAKE_SESSION_TITLE })
  await expect(row).toBeVisible({ timeout: 20_000 })
  await expect(row).toHaveClass(/\bcold\b/)
  await expect(row).not.toHaveClass(/\bactive\b/)
  // nothing is running or selected: no lightbar states, and the center empty state
  await expect(
    page2.locator('.ws-tab.st-working, .ws-tab.st-waiting, .ws-tab.st-approval, .ws-tab.st-idle')
  ).toHaveCount(0)
  await expect(page2.locator('.center')).toContainText('No running session')
  // …and nothing respawned: the fake claude was launched exactly once, ever
  await page2.waitForTimeout(2000)
  const calls = fs.readFileSync(env.claudeCalls, 'utf8').trim().split('\n')
  expect(calls).toHaveLength(1)

  // layout v3 carries no session snapshot: no tab list, no persisted selection. (v3 is
  // 's Workbench merge — `aux` became `workbench` and the version gate went with it;
  // the no-snapshot claim below is untouched by that and is what this case is about.)
  const layout = JSON.parse(fs.readFileSync(path.join(env.userData, 'layout.json'), 'utf8'))
  expect(layout.version).toBe(4)
  expect(layout).not.toHaveProperty('activeSessionId')
  expect(layout).not.toHaveProperty('tabs')
  expect(layout).not.toHaveProperty('aux')

  // window geometry survived the restart
  const bounds = await app2.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].getBounds()
  )
  expect(bounds.width).toBe(1180)
  expect(bounds.height).toBe(760)
  await app2.close()
})

// Requirement: quitting in native fullscreen restores INTO fullscreen on relaunch — the
// green-button fix (omit the option instead of passing `fullscreen: false`) must keep
// passing an explicit `fullscreen: true` for this path.
test('a window quit in fullscreen restores into fullscreen', async ({ env }) => {
  // Entering real macOS fullscreen grabs an entire Space and yanks the user's screen —
  // the one thing background test mode exists to prevent. Opt in explicitly (CI, or a
  // machine nobody is using); the launch must then be a regular, activatable app.
  test.skip(
    process.env.KOLOFT_E2E_FULLSCREEN !== '1',
    'grabs a macOS Space / steals the screen — opt in with KOLOFT_E2E_FULLSCREEN=1'
  )
  delete env.launchEnv.KOLOFT_TEST_BACKGROUND
  // try/finally on both launches: a leaked FULLSCREEN app is worse than a leaked
  // window — it owns a macOS Space and destabilizes the rest of the serial suite.
  const app1 = await launchApp(env)
  try {
    const page1 = await app1.firstWindow()
    await page1.waitForLoadState('domcontentloaded')
    await app1.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setFullScreen(true)
    })
    // macOS animates the window into its own Space; the immediate enter-full-screen
    // state write lands once the flag flips
    await expect
      .poll(
        () => app1.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()),
        { timeout: 15_000 }
      )
      .toBe(true)
  } finally {
    await app1.close().catch(() => {})
  }

  const app2 = await launchApp(env)
  try {
    const page2 = await app2.firstWindow()
    await page2.waitForLoadState('domcontentloaded')
    await expect
      .poll(
        () => app2.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isFullScreen()),
        { timeout: 15_000 }
      )
      .toBe(true)
    // restoring into fullscreen must not cost the green button its fullscreen action
    const fullscreenable = await app2.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].isFullScreenable()
    )
    expect(fullscreenable).toBe(true)
  } finally {
    await app2.close().catch(() => {})
  }
})
