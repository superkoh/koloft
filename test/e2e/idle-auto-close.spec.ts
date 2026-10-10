import fs from 'fs'
import path from 'path'
import type { Locator } from '@playwright/test'
import { test, expect, launchApp, pendingAttention, quitAndClose } from './helpers/app'
import {
  focusOwner,
  processAlive,
  readCalls,
  resumedId,
  setNextSessionTitle,
  startSessionIn,
  terminalText,
  termIds,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'
import { EDIT, editReady, typeAtEnd } from './helpers/editPane'
import { openFileTab, workbenchPanel } from './helpers/workbench'
import { seedSettings } from './helpers/env'

const WAITING_TO_IDLE_MS = 1000
const IDLE_TO_CLOSE_AND_EACH_REFUSAL_MS = 3000
const ONE_CLOSE_WINDOW_WITH_MARGIN_MS = 4000

test('an idle session goes to sleep quietly once its needs-you mark is seen (window focus is not a rule): its process ends but its row, tab and screen stay; an unsaved edit and the open tab keep their process; clicking it wakes the same session in that tab, and a line typed while it wakes reaches it', async ({
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

    const asleepTab = await row('Idle A').getAttribute('data-tab-id')
    await expect.poll(() => processAlive(a.pid), { timeout: 40_000 }).toBe(false)
    await page.waitForTimeout(ONE_CLOSE_WINDOW_WITH_MARGIN_MS)
    await expect(row('Idle A')).toHaveClass(/\bst-idle\b/)
    await expect(row('Idle A')).not.toHaveClass(/\bactive\b/)
    expect(await row('Idle A').getAttribute('data-tab-id')).toBe(asleepTab)
    const frozen = await terminalText(page, asleepTab!)
    expect(frozen).toContain(a.sessionId)
    expect(frozen).not.toContain('Resume this session with')

    await expect(page.locator('.toast-msg')).toHaveCount(0)
    await expect(page.locator('.modal')).toHaveCount(0)
    expect(await app.evaluate(({ app }) => app.dock?.getBadge?.() ?? '')).toBe('')

    expect(processAlive(b.pid)).toBe(true)
    expect(processAlive(c.pid)).toBe(true)
    await expect(row('Unsaved B')).not.toHaveClass(/\bcold\b/)
    await expect(row('Open C')).not.toHaveClass(/\bcold\b/)
    expect(readCalls(env)).toHaveLength(3)

    await row('Idle A').click()
    await expect(row('Idle A')).toHaveClass(/\bactive\b/)
    await expect.poll(() => focusOwner(page)).toBe('tui')
    await page.keyboard.type('/answer typed while waking')
    await page.keyboard.press('Enter')
    const calls = await waitForCalls(env, 4)
    expect(resumedId(calls[3])).toBe(a.sessionId)
    await expect(row('Idle A')).not.toHaveAttribute('data-tab-id', asleepTab!)
    const wokenTab = await row('Idle A').getAttribute('data-tab-id')
    await expect
      .poll(() => terminalText(page, wokenTab!), { timeout: 30_000 })
      .toContain('answered: typed while waking')
    expect(await termIds(page)).not.toContain(asleepTab)
    await expect(wsRows(page, 'ws-a')).toHaveCount(2)
  } finally {
    await quitAndClose(app)
  }
})

test('a Keep running session never goes to sleep for being idle, while an unmarked one beside it does', async ({
  env
}) => {
  test.setTimeout(120_000)
  env.launchEnv.KOLOFT_IDLE_MS = String(WAITING_TO_IDLE_MS)
  env.launchEnv.KOLOFT_IDLE_CLOSE_MS = String(IDLE_TO_CLOSE_AND_EACH_REFUSAL_MS)
  seedSettings(env, { hintsOff: true })

  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    await waitBooted(page)
    const row = (title: string): Locator => page.locator('.ws-tab', { hasText: title })

    setNextSessionTitle(env, 'Resident A')
    await startSessionIn(page, 'ws-a')
    const [a] = await waitForCalls(env, 1)
    await row('Resident A').click({ button: 'right' })
    await page.locator('.menu .mi', { hasText: 'Keep running' }).click()
    await expect(row('Resident A').locator('.ws-tab-resident')).toBeVisible()

    setNextSessionTitle(env, 'Idle C')
    await startSessionIn(page, 'ws-b')
    const [, c] = await waitForCalls(env, 2)
    setNextSessionTitle(env, 'Open B')
    await startSessionIn(page, 'ws-a')
    await waitForCalls(env, 3)

    await expect.poll(() => pendingAttention(page), { timeout: 25_000 }).toHaveLength(3)
    await row('Resident A').click()
    await row('Idle C').click()
    await row('Open B').click()
    await expect.poll(() => pendingAttention(page), { timeout: 10_000 }).toHaveLength(0)

    await expect.poll(() => processAlive(c.pid), { timeout: 40_000 }).toBe(false)
    expect(processAlive(a.pid)).toBe(true)
    await expect(row('Resident A')).not.toHaveClass(/\bcold\b/)
    await expect(row('Idle C')).toHaveClass(/\bst-idle\b/)
  } finally {
    await quitAndClose(app)
  }
})
