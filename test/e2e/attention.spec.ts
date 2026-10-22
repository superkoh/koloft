import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, osOutlets, pendingAttention, quitAndClose } from './helpers/app'
import { installCodex, seedSettings } from './helpers/env'
import { codexRows, startCodex } from './helpers/codex'
import {
  centerTerm,
  FAKE_SESSION_TITLE,
  killSession,
  runIn,
  sendShortcut,
  startSessionIn,
  waitBooted,
  waitForCalls,
  wsGroup
} from './helpers/p1'

const PAST_TWO_LIVENESS_SWEEPS_MS = 6_000
const COMPACTION_SETTLE_MS = 3_000

async function lookAtTheWindow(app: ElectronApplication): Promise<void> {
  await app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0]
    win.isFocused = () => true
    win.emit('focus')
  })
}

const markOn = async (page: Page, tabId: string) =>
  (await pendingAttention(page)).find((e) => e.tabId === tabId)

test.describe('attention markers come from real session-status transitions (shim → hooks → tracker → attention set)', () => {
  test('a finished turn pends attention and a red dot on its row, visiting the tab keeps both, and only the session working again clears them', async ({
    page
  }) => {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')

    await expect(page.locator('.ws .ws-tab.st-waiting')).toBeVisible({ timeout: 25_000 })

    await expect
      .poll(() => pendingAttention(page), { timeout: 10_000 })
      .toMatchObject([{ kind: 'turn-done', title: expect.stringContaining('project notes') }])
    await expect(page.locator('.ws .ws-tab.st-waiting .ws-tab-unread')).toHaveCount(1)

    const head = page.locator('.ws-head', { hasText: 'ws-a' })
    await head.locator('.fico').click()
    await expect(head.locator('.ws-unread-count')).toHaveText('1')
    await head.locator('.fico').click()
    await expect(head.locator('.ws-unread-count')).toHaveCount(0)

    await expect(page.locator('.needs')).toHaveCount(0)
    await expect(page.locator('.sb-rollup')).toHaveCount(0)
    await expect(page.locator('.toast')).toHaveCount(0)

    await page.locator('.ws .ws-tab').first().click()
    await expect(page.locator('.ws .ws-tab.active')).toHaveCount(1)
    expect(await pendingAttention(page)).toHaveLength(1)
    await expect(page.locator('.ws .ws-tab-unread')).toHaveCount(1)

    await runIn(page, centerTerm(page), '/busy')
    await expect.poll(() => pendingAttention(page), { timeout: 15_000 }).toHaveLength(0)
    await expect(page.locator('.ws .ws-tab-unread')).toHaveCount(0)
  })

  test('the bell counts the waiting sessions and walks them longest wait first, round and round, unfolding the workspace it lands in; ⌘J does the same, and only an answer takes one off', async ({
    app,
    page
  }) => {
    await waitBooted(page)
    const bell = page.locator('.aux-ico.waiting-bell')
    await expect(bell).toHaveCount(0)
    await startSessionIn(page, 'ws-a')
    await expect.poll(() => pendingAttention(page), { timeout: 25_000 }).toHaveLength(1)
    await startSessionIn(page, 'ws-b')
    await expect.poll(() => pendingAttention(page), { timeout: 25_000 }).toHaveLength(2)
    await expect(bell.locator('.ws-unread-count')).toHaveText('2')

    const activeIn = (ws: string) => wsGroup(page, ws).locator('.ws-tab.active')
    await expect(activeIn('ws-b')).toHaveCount(1)
    const [older] = (await pendingAttention(page)).sort((x, y) => x.at - y.at)
    const aTab = await wsGroup(page, 'ws-a').locator('.ws-tab').getAttribute('data-tab-id')
    expect(older.tabId).toBe(aTab)

    await bell.click()
    await expect(activeIn('ws-a')).toHaveCount(1)
    expect(await pendingAttention(page)).toHaveLength(2)

    await wsGroup(page, 'ws-b').locator('.ws-head .fico').click()
    await expect(wsGroup(page, 'ws-b').locator('.ws-tab')).toHaveCount(0)
    await bell.click()
    await expect(activeIn('ws-b')).toHaveCount(1)

    await sendShortcut(app, 'shortcut:next-waiting-session')
    await expect(activeIn('ws-a')).toHaveCount(1)

    await page.evaluate((id) => window.api.terminal.write(id, '/busy\r'), aTab!)
    await expect(bell.locator('.ws-unread-count')).toHaveText('1', { timeout: 15_000 })
  })

  test('a bell press while the sidebar is hidden is shown once the sidebar comes back: its list scrolls to the row the bell went to; a plain hide and show leaves a folded workspace folded', async ({
    app,
    page
  }) => {
    await waitBooted(page)
    await startSessionIn(page, 'ws-b')
    await expect.poll(() => pendingAttention(page), { timeout: 25_000 }).toHaveLength(1)
    await startSessionIn(page, 'ws-a')
    await expect.poll(() => pendingAttention(page), { timeout: 25_000 }).toHaveLength(2)
    await page.addStyleTag({ content: '.ws-list { max-height: 80px !important; }' })
    const list = page.locator('.ws-list')
    await list.evaluate((el) => (el.scrollTop = 0))
    const bRow = wsGroup(page, 'ws-b').locator('.ws-tab')
    const inView = async (): Promise<boolean> => {
      const [row, box] = [await bRow.boundingBox(), await list.boundingBox()]
      return !!row && !!box && row.y >= box.y - 1 && row.y + row.height <= box.y + box.height + 1
    }
    expect(await inView()).toBe(false)

    await sendShortcut(app, 'shortcut:toggle-sidebar')
    await expect(page.locator('.app.sb-off')).toHaveCount(1)
    await page.locator('.aux-ico.waiting-bell').click()
    await expect(bRow).toHaveClass(/\bactive\b/)
    await sendShortcut(app, 'shortcut:toggle-sidebar')
    await expect(page.locator('.app.sb-off')).toHaveCount(0)
    await expect.poll(inView).toBe(true)

    await wsGroup(page, 'ws-b').locator('.ws-head .fico').click()
    await expect(bRow).toHaveCount(0)
    await sendShortcut(app, 'shortcut:toggle-sidebar')
    await expect(page.locator('.app.sb-off')).toHaveCount(1)
    await sendShortcut(app, 'shortcut:toggle-sidebar')
    await expect(page.locator('.app.sb-off')).toHaveCount(0)
    await expect(wsGroup(page, 'ws-b').locator('.ws-head')).toBeVisible()
    await expect(bRow).toHaveCount(0)
  })

  test('a turn that ends while a session it started still works is only news, told by code alone: looking at it clears the dot', async ({
    env
  }) => {
    test.setTimeout(120_000)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      const parentTab = (await page.locator('.ws .ws-tab.active').getAttribute('data-tab-id'))!
      await expect.poll(() => markOn(page, parentTab), { timeout: 25_000 }).toBeTruthy()
      const type = (tab: string, line: string): Promise<void> =>
        page.evaluate(([id, l]) => window.api.terminal.write(id, l + '\r'), [tab, line])
      await type(parentTab, '/koloft session new -- help me')
      await waitForCalls(env, 2)
      const helper = page.locator(`.ws .ws-tab:not([data-tab-id="${parentTab}"])`)
      await expect(helper).toHaveClass(/\bst-waiting\b/, { timeout: 30_000 })
      await type((await helper.getAttribute('data-tab-id'))!, '/busy')
      await expect(helper).toHaveClass(/\bst-working\b/, { timeout: 20_000 })
      await type(parentTab, 'reporting back')
      await expect
        .poll(async () => (await markOn(page, parentTab))?.fyi, { timeout: 20_000 })
        .toBe(true)
      await page.locator(`.ws .ws-tab[data-tab-id="${parentTab}"]`).click()
      await expect(page.locator(`.ws .ws-tab[data-tab-id="${parentTab}"]`)).toHaveClass(
        /\bactive\b/
      )
      expect(await markOn(page, parentTab)).toBeTruthy()
      await lookAtTheWindow(app)
      await expect.poll(() => markOn(page, parentTab)).toBeUndefined()
    } finally {
      await quitAndClose(app)
    }
  })

  test('with Assist on, a finished turn the Assist reads as a report is only news: looking at it clears the dot', async ({
    env
  }) => {
    seedSettings(env, { hintsOff: true, assist: { on: true, backend: 'claude' } })
    fs.writeFileSync(path.join(env.home, 'fake-claude-assist-reply'), 'NEWS')
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      await runIn(page, centerTerm(page), '/answer the build is green')
      await expect
        .poll(async () => (await pendingAttention(page)).map((m) => m.fyi), { timeout: 30_000 })
        .toEqual([true])
      await expect(page.locator('.ws .ws-tab-unread')).toHaveAttribute(
        'title',
        'turn done — just letting you know'
      )
      await lookAtTheWindow(app)
      await expect.poll(() => pendingAttention(page)).toEqual([])
    } finally {
      await quitAndClose(app)
    }
  })

  test('Claude compacting a finished session on its own leaves its dot exactly as it was and sends no new notice', async ({
    app,
    page
  }) => {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await expect.poll(() => pendingAttention(page), { timeout: 25_000 }).toHaveLength(1)
    const before = await pendingAttention(page)
    const noticesBefore = (await osOutlets(app)).notifications.length

    await runIn(page, centerTerm(page), '/compact-while-idle')
    await expect(centerTerm(page)).toContainText('compacted while idle')
    const settled = Date.now() + COMPACTION_SETTLE_MS
    while (Date.now() < settled) {
      expect(await pendingAttention(page)).toEqual(before)
      await page.waitForTimeout(50)
    }
    expect((await osOutlets(app)).notifications).toHaveLength(noticesBefore)
  })

  test('a graceful /exit clears its pending mark and never raises exited, not even after two liveness sweeps', async ({
    page
  }) => {
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await expect.poll(() => pendingAttention(page), { timeout: 25_000 }).toHaveLength(1)
    const tab = (await page.locator('.ws .ws-tab.active').getAttribute('data-tab-id'))!

    // CC§1
    await runIn(page, centerTerm(page), '/exit')
    await expect.poll(() => markOn(page, tab), { timeout: 15_000 }).toBeUndefined()
    await page.waitForTimeout(PAST_TWO_LIVENESS_SWEEPS_MS)
    expect(await markOn(page, tab)).toBeUndefined()
  })

  test('T-LIFE-04: a hard-killed claude turns its row cold in place, keeping its title', async ({
    page,
    env
  }) => {
    test.setTimeout(150_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await expect(page.locator('.ws .ws-tab.st-waiting')).toBeVisible({ timeout: 25_000 })

    const [call] = await waitForCalls(env, 1)
    killSession(call.pid, env)

    const row = page.locator('.ws .ws-tab', { hasText: FAKE_SESSION_TITLE })
    await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })
    await expect(page.locator('.ws .ws-tab.st-waiting')).toHaveCount(0)
    await expect(page.locator('.ws .ws-tab.st-approval')).toHaveCount(0)
  })

  test('a local claude that dies without an end report raises the “exited” mark, drawn as a red dot on its cold row and said in an OS notification naming its folder', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(150_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await expect(page.locator('.ws .ws-tab.st-waiting')).toBeVisible({ timeout: 25_000 })
    await expect.poll(() => pendingAttention(page), { timeout: 10_000 }).toHaveLength(1)

    const [call] = await waitForCalls(env, 1)
    killSession(call.pid, env)

    const row = page.locator('.ws .ws-tab', { hasText: FAKE_SESSION_TITLE })
    await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })
    await expect
      .poll(async () => (await pendingAttention(page)).map((a) => a.kind), { timeout: 10_000 })
      .toEqual(['exited'])
    await expect(row.locator('.ws-tab-unread')).toHaveCount(1)
    expect((await osOutlets(app)).notifications).toContainEqual({
      title: FAKE_SESSION_TITLE,
      body: 'session exited unexpectedly · ws-a'
    })
  })

  test('a local Codex that dies after it bound raises the same “exited” mark, drawn as a red dot on its cold row and said in an OS notification naming its folder', async ({
    env
  }) => {
    test.setTimeout(150_000)
    installCodex(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const { pid } = await startCodex(page, env)
      const row = codexRows(page)
      await expect.poll(() => pendingAttention(page), { timeout: 10_000 }).toHaveLength(1)

      killSession(pid, env)

      await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })
      await expect
        .poll(async () => (await pendingAttention(page)).map((a) => a.kind), { timeout: 10_000 })
        .toEqual(['exited'])
      await expect(row.locator('.ws-tab-unread')).toHaveCount(1)
      expect((await osOutlets(app)).notifications).toContainEqual({
        title: 'Codex fixture session',
        body: 'session exited unexpectedly · ws-a'
      })
    } finally {
      await quitAndClose(app)
    }
  })
})
