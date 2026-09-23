import fs from 'fs'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import type { E2EEnv } from './helpers/env'
import {
  gitInit,
  menuItemTexts,
  openMenu,
  openPicker,
  pickerDialog,
  processAlive,
  sendShortcut,
  snap,
  waitForCalls
} from './helpers/p1'

// The pending slice of the session lifecycle:
// the row a launch owns BEFORE Claude reports a session id — how it promotes, how it
// is cancelled, and what a launch that dies before binding leaves behind.
//
// The `fake-claude-delay` seam (§0) holds the pre-bind window open for observation;
// the pending row itself exists from the moment the pty spawns, delay or not.

async function launch(env: E2EEnv): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
  return { app, page }
}

/** ⌘N (real menu item) → ⏎ on C10's preselected row: the §5 two-key launch. Both
 *  fixture workspaces are pinned, so the picker is never skipped. */
async function startMainSession(app: ElectronApplication, page: Page): Promise<void> {
  await openPicker(app, page)
  await page.keyboard.press('Enter')
  await expect(pickerDialog(page)).toHaveCount(0)
}

// T-LIFE-01 — two stages of one row: while claude boots the sidebar already carries
// it (pending, selected, its pty in the center), and when SessionStart reports it
// promotes IN PLACE — same single row, now titled and attributed.
test('T-LIFE-01: a launch shows a pending row, then promotes in place when it binds', async ({
  env
}) => {
  test.setTimeout(180_000)
  gitInit(env.workspaces.a)
  fs.writeFileSync(env.claudeDelayFile, '4000')

  const { app, page } = await launch(env)
  try {
    await startMainSession(app, page)

    // ① inside the window: one pending row, selected, with the booting pty on screen
    const pending = page.locator('.ws-tab.st-pending')
    await expect(pending).toHaveCount(1, { timeout: 20_000 })
    await expect(pending.locator('.ws-tab-title')).toHaveText('Starting…')
    await expect(pending.locator('.ws-tab-sub')).toHaveText('main')
    await expect(pending).toHaveClass(/\bactive\b/)
    await expect(page.locator('.term-wrap:visible').first()).toContainText('delayed bind', {
      timeout: 30_000
    })
    await expect(page.locator('.ws-tab')).toHaveCount(1)
    await snap(page, 'T-LIFE-01')

    // ② the hook lands: the SAME row becomes the real session — never a second row,
    // never an empty sidebar in between
    const row = page.locator('.ws-tab', { hasText: 'Fake session: project notes' })
    await expect(row).toHaveCount(1, { timeout: 40_000 })
    await expect(page.locator('.ws-tab')).toHaveCount(1)
    await expect(page.locator('.ws-tab.st-pending')).toHaveCount(0)
    await expect(row.locator('.ws-tab-sub')).toHaveText('main')
    await expect(row).not.toHaveClass(/\bcold\b/)
  } finally {
    await app.close().catch(() => {})
  }
})

// T-LIFE-02 — a pending row's whole operation surface is Cancel (there is no session
// to close, reveal or copy yet), and ⌘W means the same thing while it is selected
// (= T-KEY-02). Either way the pty dies and the row goes with it.
test('T-LIFE-02: a pending row offers only Cancel; Cancel and ⌘W both kill the launch', async ({
  env
}) => {
  test.setTimeout(180_000)
  gitInit(env.workspaces.a)
  fs.writeFileSync(env.claudeDelayFile, '20000') // long enough to drive the menu

  const { app, page } = await launch(env)
  try {
    await startMainSession(app, page)
    const pending = page.locator('.ws-tab.st-pending')
    await expect(pending).toHaveCount(1, { timeout: 20_000 })
    const [first] = await waitForCalls(env, 1)

    // the menu IS the operation set: one item, nothing borrowed from running/cold
    await openMenu(page, pending)
    expect(await menuItemTexts(page)).toEqual(['Cancel'])
    await snap(page, 'T-LIFE-02')
    await page.locator('.menu .mi', { hasText: 'Cancel' }).click()

    await expect(page.locator('.ws-tab')).toHaveCount(0, { timeout: 30_000 })
    await expect.poll(() => processAlive(first.pid), { timeout: 30_000 }).toBe(false)

    // T-KEY-02: ⌘W on a selected pending row is that same Cancel
    await startMainSession(app, page)
    await expect(pending).toHaveCount(1, { timeout: 20_000 })
    await expect(pending).toHaveClass(/\bactive\b/)
    const calls = await waitForCalls(env, 2)
    await sendShortcut(app, 'shortcut:close-tab')
    await expect(page.locator('.ws-tab')).toHaveCount(0, { timeout: 30_000 })
    await expect.poll(() => processAlive(calls[1].pid), { timeout: 30_000 }).toBe(false)
  } finally {
    await app.close().catch(() => {})
  }
})

// T-LIFE-03 — a launch that dies before it ever binds (broken binary, failed account
// injection, "Not logged in"). Nothing of it stays: the "Starting…" row goes (a row that
// never ends is exactly the ghost the pending mechanism exists to avoid, §4 — possible
// since the launch pty `exec`s claude, index.ts createClaudeTab), and the tab goes with
// the pty like any dead session's (T-LIFE-05). The exit is said out loud instead: with
// no row to resume and no transcript to keep, the toast is the only account there is.
test('T-LIFE-03: a launch that dies before binding leaves nothing behind, and the exit is said out loud', async ({
  env
}) => {
  test.setTimeout(180_000)
  gitInit(env.workspaces.a)
  fs.writeFileSync(env.claudeExitFile, '1')

  const { app, page } = await launch(env)
  try {
    await startMainSession(app, page)
    await expect(page.locator('.ws-tab.st-pending')).toHaveCount(1, { timeout: 20_000 })
    await waitForCalls(env, 1)
    await expect(page.locator('.toast-msg')).toContainText('exit code 1', { timeout: 20_000 })
    await expect(page.locator('.term-island .term-wrap')).toHaveCount(0, { timeout: 20_000 })
    await expect(page.locator('.ws-tab')).toHaveCount(0, { timeout: 30_000 })
  } finally {
    await app.close().catch(() => {})
  }
})
