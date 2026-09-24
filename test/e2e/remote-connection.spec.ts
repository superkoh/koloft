import fs from 'fs'
import path from 'path'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  addRemoteWorkspace,
  breakConnection,
  healConnection,
  killFakeRemote,
  launchWithRemote,
  liveTmuxSessions,
  REMOTE_WS_NAME,
  sshCommands
} from './helpers/remote'
import {
  type ClaudeCall,
  centerTerm,
  processAlive,
  runIn,
  startSessionIn,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'
import type { E2EEnv } from './helpers/env'

const LAYOUT_SAVE_DEBOUNCE_SETTLE_MS = 3000
const SEVERAL_FAILED_2S_HEARTBEATS_MS = 8000
const IDLE_20S_HEARTBEAT_ROUND_TIMEOUT_MS = 60_000
const TMUX_ATTACH_SETTLE_MS = 2000
const TURN_LONGER_THAN_ONE_MIRROR_PULL = '/busy'

test.afterEach(({ env }) => killFakeRemote(env))

function layoutMembers(env: E2EEnv): string[] {
  const file = path.join(env.userData, 'layout.json')
  const layout = JSON.parse(fs.readFileSync(file, 'utf8')) as { members: string[] }
  return layout.members
}

test.describe('losing and regaining the machine: Koloft never invents an ending for a remote session', () => {
  test('E-RW-07: heartbeats failing does not cool a remote row or close its tab', async ({
    env
  }) => {
    test.setTimeout(240_000)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      const [first] = await waitForCalls(env, 1)
      const row = wsRows(page, REMOTE_WS_NAME).first()

      breakConnection(env)
      await page.waitForTimeout(SEVERAL_FAILED_2S_HEARTBEATS_MS)

      await expect(row).not.toHaveClass(/\bcold\b/)
      await expect(centerTerm(page)).toBeVisible()
      expect(processAlive(first.pid)).toBe(true)

      healConnection(env)
      await page.waitForTimeout(6000)
      await expect(row).not.toHaveClass(/\bcold\b/)
      expect(liveTmuxSessions(env)).toContain(`k-${first.sessionId}`)
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RW-08: after a Koloft restart the remote session is still running, clicking attaches, and its hooks still reach the attached tab', async ({
    env
  }) => {
    test.setTimeout(300_000)
    const { app, page } = await launchWithRemote(env)
    let first!: ClaudeCall
    try {
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      ;[first] = await waitForCalls(env, 1)
      await page.waitForTimeout(LAYOUT_SAVE_DEBOUNCE_SETTLE_MS)
    } finally {
      await quitAndClose(app)
    }

    expect(processAlive(first.pid)).toBe(true)
    expect(liveTmuxSessions(env)).toContain(`k-${first.sessionId}`)

    const app2 = await launchApp(env)
    try {
      const page2 = await app2.firstWindow()
      await page2.waitForLoadState('domcontentloaded')
      await waitBooted(page2)

      const row = wsRows(page2, REMOTE_WS_NAME).first()
      await expect(row).toBeVisible({ timeout: 30_000 })
      await expect(row).not.toHaveClass(/\bcold\b/, {
        timeout: IDLE_20S_HEARTBEAT_ROUND_TIMEOUT_MS
      })
      await expect(page2.locator('.term-island .term-wrap')).toHaveCount(0)

      await row.click()

      await expect
        .poll(() => sshCommands(env).filter((c) => /tabs\/[^"]+\.sh"?\s+attach/.test(c)).length, {
          timeout: 60_000
        })
        .toBeGreaterThanOrEqual(1)
      await expect(centerTerm(page2)).toBeVisible({ timeout: 30_000 })
      expect(processAlive(first.pid)).toBe(true)
      await page2.waitForTimeout(TMUX_ATTACH_SETTLE_MS)
      const starts = sshCommands(env).filter((c) => /tabs\/[^"]+\.sh"?\s+start/.test(c))
      expect(starts).toHaveLength(1)

      await runIn(page2, centerTerm(page2), TURN_LONGER_THAN_ONE_MIRROR_PULL)
      await expect(row).toHaveClass(/\bst-working\b/, { timeout: 60_000 })
      await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 90_000 })
    } finally {
      await quitAndClose(app2)
    }
  })

  test('E-RW-16: /exit after an attach drops the row from the working set', async ({ env }) => {
    test.setTimeout(300_000)
    const { app, page } = await launchWithRemote(env)
    let first!: ClaudeCall
    try {
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      ;[first] = await waitForCalls(env, 1)
      await page.waitForTimeout(LAYOUT_SAVE_DEBOUNCE_SETTLE_MS)
    } finally {
      await quitAndClose(app)
    }
    expect(layoutMembers(env)).toContain(first.sessionId)

    const app2 = await launchApp(env)
    try {
      const page2 = await app2.firstWindow()
      await page2.waitForLoadState('domcontentloaded')
      await waitBooted(page2)

      const row = wsRows(page2, REMOTE_WS_NAME).first()
      await expect(row).toBeVisible({ timeout: 30_000 })
      await expect(row).not.toHaveClass(/\bcold\b/, { timeout: 60_000 })
      await row.click()
      await expect
        .poll(() => sshCommands(env).filter((c) => /tabs\/[^"]+\.sh"?\s+attach/.test(c)).length, {
          timeout: 60_000
        })
        .toBeGreaterThanOrEqual(1)
      await expect(centerTerm(page2)).toBeVisible({ timeout: 30_000 })
      await page2.waitForTimeout(TMUX_ATTACH_SETTLE_MS)

      await runIn(page2, centerTerm(page2), '/exit')

      await expect.poll(() => processAlive(first.pid), { timeout: 60_000 }).toBe(false)
      await expect(wsRows(page2, REMOTE_WS_NAME)).toHaveCount(0, { timeout: 60_000 })
      await expect
        .poll(() => layoutMembers(env), { timeout: 30_000 })
        .not.toContain(first.sessionId)
    } finally {
      await quitAndClose(app2)
    }
  })
})
