import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, pendingAttention, quitAndClose } from './helpers/app'
import type { E2EEnv } from './helpers/env'
import {
  addRemoteWorkspace,
  breakConnection,
  killFakeRemote,
  launchWithRemote,
  liveTmuxSessions,
  REMOTE_WS_NAME,
  sshCalls,
  sshCommands
} from './helpers/remote'
import {
  centerTerm,
  openMenu,
  processAlive,
  runIn,
  sendShortcut,
  startSessionIn,
  termIds,
  waitForCalls,
  resumedId,
  readCalls,
  wsRows
} from './helpers/p1'

const MIRROR_PULL_SETTLE_MS = 4000
const WAITING_TO_IDLE_MS = 1000
const IDLE_TO_CLOSE_MS = 3000

test.afterEach(({ env }) => killFakeRemote(env))

function tmuxName(id: string): string {
  return `k-${id}`
}

async function closeTabPastAnyConfirm(app: ElectronApplication, page: Page): Promise<void> {
  await page.locator('.ws-tab.active').first().click()
  await sendShortcut(app, 'shortcut:close-tab')
  const confirm = page.locator('.modal', { hasText: 'Close running session?' })
  if (await confirm.isVisible({ timeout: 4000 }).catch(() => false)) {
    await confirm
      .locator('.btn-primary, button', { hasText: /^Close$/ })
      .first()
      .click()
  }
}

function killLines(env: E2EEnv, id: string): string[] {
  return sshCommands(env).filter((c) => c.includes(`kill-session -t ${tmuxName(id)}`))
}

test.describe('who ends the claude on the other machine: every way of ending a remote session says so over ssh', () => {
  test('E-RW-04: ⌘W kills the remote tmux session and the row goes cold', async ({ env }) => {
    test.setTimeout(240_000)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      const [first] = await waitForCalls(env, 1)

      await closeTabPastAnyConfirm(app, page)

      await expect.poll(() => killLines(env, first.sessionId).length, { timeout: 30_000 }).toBe(1)
      await expect.poll(() => processAlive(first.pid), { timeout: 15_000 }).toBe(false)
      await expect(wsRows(page, REMOTE_WS_NAME).first()).toHaveClass(/\bcold\b/, {
        timeout: 60_000
      })
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RW-05: ⇧⌘R kills the remote session, then starts a new one resuming the same id', async ({
    env
  }) => {
    test.setTimeout(300_000)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      const [first] = await waitForCalls(env, 1)

      await centerTerm(page).click()
      await sendShortcut(app, 'shortcut:restart-session')

      await expect.poll(() => killLines(env, first.sessionId).length, { timeout: 30_000 }).toBe(1)
      await expect.poll(() => processAlive(first.pid), { timeout: 15_000 }).toBe(false)

      const calls = await waitForCalls(env, 2, 90_000)
      const relaunch = calls[calls.length - 1]
      expect(resumedId(relaunch)).toBe(first.sessionId)
      const starts = sshCommands(env).filter((c) => /tabs\/[^"]+\.sh"?\s+start/.test(c))
      expect(starts.length).toBeGreaterThanOrEqual(2)
      expect(relaunch.argv[relaunch.argv.indexOf('--settings') + 1]).toContain('/fake-ssh/machine/')
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RW-06: removing a remote workspace kills its session and leaves the mirror behind', async ({
    env
  }) => {
    test.setTimeout(300_000)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      const [first] = await waitForCalls(env, 1)

      await openMenu(page, page.locator('.ws-head', { hasText: REMOTE_WS_NAME }))
      await page.locator('.menu .mi.danger', { hasText: 'Remove workspace' }).click()
      const modal = page.locator('.modal')
      await expect(modal).toBeVisible()
      await modal.locator('.btn-primary').first().click()

      await expect(page.locator('.ws-head', { hasText: REMOTE_WS_NAME })).toHaveCount(0, {
        timeout: 30_000
      })
      await expect.poll(() => killLines(env, first.sessionId).length, { timeout: 30_000 }).toBe(1)
      await expect.poll(() => processAlive(first.pid), { timeout: 15_000 }).toBe(false)

      expect(fs.existsSync(path.join(env.userData, 'remote', 'devbox'))).toBe(true)
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RW-11: /exit closes the tab and drops the row, with no kill sent', async ({ env }) => {
    test.setTimeout(240_000)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      const [first] = await waitForCalls(env, 1)

      await runIn(page, centerTerm(page), '/exit')

      await expect.poll(() => processAlive(first.pid), { timeout: 60_000 }).toBe(false)
      await expect(wsRows(page, REMOTE_WS_NAME)).toHaveCount(0, { timeout: 90_000 })
      expect(killLines(env, first.sessionId)).toEqual([])
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RW-12: ⌘W with ssh down closes the tab but the row stays running', async ({ env }) => {
    test.setTimeout(240_000)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      const [first] = await waitForCalls(env, 1)

      breakConnection(env)
      await closeTabPastAnyConfirm(app, page)

      await expect
        .poll(
          () =>
            sshCalls(env).filter(
              (c) =>
                c.phase === 'end' &&
                (c.argv[c.argv.length - 1] ?? '').includes(
                  `kill-session -t ${tmuxName(first.sessionId)}`
                )
            ).length,
          { timeout: 30_000 }
        )
        .toBeGreaterThanOrEqual(1)
      const kills = sshCalls(env).filter(
        (c) =>
          c.phase === 'end' &&
          (c.argv[c.argv.length - 1] ?? '').includes(`kill-session -t ${tmuxName(first.sessionId)}`)
      )
      expect(kills.every((k) => k.exit === 255)).toBe(true)

      expect(processAlive(first.pid)).toBe(true)
      expect(liveTmuxSessions(env)).toContain(tmuxName(first.sessionId))
      await page.waitForTimeout(3000)
      await expect(wsRows(page, REMOTE_WS_NAME).first()).not.toHaveClass(/\bcold\b/)
      expect(readCalls(env)).toHaveLength(1)
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RW-19: an idle remote session closes its own tab and sends no kill, so its tmux session keeps running', async ({
    env
  }) => {
    test.setTimeout(240_000)
    env.launchEnv.KOLOFT_IDLE_MS = String(WAITING_TO_IDLE_MS)
    env.launchEnv.KOLOFT_IDLE_CLOSE_MS = String(IDLE_TO_CLOSE_MS)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      const [first] = await waitForCalls(env, 1)
      const remoteRow = wsRows(page, REMOTE_WS_NAME).first()
      await expect(remoteRow).toHaveClass(/st-waiting|st-idle/, { timeout: 60_000 })
      await startSessionIn(page, 'ws-a')
      const localRow = wsRows(page, 'ws-a').first()
      await expect(localRow).toHaveClass(/st-waiting|st-idle/, { timeout: 30_000 })
      await remoteRow.click()
      await localRow.click()
      await expect.poll(() => pendingAttention(page), { timeout: 10_000 }).toHaveLength(0)
      expect(await termIds(page)).toHaveLength(2)

      await expect.poll(() => termIds(page), { timeout: 60_000 }).toHaveLength(1)
      await expect(remoteRow).not.toHaveClass(/\bcold\b/)
      expect(killLines(env, first.sessionId)).toEqual([])
      expect(liveTmuxSessions(env)).toContain(tmuxName(first.sessionId))
      expect(processAlive(first.pid)).toBe(true)
    } finally {
      await quitAndClose(app)
    }
  })

  test('E-RW-13: after /clear the tmux name follows the new id, and ⇧⌘R stays on the machine', async ({
    env
  }) => {
    test.setTimeout(300_000)
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      const [first] = await waitForCalls(env, 1)

      await runIn(page, centerTerm(page), '/clear')
      await expect
        .poll(() => liveTmuxSessions(env), { timeout: 60_000 })
        .not.toContain(tmuxName(first.sessionId))
      const [live] = liveTmuxSessions(env)
      const cleared = live.replace(/^k-/, '')
      expect(cleared).not.toBe(first.sessionId)

      await expect.poll(() => sshCommands(env).length, { timeout: 30_000 }).toBeGreaterThan(0)
      await page.waitForTimeout(MIRROR_PULL_SETTLE_MS)

      await centerTerm(page).click()
      await sendShortcut(app, 'shortcut:restart-session')

      await expect.poll(() => killLines(env, cleared).length, { timeout: 60_000 }).toBe(1)
      const calls = await waitForCalls(env, 2, 90_000)
      const relaunch = calls[calls.length - 1]
      expect(resumedId(relaunch)).toBe(cleared)
      expect(readCalls(env).every((c) => c.cwd.includes('/fake-ssh/machine/'))).toBe(true)
      const starts = sshCommands(env).filter((c) => /tabs\/[^"]+\.sh"?\s+start/.test(c))
      expect(starts.length).toBeGreaterThanOrEqual(2)
    } finally {
      await quitAndClose(app)
    }
  })
})
