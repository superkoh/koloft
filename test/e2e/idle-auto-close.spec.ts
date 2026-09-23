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

const WAITING_TO_IDLE_MS = 1000
const IDLE_TO_CLOSE_AND_EACH_REFUSAL_MS = 3000
const ONE_CLOSE_WINDOW_WITH_MARGIN_MS = 4000

test('an idle session closes itself quietly once its needs-you mark is seen (window focus is not a rule); an unsaved edit and the open tab keep theirs; the cold row resumes the same session', async ({
  env
}) => {
  test.setTimeout(120_000)
  env.launchEnv.KOLOFT_IDLE_MS = String(WAITING_TO_IDLE_MS)
  env.launchEnv.KOLOFT_IDLE_CLOSE_MS = String(IDLE_TO_CLOSE_AND_EACH_REFUSAL_MS)
  seedSettings(env, { hintsOff: true })
  const editable = path.join(env.workspaces.b, 'notes.txt')
  fs.writeFileSync(editable, 'koloft-e2e-idle-close\n')

  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitBooted(page)
    const row = (title: string): Locator => page.locator('.ws-tab', { hasText: title })

    setNextSessionTitle(env, 'Idle A')
    await startSessionIn(page, 'ws-a')
    const [a] = await waitForCalls(env, 1)

    setNextSessionTitle(env, 'Unsaved B')
    await startSessionIn(page, 'ws-b')
    const [, b] = await waitForCalls(env, 2)
    await expect(workbenchPanel(page)).toBeVisible({ timeout: 25_000 })
    await openFileTab(page, env, editable)
    await page.locator(EDIT.tabEdit).click()
    await editReady(page, 'koloft-e2e-idle-close')
    await typeAtEnd(page, 'unsaved')
    await expect(page.locator(EDIT.dirty)).toBeVisible()

    setNextSessionTitle(env, 'Open C')
    await startSessionIn(page, 'ws-a')
    const [, , c] = await waitForCalls(env, 3)
    await expect(row('Open C')).toHaveClass(/\bactive\b/)

    await expect.poll(() => pendingAttention(page), { timeout: 25_000 }).toHaveLength(3)
    await page.waitForTimeout(ONE_CLOSE_WINDOW_WITH_MARGIN_MS)
    expect(processAlive(a.pid)).toBe(true)

    await row('Idle A').click()
    await row('Unsaved B').click()
    await row('Open C').click()
    await expect.poll(() => pendingAttention(page), { timeout: 10_000 }).toHaveLength(0)
    await expect(row('Open C')).toHaveClass(/\bactive\b/)

    await expect.poll(() => processAlive(a.pid), { timeout: 40_000 }).toBe(false)
    await expect(row('Idle A')).toHaveClass(/\bcold\b/, { timeout: 30_000 })
    await expect(row('Idle A')).not.toHaveClass(/\bactive\b/)

    await expect(page.locator('.toast-msg')).toHaveCount(0)
    await expect(page.locator('.modal')).toHaveCount(0)
    expect(await app.evaluate(({ app }) => app.dock?.getBadge?.() ?? '')).toBe('')

    await page.waitForTimeout(ONE_CLOSE_WINDOW_WITH_MARGIN_MS)
    expect(processAlive(b.pid)).toBe(true)
    expect(processAlive(c.pid)).toBe(true)
    await expect(row('Unsaved B')).not.toHaveClass(/\bcold\b/)
    await expect(row('Open C')).not.toHaveClass(/\bcold\b/)

    await row('Idle A').click()
    const calls = await waitForCalls(env, 4)
    expect(resumedId(calls[3])).toBe(a.sessionId)
  } finally {
    await quitAndClose(app)
  }
})
