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

/**
 * Losing and regaining the machine (retired case file §3.4: E-RW-07, E-RW-08).
 *
 * The rule both cases share: Koloft never invents an ending. A heartbeat that cannot
 * reach the machine says nothing about the session, and quitting Koloft says nothing
 * either — the session runs under tmux and is still there afterwards, waiting to be
 * attached.
 */

test.afterEach(({ env }) => killFakeRemote(env))

/** The working set as it stands on disk: layout.json's `sessions` keys. */
function layoutSessionIds(env: E2EEnv): string[] {
  const file = path.join(env.userData, 'layout.json')
  const layout = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    sessions: Record<string, unknown>
  }
  return Object.keys(layout.sessions)
}

// E-RW-07 — the lid closes, the wifi drops. Several heartbeats in a row fail; the row
// must not cool and the tab must not close, because nothing has actually ended.
test('E-RW-07: heartbeats failing does not cool a remote row or close its tab', async ({ env }) => {
  test.setTimeout(240_000)
  const { app, page } = await launchWithRemote(env)
  try {
    await addRemoteWorkspace(page, env)
    await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
    const [first] = await waitForCalls(env, 1)
    const row = wsRows(page, REMOTE_WS_NAME).first()

    breakConnection(env)
    // long enough for several beats of the 2 s heartbeat to come back 255
    await page.waitForTimeout(8000)

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

// E-RW-08 — quit Koloft, come back. The claude on the machine never stopped, so the
// heartbeat lists it and the row says "running" with no tab of its own; clicking it
// ATTACHES to that same tmux session rather than starting a second claude.
test('E-RW-08: after a Koloft restart the remote session is still running and clicking attaches', async ({
  env
}) => {
  test.setTimeout(300_000)
  const { app, page } = await launchWithRemote(env)
  let first!: ClaudeCall
  try {
    await addRemoteWorkspace(page, env)
    await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
    ;[first] = await waitForCalls(env, 1)
    await page.waitForTimeout(3000) // let the debounced layout save land
  } finally {
    await quitAndClose(app)
  }

  // the session survived the app that started it
  expect(processAlive(first.pid)).toBe(true)
  expect(liveTmuxSessions(env)).toContain(`k-${first.sessionId}`)

  const app2 = await launchApp(env)
  try {
    const page2 = await app2.firstWindow()
    await page2.waitForLoadState('domcontentloaded')
    await waitBooted(page2)

    const row = wsRows(page2, REMOTE_WS_NAME).first()
    await expect(row).toBeVisible({ timeout: 30_000 })
    // with no remote tab open the heartbeat runs every 20 s, so the first round that can
    // report this session alive may be a whole interval away
    await expect(row).not.toHaveClass(/\bcold\b/, { timeout: 60_000 })
    await expect(page2.locator('.term-island .term-wrap')).toHaveCount(0)

    await row.click()

    await expect
      .poll(() => sshCommands(env).filter((c) => /tabs\/[^"]+\.sh"?\s+attach/.test(c)).length, {
        timeout: 60_000
      })
      .toBeGreaterThanOrEqual(1)
    await expect(centerTerm(page2)).toBeVisible({ timeout: 30_000 })
    // attaching started no second claude, and the first one is still the live one
    expect(processAlive(first.pid)).toBe(true)
    await page2.waitForTimeout(2000)
    const starts = sshCommands(env).filter((c) => /tabs\/[^"]+\.sh"?\s+start/.test(c))
    expect(starts).toHaveLength(1)

    // …and the re-attached tab still hears its session. The claude over there reports
    // under the tab id it was STARTED with, which this run of Koloft has never seen;
    // only the tmux session name in the report ties it back to this tab (hooks.ts
    // `tmux`, index.ts liveTabFor). Without that, the row's dot never moves again.
    // `/busy` for the same reason E-RW-01 uses it: a short turn lands both hooks in
    // one mirror pull and the working half is never seen.
    await runIn(page2, centerTerm(page2), '/busy')
    await expect(row).toHaveClass(/\bst-working\b/, { timeout: 60_000 })
    await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 90_000 })
  } finally {
    await quitAndClose(app2)
  }
})

// E-RW-16 — `/exit` in an ATTACHED tab. The claude over there writes its SessionEnd
// under the id of the tab that STARTED it, which after a restart is a long-dead tab this
// run has never seen — so a drain that waits for `<this tab>.json` waits forever and the
// session never leaves the working set. Only the session id in the report ties it back.
test('E-RW-16: /exit after an attach drops the row from the working set', async ({ env }) => {
  test.setTimeout(300_000)
  const { app, page } = await launchWithRemote(env)
  let first!: ClaudeCall
  try {
    await addRemoteWorkspace(page, env)
    await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
    ;[first] = await waitForCalls(env, 1)
    await page.waitForTimeout(3000) // let the debounced layout save land
  } finally {
    await quitAndClose(app)
  }
  expect(layoutSessionIds(env)).toContain(first.sessionId)

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
    await page2.waitForTimeout(2000) // the tmux attach is still coming up

    await runIn(page2, centerTerm(page2), '/exit')

    await expect.poll(() => processAlive(first.pid), { timeout: 60_000 }).toBe(false)
    await expect(wsRows(page2, REMOTE_WS_NAME)).toHaveCount(0, { timeout: 60_000 })
    // …and it really left the working set on disk, not merely the sidebar
    await expect
      .poll(() => layoutSessionIds(env), { timeout: 30_000 })
      .not.toContain(first.sessionId)
  } finally {
    await quitAndClose(app2)
  }
})
