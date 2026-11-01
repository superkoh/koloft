import type { Page } from '@playwright/test'
import { test, expect } from './helpers/app'
import { persistedTabsOnDisk } from './helpers/workbench'
import {
  centerTerm,
  runIn,
  killSession,
  openMenu,
  setNextSessionTitle,
  startSessionIn,
  waitBooted,
  waitForCalls
} from './helpers/p1'

async function sample(page: Page, sid: string, label: string, t0: number): Promise<void> {
  const s = await page.evaluate(async (id) => {
    const w = window as unknown as {
      api: {
        workspace: { rows(): Promise<{ rows: { id: string; running?: boolean }[] }[]> }
        sessions: { list(): Promise<{ sessionId?: string; alive: boolean; tabId: string }[]> }
      }
    }
    const rows = (await w.api.workspace.rows()).flatMap((x) => x.rows).filter((r) => r.id === id)
    const list = (await w.api.sessions.list()).filter((x) => x.sessionId === id)
    const el = document.querySelector('.ws .ws-tab.probe-target') ?? null
    const cls = [...document.querySelectorAll('.ws .ws-tab')]
      .filter((e) => e.textContent?.includes('Remove me'))
      .map((e) => e.className)
    return {
      rows: rows.map((r) => r.running),
      list: list.map((x) => [x.alive, x.tabId]),
      cls,
      el: !!el
    }
  }, sid)
  console.log(label, Date.now() - t0, JSON.stringify(s))
}

test('probe 1166', async ({ page, env }) => {
  test.setTimeout(120_000)
  setNextSessionTitle(env, 'Remove me')
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  const row = page.locator('.ws .ws-tab', { hasText: 'Remove me' })
  await expect(row).toBeVisible({ timeout: 40_000 })
  const [call] = await waitForCalls(env, 1)
  await runIn(page, centerTerm(page), '/open http://127.0.0.1:1/removed')
  await expect
    .poll(() => persistedTabsOnDisk(env, call.sessionId).length, { timeout: 30_000 })
    .toBe(1)
  const t0 = Date.now()
  await sample(page, call.sessionId, 'before', t0)
  killSession(call.pid, env)
  for (let i = 0; i < 40; i++) {
    await sample(page, call.sessionId, 'killed', t0)
    await page.waitForTimeout(100)
  }
  await openMenu(page, row)
  await page.locator('.menu .mi', { hasText: /^Close/ }).click()
  for (let i = 0; i < 15; i++) {
    await sample(page, call.sessionId, 'closed', t0)
    await page.waitForTimeout(100)
  }
})
