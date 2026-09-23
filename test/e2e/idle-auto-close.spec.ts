import fs from 'fs'
import path from 'path'
import type { Locator } from '@playwright/test'
import { test, expect, launchApp, pendingAttention, quitAndClose } from './helpers/app'
import {
  processAlive,
  resumedId,
  setNextSessionTitle,
  startSessionIn,
  waitBooted,
  waitForCalls
} from './helpers/p1'
import { EDIT, editReady, typeAtEnd } from './helpers/editPane'
import { openFileTab, workbenchPanel } from './helpers/workbench'
import { seedSettings } from './helpers/env'

/**
 * Issue a session left alone long enough closes itself, and says nothing.
 *
 * Three sessions, one reason each to stay or go:
 *   A  idle, nobody looking, nothing unsaved  → closes
 *   B  idle and nobody looking, but its editor holds unsaved text → stays
 *   C  the tab the user is looking at         → stays
 *
 * First, though, none of them may close: every finished turn leaves a "needs you" mark
 * here (the test window never has focus, which is the "user is elsewhere" case), and an
 * unseen mark holds a session open — closing would wipe the mark unread. The case walks
 * the user past all three rows to consume the marks, and only then does A go.
 * A's claude really dies, A's row goes cold in place, nothing is said about it (no
 * toast, no dialog, no Dock count), and clicking A's cold row brings the SAME session
 * back. B is the only end-to-end proof that the unsaved-edit set really travels from
 * the renderer to main; every rule is also covered one at a time in
 * test/unit/sessionStatusBackground.test.ts.
 *
 * Window focus is deliberately not a rule — the test window never has any, and neither
 * does a real window sitting behind another app.
 *
 * Both timers are shrunk to seconds through main's own env seams. They are read at
 * import time, so they have to travel in the launch env — hence the hand-rolled launch.
 */
test('an idle session closes itself quietly; an unsaved edit and the open tab keep theirs', async ({
  env
}) => {
  test.setTimeout(120_000)
  env.launchEnv.KOLOFT_IDLE_MS = '1000' // 'waiting' → 'idle'
  env.launchEnv.KOLOFT_IDLE_CLOSE_MS = '3000' // 'idle' → close, and every refusal
  // a second session in one workspace earns the 'worktree' tip, whose card sits over
  // the very row this case clicks. Nothing here is about tips.
  seedSettings(env, { hintsOff: true })
  const editable = path.join(env.workspaces.b, 'notes.txt')
  fs.writeFileSync(editable, 'koloft-e2e-idle-close\n')

  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitBooted(page)
    const row = (title: string): Locator => page.locator('.ws-tab', { hasText: title })

    // A — one finished turn, then left alone. While it is the open tab nothing can
    // close it, so the case never races its own setup.
    setNextSessionTitle(env, 'Idle A')
    await startSessionIn(page, 'ws-a')
    const [a] = await waitForCalls(env, 1)

    // B — same, plus unsaved text in its editor
    setNextSessionTitle(env, 'Unsaved B')
    await startSessionIn(page, 'ws-b')
    const [, b] = await waitForCalls(env, 2)
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    await openFileTab(page, env, editable)
    await page.locator(EDIT.tabEdit).click()
    await editReady(page, 'koloft-e2e-idle-close')
    await typeAtEnd(page, 'unsaved')
    await expect(page.locator(EDIT.dirty)).toBeVisible()

    // C — the one the user is on, which is what takes A and B out of the open tab
    setNextSessionTitle(env, 'Open C')
    await startSessionIn(page, 'ws-a')
    const [, , c] = await waitForCalls(env, 3)
    await expect(row('Open C')).toHaveClass(/\bactive\b/)

    // Nothing may close yet: all three finished a turn unwatched, so all three hold an
    // unseen "needs you" mark. A whole close window goes by with A still running.
    await expect.poll(() => pendingAttention(page), { timeout: 25_000 }).toHaveLength(3)
    await page.waitForTimeout(4000)
    expect(processAlive(a.pid)).toBe(true)

    // The user walks the rows — each visit consumes that row's mark — and ends on C.
    await row('Idle A').click()
    await row('Unsaved B').click()
    await row('Open C').click()
    await expect.poll(() => pendingAttention(page), { timeout: 10_000 }).toHaveLength(0)
    await expect(row('Open C')).toHaveClass(/\bactive\b/)

    // A's claude is gone for real — not merely a row that stopped saying it is running
    await expect.poll(() => processAlive(a.pid), { timeout: 40_000 }).toBe(false)
    await expect(row('Idle A')).toHaveClass(/\bcold\b/, { timeout: 30_000 })
    await expect(row('Idle A')).not.toHaveClass(/\bactive\b/)

    // …and it happened without a word
    await expect(page.locator('.toast-msg')).toHaveCount(0)
    await expect(page.locator('.modal')).toHaveCount(0)
    expect(await app.evaluate(({ app }) => app.dock?.getBadge?.() ?? '')).toBe('')

    // The other two were never in danger. B went idle at the same time as A and is held
    // only by its unsaved line, so this waits out a second whole close window first —
    // checked the instant A died it would pass on B merely lagging behind.
    await page.waitForTimeout(4000)
    expect(processAlive(b.pid)).toBe(true)
    expect(processAlive(c.pid)).toBe(true)
    await expect(row('Unsaved B')).not.toHaveClass(/\bcold\b/)
    await expect(row('Open C')).not.toHaveClass(/\bcold\b/)

    // the cold row still leads back to the SAME conversation
    await row('Idle A').click()
    const calls = await waitForCalls(env, 4)
    expect(resumedId(calls[3])).toBe(a.sessionId)
  } finally {
    await quitAndClose(app)
  }
})
