import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { installCodex, seedSettings, type E2EEnv } from './helpers/env'
import { codexCalls, codexRows } from './helpers/codex'
import {
  centerTerm,
  clickAppMenuItem,
  encodeCwd,
  gitInit,
  newSessionInWith,
  processAlive,
  readCalls,
  resumedId,
  runIn,
  startSessionIn,
  termIds,
  waitBooted,
  waitForCalls,
  waitTerminalQuiet,
  wsRows
} from './helpers/p1'

const WS_A = 'ws-a'

const LIVE_TOAST = 'Nothing to restart yet — this session has no conversation.'

function claudeTokenFromKeychain(): string {
  const account = process.env.KOLOFT_SMOKE_ACCOUNT
  if (!account) return ''
  const service = process.env.KOLOFT_SMOKE_KEYCHAIN_SERVICE ?? 'koloft-claude-oauth'
  try {
    return execFileSync('security', ['find-generic-password', '-s', service, '-a', account, '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).replace(/\n$/, '')
  } catch {
    return ''
  }
}

const REAL_CLAUDE = process.env.KOLOFT_SMOKE_CLAUDE ?? ''
const CLAUDE_TOKEN = process.env.KOLOFT_SMOKE_OAUTH_TOKEN || claudeTokenFromKeychain()
const HAVE_REAL_CLAUDE = fs.existsSync(REAL_CLAUDE) && !!CLAUDE_TOKEN
const NEEDS_REAL_CLAUDE =
  'set KOLOFT_SMOKE_CLAUDE (absolute path of a real claude binary) and KOLOFT_SMOKE_OAUTH_TOKEN or KOLOFT_SMOKE_ACCOUNT (a Settings ▸ Accounts name, read off the Keychain)'
const A_REAL_MODEL_TURN_MS = 180_000
const NO_RETRY_SINCE_EVERY_RUN_SPENDS_REAL_MONEY = 0
// CC§7
const AMBIENT_ENV_THAT_WOULD_BYPASS_THE_ACCOUNT = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL'
]

function useRealClaude(env: E2EEnv): void {
  const spot = path.join(env.fakeBin, 'claude')
  fs.rmSync(spot, { force: true })
  fs.symlinkSync(REAL_CLAUDE, spot)
  for (const k of AMBIENT_ENV_THAT_WOULD_BYPASS_THE_ACCOUNT) delete env.launchEnv[k]
  fs.mkdirSync(path.join(env.home, '.claude', 'projects'), { recursive: true })
  // CC§9 CC§10
  fs.writeFileSync(
    path.join(env.home, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      bypassPermissionsModeAccepted: true,
      projects: { [env.workspaces.a]: { hasTrustDialogAccepted: true } }
    })
  )
  seedSettings(env, {
    skipPermissions: true,
    accounts: [
      { name: 'alpha', kind: 'oauth', enabled: true, fable: 'unknown', status: 'ok', addedAt: 1 }
    ]
  })
  fs.writeFileSync(
    env.keychainFile,
    JSON.stringify({ 'koloft-dev-claude-oauth': { alpha: CLAUDE_TOKEN } })
  )
}

// CC§11
async function registeredIn(
  env: E2EEnv,
  cwd: string,
  notPid?: number
): Promise<{ pid: number; sessionId: string }> {
  const dir = path.join(env.home, '.claude', 'sessions')
  const want = fs.realpathSync(cwd)
  const find = (): { pid: number; sessionId: string } | undefined => {
    if (!fs.existsSync(dir)) return undefined
    for (const f of fs.readdirSync(dir).filter((n) => /^\d+\.json$/.test(n))) {
      try {
        const e = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))
        if (e.pid !== notPid && fs.realpathSync(e.cwd) === want && processAlive(e.pid)) return e
      } catch {}
    }
    return undefined
  }
  await expect.poll(() => find() !== undefined, { timeout: 60_000 }).toBe(true)
  return find()!
}

const ENTERS_BEFORE_GIVING_UP = 3
const A_TAKEN_PROMPT_STARTS_WORKING_WITHIN_MS = 10_000
const PAST_THE_PASTE_BURST_THAT_SWALLOWS_AN_EARLY_ENTER_MS = 1_000

async function askReal(page: Page, row: Locator, text: string): Promise<void> {
  await centerTerm(page).click()
  await page.keyboard.type(text)
  for (let i = 0; i < ENTERS_BEFORE_GIVING_UP; i++) {
    await page.waitForTimeout(PAST_THE_PASTE_BURST_THAT_SWALLOWS_AN_EARLY_ENTER_MS)
    await page.keyboard.press('Enter')
    const working = await expect(row)
      .toHaveClass(/\bst-working\b/, { timeout: A_TAKEN_PROMPT_STARTS_WORKING_WITHIN_MS })
      .then(() => true)
      .catch(() => false)
    if (working) return
  }
  throw new Error(`the session never started on the prompt after ${ENTERS_BEFORE_GIVING_UP} Enters`)
}

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
      const tabs = await termIds(page)
      expect(tabs).toHaveLength(1)
      await waitTerminalQuiet(page, tabs[0])
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

  test('a Codex thread with no turn yet is gated the same way: ⇧⌘R is a no-op with the toast, and its first turn unlocks a restart that resumes the same thread', async ({
    env
  }) => {
    test.setTimeout(240_000)
    installCodex(env)
    fs.writeFileSync(path.join(env.home, 'fake-codex-lazy'), '')
    const { app, page } = await launch(env)
    try {
      await newSessionInWith(page, WS_A, 'Codex')
      await expect.poll(() => codexCalls(env).length).toBe(1)
      const [first] = codexCalls(env)
      const row = codexRows(page)
      await expect(row).toHaveClass(/\bst-(waiting|idle)\b/)
      await expect(page.locator('.term-island .term-wrap:visible')).toContainText(
        `Codex fixture ready ${first.sessionId}`
      )

      await restart(app, page)
      await expect(page.locator('.toast-msg')).toHaveText(LIVE_TOAST, { timeout: 20_000 })
      expect(processAlive(first.pid)).toBe(true)
      expect(codexCalls(env)).toHaveLength(1)
      await expect(page.locator('.toast')).toHaveCount(0, { timeout: 20_000 })

      await runIn(page, centerTerm(page), 'now we have talked')
      await expect(page.locator('.term-island .term-wrap:visible')).toContainText('Codex done', {
        timeout: 30_000
      })

      await restart(app, page)
      await expect.poll(() => codexCalls(env).length, { timeout: 30_000 }).toBe(2)
      expect(codexCalls(env)[1]).toMatchObject({
        method: 'thread/resume',
        sessionId: first.sessionId
      })
      await expect.poll(() => processAlive(first.pid), { timeout: 30_000 }).toBe(false)
      await expect(page.locator('.term-island .term-wrap')).toHaveCount(1)
      await expect(row).toHaveCount(1)
    } finally {
      await quitAndClose(app)
    }
  })
})

test.describe('the ⇧⌘R transcript gate against the REAL claude: opt-in, it spends real money', () => {
  test.describe.configure({ retries: NO_RETRY_SINCE_EVERY_RUN_SPENDS_REAL_MONEY })

  test('BB-C07: against the real claude, ⇧⌘R before the first prompt is a no-op with a toast, and after one real turn it resumes the same conversation in its one row', async ({
    env
  }) => {
    test.skip(!HAVE_REAL_CLAUDE, NEEDS_REAL_CLAUDE)
    test.setTimeout(A_REAL_MODEL_TURN_MS + 180_000)
    gitInit(env.workspaces.a)
    useRealClaude(env)
    const { app, page } = await launch(env)
    try {
      await startSessionIn(page, WS_A)
      const live = await registeredIn(env, env.workspaces.a)
      // CC§2
      expect(fs.existsSync(transcriptOf(env, env.workspaces.a, live.sessionId))).toBe(false)
      const tabs = await termIds(page)

      await restart(app, page)
      await expect(page.locator('.toast-msg')).toHaveText(LIVE_TOAST, { timeout: 20_000 })
      expect(processAlive(live.pid)).toBe(true)
      expect(await termIds(page)).toEqual(tabs)

      const row = wsRows(page, WS_A).first()
      await askReal(page, row, 'Say exactly: koloft-gate-ok')
      await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: A_REAL_MODEL_TURN_MS })
      await expect
        .poll(() => fs.existsSync(transcriptOf(env, env.workspaces.a, live.sessionId)))
        .toBe(true)

      await restart(app, page)
      await expect.poll(() => processAlive(live.pid), { timeout: 30_000 }).toBe(false)
      const resumed = await registeredIn(env, env.workspaces.a, live.pid)
      expect(resumed.sessionId).toBe(live.sessionId)
      await expect(page.locator('.term-island .term-wrap')).toHaveCount(1)
      await expect(wsRows(page, WS_A)).toHaveCount(1)
    } finally {
      await app.close().catch(() => {})
    }
  })
})
