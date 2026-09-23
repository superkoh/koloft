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

/**
 * ⇧⌘R must not kill a session it cannot resume.
 *
 * Claude Code creates a session's transcript jsonl LAZILY, at the first user message,
 * while the SessionStart hook reports its path the moment the session binds. So a
 * session that bound and was never typed into has an id, a path, and nothing on disk.
 * ⇧⌘R used to kill that perfectly healthy claude and then hand `claude --resume <id>`
 * an id with no conversation behind it: the session was destroyed and the user got an
 * error tab. The restart now asks main for the disk truth BEFORE the kill, and a "no"
 * is a full no-op with a toast.
 *
 * Case ids are the black-box cases of
 * (retired after
 * the feature merged; the CC lazy-write facts the gate rests on now live in
 * docs/claude-code-contract.md §2).
 * The five cases that pin unchanged behavior (BB-M02, BB-C01, BB-C09, BB-C10 and the
 * shell-alive half of BB-C08) are the contract of restart-session.spec.ts (T3, T10,
 * T13, T12, T16) and are not duplicated here — except BB-M02's "no toast" clause,
 * which is younger than T3 and is pinned below instead (BB-N01's second press asserts
 * zero toasts on a successful restart). BB-C02 and BB-C08's dead-tab shapes retired
 * with the frozen tab itself: a dead session closes its tab and is a cold row, whose
 * resume is the sidebar's (T-LIFE-05/06), so there is no dead tab to press ⇧⌘R on.
 * BB-C07 is the real-claude manual round and has no automated form.
 *
 * The never-conversed state is produced by the fake claude's lazy sentinel
 * (`env.claudeLazyFile`, helpers/env.ts): it binds for real and writes no transcript,
 * exactly as the real thing does between SessionStart and the first prompt.
 */

const WS_A = 'ws-a'

/** FR-02 / FR-07 — user-confirmed copy, spelled out because it IS the contract. */
const LIVE_TOAST = 'Nothing to restart yet — this session has no conversation.'

async function launch(env: E2EEnv): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('.ws-head')).toHaveCount(2, { timeout: 20_000 })
  await waitBooted(page)
  return { app, page }
}

/** ⇧⌘R through its application-menu item — the same code path as the accelerator. */
async function restart(app: ElectronApplication, page: Page): Promise<void> {
  await clickAppMenuItem(app, page, 'restart-session')
}

/** Where this session's conversation would live if it had one. */
function transcriptOf(env: E2EEnv, workspace: string, sessionId: string): string {
  return path.join(env.home, '.claude', 'projects', encodeCwd(workspace), sessionId + '.jsonl')
}

/** Start a session that has BOUND but written nothing — the state this file is about. */
async function startSilentSession(
  page: Page,
  env: E2EEnv
): Promise<{ sessionId: string; pid: number }> {
  fs.writeFileSync(env.claudeLazyFile, '1')
  await startSessionIn(page, WS_A)
  const [call] = await waitForCalls(env, 1)
  const transcript = transcriptOf(env, env.workspaces.a, call.sessionId)
  // the premise of every case below — assert it rather than trust the fixture
  expect(fs.existsSync(transcript), `${transcript} should not exist yet`).toBe(false)
  return { sessionId: call.sessionId, pid: call.pid }
}

/** Start a session that HAS a conversation (the fake claude's startup turn writes one). */
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

// ---------------------------------------------------------------------------------
// Main flow
// ---------------------------------------------------------------------------------

// BB-M01 (P0) — the issue itself. Everything the press must NOT do is asserted from
// outside the app: the claude process is still running under its original pid, the
// launch log records no second claude, and the pty behind the tab is the same one.
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
    // the session survived: same process, and no second claude was ever launched
    expect(processAlive(pid)).toBe(true)
    expect(readCalls(env)).toHaveLength(1)
    await expect(page.locator('.term-island .term-wrap')).toHaveCount(1)
    await expect(rows).toHaveCount(1)
    await expect(rows.first()).not.toHaveClass(/\bcold\b/)
    // a restart would have printed a second bind banner into a fresh terminal
    const after = await page.evaluate(
      () =>
        document.querySelector('.term-island .term-wrap:not([style*="none"])')?.textContent ?? ''
    )
    expect(after).toBe(before)

    // …and the terminal still answers input, on that same claude. `/scratch` is
    // transcript-silent, so the session stays in its never-conversed state.
    await runIn(page, centerTerm(page), '/scratch gate-probe')
    await expect(page.locator('.term-island .term-wrap:visible')).toContainText(
      'scratched gate-probe',
      { timeout: 20_000 }
    )
  } finally {
    await app.close().catch(() => {})
  }
})

// ---------------------------------------------------------------------------------
// Corner cases
// ---------------------------------------------------------------------------------

// BB-C03 + BB-C11 — the transcript deleted out from under a LIVE conversed session
// (§Edge Cases #6). `claude --resume` would fail just as surely here, so the gate has to
// refuse from the tracker's own entry instead of trusting the path it still holds. The
// same press is also where BB-C11 observes the toast taking itself down again.
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
    expect(processAlive(pid)).toBe(true) // left running, untouched
    expect(readCalls(env)).toHaveLength(1)
    await runIn(page, centerTerm(page), '/scratch still-alive')
    await expect(page.locator('.term-island .term-wrap:visible')).toContainText(
      'scratched still-alive',
      { timeout: 20_000 }
    )

    // BB-C11: nothing is clicked, nothing is pressed — the notice goes on its own
    await expect(page.locator('.toast')).toHaveCount(0, { timeout: 20_000 })
  } finally {
    await app.close().catch(() => {})
  }
})

// BB-C04 / BB-C05 / BB-C12 — the probe's own contract on input it can make no sense of.
// It is the gate's only source of truth, so it must ANSWER (false) rather than reject:
// a rejection routes the renderer through its fail-safe by accident instead of by
// contract, and the two are not the same state. One app launch covers all three.
test('BB-C04/C05/C12: the probe resolves false — never rejects — for empty, unknown and non-string ids', async ({
  page
}) => {
  test.setTimeout(120_000)
  await waitBooted(page)

  // BB-C04: the empty id — a session is registered with sessionId '' before its hook binds
  expect(await page.evaluate(() => window.api.sessions.transcriptExists(''))).toBe(false)

  // BB-C05: a well-formed id no session ever carried
  expect(
    await page.evaluate(() =>
      window.api.sessions.transcriptExists('9f2c1d84-77aa-4b31-9d0e-5c6b8a4e1f77')
    )
  ).toBe(false)

  // BB-C12: values the type system forbids but a bad caller can still send
  expect(
    await page.evaluate(async () => {
      const probe = window.api.sessions.transcriptExists as (id: unknown) => Promise<boolean>
      return Promise.all([probe(null), probe(undefined), probe(42)])
    })
  ).toEqual([false, false, false])
})

// BB-C06 — the probe follows the DISK, not a cached snapshot: the same session answers
// false before its first message and true after it. That flip is the whole gate.
test('BB-C06: the probe tracks disk truth across a session first message', async ({ env }) => {
  test.setTimeout(180_000)
  gitInit(env.workspaces.a)
  const { app, page } = await launch(env)
  try {
    const { sessionId } = await startSilentSession(page, env)
    // read the id back off the public bridge too — the probe must agree with what the
    // app itself reports as this session's identity
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

// ---------------------------------------------------------------------------------
// Non-functional
// ---------------------------------------------------------------------------------

// BB-N01 — a refusal is not a dead shortcut. The session it declined to restart is still
// fully usable, and the very first thing the user says makes the restart work: the gate
// holds no lock and remembers no verdict.
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
    await expect(page.locator('.toast')).toHaveCount(0, { timeout: 20_000 }) // a clean slate

    await runIn(page, centerTerm(page), 'now we have talked')
    await expect(page.locator('.term-island .term-wrap:visible')).toContainText(
      'handled: now we have talked',
      { timeout: 30_000 }
    )

    await restart(app, page)

    const calls = await waitForCalls(env, 2)
    expect(resumedId(calls[1])).toBe(sessionId)
    await expect.poll(() => processAlive(pid), { timeout: 30_000 }).toBe(false) // the old one went
    await expect(page.locator('.term-island .term-wrap')).toHaveCount(1)
    await expect(page.locator('.toast')).toHaveCount(0)
  } finally {
    await app.close().catch(() => {})
  }
})
