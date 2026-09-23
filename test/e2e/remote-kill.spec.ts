import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, quitAndClose } from './helpers/app'
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
  waitForCalls,
  resumedId,
  readCalls,
  wsRows
} from './helpers/p1'

/**
 * Who ends the claude running on the other machine (retired case file §3.3:
 * E-RW-04..06, E-RW-11, E-RW-12).
 *
 * A remote session outlives the tab showing it — that is the whole point of running it
 * under tmux — so every way of ending one has to say so out loud over ssh. The oracle is
 * always two-sided: the `tmux kill-session` line in the fake ssh's log, AND the fake
 * claude's pid really being gone. Closing a tab must never LOOK like it ended a session
 * it could not reach.
 */

test.afterEach(({ env }) => killFakeRemote(env))

/** the tmux session name a remote session runs under: `k-<the id it started with>` */
function tmuxName(id: string): string {
  return `k-${id}`
}

/**
 * Send ⌘W to the selected session and get past the confirm if one comes up.
 *
 * A LOCAL waiting session closes with no question at all (keys.spec T-KEY-06); a remote
 * one raises "Close running session?" some of the time, which is a product divergence
 * reported separately — this helper deliberately does not pin either answer, because the
 * case below is about what reaches the machine, not about the dialog.
 */
async function closeTab(app: ElectronApplication, page: Page): Promise<void> {
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

// E-RW-04 — ⌘W. Closing the tab is closing the SESSION: tmux is told to end it and the
// claude over there really dies, leaving a cold row behind.
test('E-RW-04: ⌘W kills the remote tmux session and the row goes cold', async ({ env }) => {
  test.setTimeout(240_000)
  const { app, page } = await launchWithRemote(env)
  try {
    await addRemoteWorkspace(page, env)
    await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
    const [first] = await waitForCalls(env, 1)

    await closeTab(app, page)

    await expect.poll(() => killLines(env, first.sessionId).length, { timeout: 30_000 }).toBe(1)
    await expect.poll(() => processAlive(first.pid), { timeout: 15_000 }).toBe(false)
    await expect(wsRows(page, REMOTE_WS_NAME).first()).toHaveClass(/\bcold\b/, { timeout: 60_000 })
  } finally {
    await quitAndClose(app)
  }
})

// E-RW-05 — ⇧⌘R. The restart ends the remote session for real and starts a fresh one
// resuming the same conversation; `attach` would have found the old claude still there.
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
    // …and it came back ON THE MACHINE. Both halves matter: a restart that quietly runs a
    // LOCAL claude in a path that happens to exist here would satisfy the resume id alone.
    const starts = sshCommands(env).filter((c) => /tabs\/[^"]+\.sh"?\s+start/.test(c))
    expect(starts.length).toBeGreaterThanOrEqual(2)
    expect(relaunch.argv[relaunch.argv.indexOf('--settings') + 1]).toContain('/fake-ssh/machine/')
  } finally {
    await quitAndClose(app)
  }
})

// E-RW-06 — removing the workspace. The confirmation names the running session and then
// really ends it over there; the mirror stays on disk, so re-adding the machine later
// still lists the history.
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

// E-RW-11 — `/exit`. Claude ended itself; Koloft has nothing to kill and must not say it
// did (a stray kill line would mean Koloft races every clean exit). And the user said
// they were done, so the session leaves the working set exactly as a local /exit does —
// its SessionEnd arrives late, by mirror, after the pty is already gone.
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

// E-RW-12 — ⌘W with the machine unreachable. The tab closes (nothing local is stuck on a
// dead network), the kill is attempted and fails, and the row keeps saying "running",
// which is the truth: claude is still up over there.
test('E-RW-12: ⌘W with ssh down closes the tab but the row stays running', async ({ env }) => {
  test.setTimeout(240_000)
  const { app, page } = await launchWithRemote(env)
  try {
    await addRemoteWorkspace(page, env)
    await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
    const [first] = await waitForCalls(env, 1)

    breakConnection(env)
    await closeTab(app, page)

    // the kill was really sent, and really failed
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

    // claude is untouched, and the row does not pretend otherwise
    expect(processAlive(first.pid)).toBe(true)
    expect(liveTmuxSessions(env)).toContain(tmuxName(first.sessionId))
    await page.waitForTimeout(3000)
    await expect(wsRows(page, REMOTE_WS_NAME).first()).not.toHaveClass(/\bcold\b/)
    expect(readCalls(env)).toHaveLength(1)
  } finally {
    await quitAndClose(app)
  }
})

// E-RW-13 — an in-TUI `/clear` gives claude a new session id, and the tmux session over
// there is renamed to follow it. Everything downstream keys off that name: without the
// rename the heartbeat lists a session that is gone, and ⇧⌘R restarts nothing on the
// machine — it quietly launches a LOCAL claude in a path that happens to exist here.
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
    // the machine renamed its own tmux session — this is the whole fix, seen from outside
    await expect
      .poll(() => liveTmuxSessions(env), { timeout: 60_000 })
      .not.toContain(tmuxName(first.sessionId))
    const [live] = liveTmuxSessions(env)
    const cleared = live.replace(/^k-/, '')
    expect(cleared).not.toBe(first.sessionId)

    // the restart gate reads the transcript through the mirror, which trails by a beat
    await expect.poll(() => sshCommands(env).length, { timeout: 30_000 }).toBeGreaterThan(0)
    await page.waitForTimeout(4000)

    await centerTerm(page).click()
    await sendShortcut(app, 'shortcut:restart-session')

    await expect.poll(() => killLines(env, cleared).length, { timeout: 60_000 }).toBe(1)
    const calls = await waitForCalls(env, 2, 90_000)
    const relaunch = calls[calls.length - 1]
    expect(resumedId(relaunch)).toBe(cleared)
    // …and it came back ON THE MACHINE: every claude this spec started ran over there
    expect(readCalls(env).every((c) => c.cwd.includes('/fake-ssh/machine/'))).toBe(true)
    const starts = sshCommands(env).filter((c) => /tabs\/[^"]+\.sh"?\s+start/.test(c))
    expect(starts.length).toBeGreaterThanOrEqual(2)
  } finally {
    await quitAndClose(app)
  }
})
