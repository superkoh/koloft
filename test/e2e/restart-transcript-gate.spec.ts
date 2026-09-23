import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import type { E2EEnv } from './helpers/env'
import {
  centerTerm,
  clickAppMenuItem,
  encodeCwd,
  gitInit,
  processAlive,
  readCalls,
  resumedId,
  runIn,
  startSessionIn,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'

const WS_A = 'ws-a'

const LIVE_TOAST = 'Nothing to restart yet — this session has no conversation.'

async function launch(env: E2EEnv): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
  await waitBooted(page)
  return { app, page }
}

async function restart(app: ElectronApplication, page: Page): Promise<void> {
  await clickAppMenuItem(app, page, 'restart-session')
}

function transcriptOf(env: E2EEnv, workspace: string, sessionId: string): string {
  return path.join(env.home, '.claude', 'projects', encodeCwd(workspace), sessionId + '.jsonl')
}

// CC§2
async function startSilentSession(
  page: Page,
  env: E2EEnv
): Promise<{ sessionId: string; pid: number }> {
  fs.writeFileSync(env.claudeLazyFile, '1')
  await startSessionIn(page, WS_A)
  const [call] = await waitForCalls(env, 1)
  const transcript = transcriptOf(env, env.workspaces.a, call.sessionId)
  expect(fs.existsSync(transcript), `${transcript} should not exist yet`).toBe(false)
  return { sessionId: call.sessionId, pid: call.pid }
}

async function startConversedSession(
  page: Page,
  env: E2EEnv
): Promise<{ sessionId: string; pid: number; transcript: string }> {
  await startSessionIn(page, WS_A)
  const [call] = await waitForCalls(env, 1)
  const transcript = transcriptOf(env, env.workspaces.a, call.sessionId)
  await expect.poll(() => fs.existsSync(transcript), { timeout: 30_000 }).toBe(true)
  return { sessionId: call.sessionId, pid: call.pid, transcript }
}

test.describe('the ⇧⌘R transcript gate: never kill a session that has no conversation to resume', () => {
  test('BB-M01: ⇧⌘R on a live, never-conversed session is a full no-op with a toast', async ({
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    const { app, page } = await launch(env)
    try {
      const { pid } = await startSilentSession(page, env)
      const rows = wsRows(page, WS_A)
      await expect(rows).toHaveCount(1)
      const before = await page.evaluate(
        () =>
          document.querySelector('.term-island .term-wrap:not([style*="none"])')?.textContent ?? ''
      )

      await restart(app, page)

      await expect(page.locator('.toast-msg')).toHaveText(LIVE_TOAST, { timeout: 20_000 })
      expect(processAlive(pid)).toBe(true)
      expect(readCalls(env)).toHaveLength(1)
      await expect(page.locator('.term-island .term-wrap')).toHaveCount(1)
      await expect(rows).toHaveCount(1)
      await expect(rows.first()).not.toHaveClass(/\bcold\b/)
      const after = await page.evaluate(
        () =>
          document.querySelector('.term-island .term-wrap:not([style*="none"])')?.textContent ?? ''
      )
      expect(after).toBe(before)

      await runIn(page, centerTerm(page), '/scratch gate-probe')
      await expect(page.locator('.term-island .term-wrap:visible')).toContainText(
        'scratched gate-probe',
        { timeout: 20_000 }
      )
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-C03: transcript deleted out from under a live session — the gate refuses instead of killing (+BB-C11: the toast dismisses itself)', async ({
    env
  }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    const { app, page } = await launch(env)
    try {
      const { pid, transcript } = await startConversedSession(page, env)
      fs.rmSync(transcript)

      await restart(app, page)

      await expect(page.locator('.toast-msg')).toHaveText(LIVE_TOAST, { timeout: 20_000 })
      expect(processAlive(pid)).toBe(true)
      expect(readCalls(env)).toHaveLength(1)
      await runIn(page, centerTerm(page), '/scratch still-alive')
      await expect(page.locator('.term-island .term-wrap:visible')).toContainText(
        'scratched still-alive',
        { timeout: 20_000 }
      )

      await expect(page.locator('.toast')).toHaveCount(0, { timeout: 20_000 })
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-C04/C05/C12: the probe resolves false — never rejects — for empty, unknown and non-string ids', async ({
    page
  }) => {
    test.setTimeout(120_000)
    await waitBooted(page)

    expect(await page.evaluate(() => window.api.sessions.transcriptExists(''))).toBe(false)

    expect(
      await page.evaluate(() =>
        window.api.sessions.transcriptExists('9f2c1d84-77aa-4b31-9d0e-5c6b8a4e1f77')
      )
    ).toBe(false)

    expect(
      await page.evaluate(async () => {
        const probe = window.api.sessions.transcriptExists as (id: unknown) => Promise<boolean>
        return Promise.all([probe(null), probe(undefined), probe(42)])
      })
    ).toEqual([false, false, false])
  })

  test('BB-C06: the probe tracks disk truth across a session first message', async ({ env }) => {
    test.setTimeout(180_000)
    gitInit(env.workspaces.a)
    const { app, page } = await launch(env)
    try {
      const { sessionId } = await startSilentSession(page, env)
      const listed = await page.evaluate(async () =>
        (await window.api.sessions.list()).map((s) => s.sessionId)
      )
      expect(listed).toContain(sessionId)

      expect(await page.evaluate((id) => window.api.sessions.transcriptExists(id), sessionId)).toBe(
        false
      )

      await runIn(page, centerTerm(page), 'first thing I say')
      await expect(page.locator('.term-island .term-wrap:visible')).toContainText(
        'handled: first thing I say',
        { timeout: 30_000 }
      )

      expect(await page.evaluate((id) => window.api.sessions.transcriptExists(id), sessionId)).toBe(
        true
      )
    } finally {
      await app.close().catch(() => {})
    }
  })

  test('BB-N01: a gated no-op leaves the session usable, and the first prompt unlocks restart', async ({
    env
  }) => {
    test.setTimeout(240_000)
    gitInit(env.workspaces.a)
    const { app, page } = await launch(env)
    try {
      const { sessionId, pid } = await startSilentSession(page, env)

      await restart(app, page)
      await expect(page.locator('.toast-msg')).toHaveText(LIVE_TOAST, { timeout: 20_000 })
      expect(readCalls(env)).toHaveLength(1)
      await expect(page.locator('.toast')).toHaveCount(0, { timeout: 20_000 })

      await runIn(page, centerTerm(page), 'now we have talked')
      await expect(page.locator('.term-island .term-wrap:visible')).toContainText(
        'handled: now we have talked',
        { timeout: 30_000 }
      )

      await restart(app, page)

      const calls = await waitForCalls(env, 2)
      expect(resumedId(calls[1])).toBe(sessionId)
      await expect.poll(() => processAlive(pid), { timeout: 30_000 }).toBe(false)
      await expect(page.locator('.term-island .term-wrap')).toHaveCount(1)
      await expect(page.locator('.toast')).toHaveCount(0)
    } finally {
      await app.close().catch(() => {})
    }
  })

  test.skip('BB-C07: the gate against a real claude is a manual round with no automated form', () => {})
})
