import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import type { Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { seedSettings, type E2EEnv } from './helpers/env'
import { runGit, setupGitFixture } from './helpers/gitFixture'
import { centerTerm, chooseBackend, openWorktreeSession, waitBooted, wsRows } from './helpers/p1'

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
const REAL_CODEX = process.env.KOLOFT_SMOKE_CODEX ?? ''
const SIGNED_IN_CODEX_HOME = process.env.KOLOFT_SMOKE_CODEX_HOME ?? ''
const HAVE_REAL_CODEX =
  fs.existsSync(REAL_CODEX) && fs.existsSync(path.join(SIGNED_IN_CODEX_HOME, 'auth.json'))

const NO_RETRY_SINCE_EVERY_RUN_SPENDS_REAL_MONEY = 0
test.describe.configure({ retries: NO_RETRY_SINCE_EVERY_RUN_SPENDS_REAL_MONEY })

const WORKTREE = 'real-close'
const ASK_FOR_THE_CLOSE =
  'Run this shell command exactly once: koloft session close — then say only what it printed. Do nothing else.'
const A_REAL_MODEL_TURN_MS = 180_000
const PAST_CODEX_PASTE_BURST_THAT_SWALLOWS_AN_EARLY_ENTER_MS = 1_000
// CC§7
const AMBIENT_ENV_THAT_WOULD_BYPASS_THE_ACCOUNT = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL'
]

function sidestepTheUnwatchedMissingProjectsFolderOfIssue277(env: E2EEnv): void {
  fs.mkdirSync(path.join(env.home, '.claude', 'projects'), { recursive: true })
}

function useRealClaude(env: E2EEnv, trusted: string[]): void {
  const spot = path.join(env.fakeBin, 'claude')
  fs.rmSync(spot, { force: true })
  fs.symlinkSync(REAL_CLAUDE, spot)
  for (const k of AMBIENT_ENV_THAT_WOULD_BYPASS_THE_ACCOUNT) delete env.launchEnv[k]
  sidestepTheUnwatchedMissingProjectsFolderOfIssue277(env)
  // CC§9 CC§10
  fs.writeFileSync(
    path.join(env.home, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      bypassPermissionsModeAccepted: true,
      projects: Object.fromEntries(trusted.map((dir) => [dir, { hasTrustDialogAccepted: true }]))
    })
  )
  seedSettings(env, {
    multiAccount: true,
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

function useRealCodex(env: E2EEnv, trusted: string[]): void {
  const spot = path.join(env.fakeBin, 'codex')
  fs.symlinkSync(REAL_CODEX, spot)
  const home = path.join(env.home, '.codex')
  fs.mkdirSync(home, { recursive: true })
  fs.copyFileSync(path.join(SIGNED_IN_CODEX_HOME, 'auth.json'), path.join(home, 'auth.json'))
  // CODEX§11
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    trusted.map((dir) => `[projects.${JSON.stringify(dir)}]\ntrust_level = "trusted"\n`).join('\n')
  )
  env.launchEnv.KOLOFT_CODEX_CMD = spot
  env.launchEnv.CODEX_HOME = home
}

function screen(page: Page): Promise<string> {
  return page.locator('.term-island .term-wrap:visible').innerText()
}

const ENTERS_BEFORE_GIVING_UP = 3
const A_TAKEN_PROMPT_STARTS_WORKING_WITHIN_MS = 10_000

async function ask(page: Page, row: Locator, text: string): Promise<void> {
  await centerTerm(page).click()
  await page.keyboard.type(text)
  for (let i = 0; i < ENTERS_BEFORE_GIVING_UP; i++) {
    await page.waitForTimeout(PAST_CODEX_PASTE_BURST_THAT_SWALLOWS_AN_EARLY_ENTER_MS)
    await page.keyboard.press('Enter')
    const working = await expect(row)
      .toHaveClass(/\bst-working\b/, { timeout: A_TAKEN_PROMPT_STARTS_WORKING_WITHIN_MS })
      .then(() => true)
      .catch(() => false)
    if (working) return
  }
  throw new Error(`the session never started on the prompt after ${ENTERS_BEFORE_GIVING_UP} Enters`)
}

interface RealWorktreeSession {
  page: Page
  rows: Locator
  repo: string
  tree: string
}

async function inARealWorktreeSession(
  env: E2EEnv,
  backend: 'default' | 'other',
  useReal: (env: E2EEnv, trusted: string[]) => void,
  alsoTrusted: string[],
  body: (s: RealWorktreeSession) => Promise<void>
): Promise<void> {
  const fx = setupGitFixture(env)
  const tree = path.join(fx.clone, '.claude', 'worktrees', WORKTREE)
  useReal(env, [
    fx.clone,
    tree,
    ...alsoTrusted.map((name) => path.join(fx.clone, '.claude', 'worktrees', name))
  ])
  const app = await launchApp(env)
  const page = await app.firstWindow()
  try {
    await page.waitForLoadState('domcontentloaded')
    await waitBooted(page)
    const dlg = await openWorktreeSession(page, 'repo')
    await dlg.locator('input').fill(WORKTREE)
    await chooseBackend(page, backend)
    const rows = wsRows(page, 'repo')
    await expect(rows).toHaveCount(1, { timeout: 60_000 })
    await expect(rows).toHaveClass(/\bst-(waiting|idle)\b/, { timeout: 90_000 })
    expect(fs.existsSync(tree)).toBe(true)
    await body({ page, rows, repo: fx.clone, tree })
  } catch (e) {
    await keepWhatTheAgentSawAndDid(page, env)
    throw e
  } finally {
    await quitAndClose(app)
  }
}

function refusedThenClosedForGood(
  env: E2EEnv,
  backend: 'default' | 'other',
  useReal: (env: E2EEnv, trusted: string[]) => void
): Promise<void> {
  test.setTimeout(2 * A_REAL_MODEL_TURN_MS + 120_000)
  return inARealWorktreeSession(env, backend, useReal, [], async ({ page, rows, repo, tree }) => {
    fs.writeFileSync(path.join(tree, 'left-behind.txt'), 'not committed')
    await ask(page, rows, ASK_FOR_THE_CLOSE)
    await expect
      .poll(() => screen(page), { timeout: A_REAL_MODEL_TURN_MS })
      .toContain('nothing was closed')
    await expect(rows).toHaveClass(/\bst-(waiting|idle)\b/, { timeout: A_REAL_MODEL_TURN_MS })
    expect(fs.existsSync(tree)).toBe(true)

    fs.rmSync(path.join(tree, 'left-behind.txt'))
    await ask(page, rows, ASK_FOR_THE_CLOSE)
    await expect(rows).toHaveCount(0, { timeout: A_REAL_MODEL_TURN_MS })
    await expect.poll(() => fs.existsSync(tree), { timeout: 30_000 }).toBe(false)
    expect(runGit(repo, 'branch', '--list', `worktree-${WORKTREE}`).trim()).toBe('')
  })
}

const CHILD = 'kid'
const START_A_CHILD_THEN_CLOSE_IT = {
  default: `Run these shell commands one after another, each exactly once: koloft session new -w ${CHILD} --name ${CHILD} -- "Reply with the single word ok." — then sleep 20 — then koloft session close ${CHILD}. Then say only what the last command printed. Do nothing else.`,
  other: `Run this shell command exactly once: koloft session new -w ${CHILD} -- "Reply with the single word ok." It prints a tab id. Then run sleep 20, then run koloft session close with that tab id. Then say only what the last command printed. Do nothing else.`
}

function closesTheSessionItStarted(
  env: E2EEnv,
  backend: 'default' | 'other',
  useReal: (env: E2EEnv, trusted: string[]) => void
): Promise<void> {
  test.setTimeout(A_REAL_MODEL_TURN_MS + 180_000)
  return inARealWorktreeSession(
    env,
    backend,
    useReal,
    [CHILD],
    async ({ page, rows, repo, tree }) => {
      const parentTabId = await rows.getAttribute('data-tab-id')
      const childTree = path.join(repo, '.claude', 'worktrees', CHILD)
      await ask(page, rows, START_A_CHILD_THEN_CLOSE_IT[backend])
      await expect(rows).toHaveCount(2, { timeout: A_REAL_MODEL_TURN_MS })
      await expect.poll(() => fs.existsSync(childTree), { timeout: 60_000 }).toBe(true)
      await expect(rows).toHaveCount(1, { timeout: A_REAL_MODEL_TURN_MS })
      await expect(rows).toHaveAttribute('data-tab-id', parentTabId!)
      await expect.poll(() => fs.existsSync(childTree), { timeout: 30_000 }).toBe(false)
      expect(runGit(repo, 'branch', '--list', `worktree-${CHILD}`).trim()).toBe('')
      expect(fs.existsSync(tree)).toBe(true)
    }
  )
}

async function keepWhatTheAgentSawAndDid(page: Page, env: E2EEnv): Promise<void> {
  await test.info().attach('terminal-screen', {
    body: await screen(page).catch(() => '(no terminal)'),
    contentType: 'text/plain'
  })
  const projects = path.join(env.home, '.claude', 'projects')
  if (!fs.existsSync(projects)) return
  for (const slug of fs.readdirSync(projects))
    for (const f of fs.readdirSync(path.join(projects, slug)).filter((n) => n.endsWith('.jsonl')))
      await test.info().attach(f, { path: path.join(projects, slug, f) })
}

test.describe('`koloft session close` from a REAL agent in a worktree: opt-in cases proving the real claude and codex reach the command; they spend real money', () => {
  test('a real Claude Code starts a child session in a worktree, then closes it for good while it stays open itself', async ({
    env
  }) => {
    test.skip(
      !HAVE_REAL_CLAUDE,
      'set KOLOFT_SMOKE_CLAUDE (absolute path of a real claude binary) and KOLOFT_SMOKE_OAUTH_TOKEN or KOLOFT_SMOKE_ACCOUNT (a Settings ▸ Accounts name, read off the Keychain)'
    )
    await closesTheSessionItStarted(env, 'default', useRealClaude)
  })

  test('a real Codex starts a child session in a worktree, then closes it for good while it stays open itself', async ({
    env
  }) => {
    test.skip(
      !HAVE_REAL_CODEX,
      'set KOLOFT_SMOKE_CODEX (absolute path of a real codex binary) and KOLOFT_SMOKE_CODEX_HOME (a signed-in CODEX_HOME; only its auth.json is copied)'
    )
    await closesTheSessionItStarted(env, 'other', useRealCodex)
  })

  test('a real Claude Code is refused while its worktree holds a new file, then closes itself for good: tab, row, worktree and branch', async ({
    env
  }) => {
    test.skip(
      !HAVE_REAL_CLAUDE,
      'set KOLOFT_SMOKE_CLAUDE (absolute path of a real claude binary) and KOLOFT_SMOKE_OAUTH_TOKEN or KOLOFT_SMOKE_ACCOUNT (a Settings ▸ Accounts name, read off the Keychain)'
    )
    await refusedThenClosedForGood(env, 'default', useRealClaude)
  })

  test('a real Codex is refused while its worktree holds a new file, then closes itself for good: tab, row, worktree and branch', async ({
    env
  }) => {
    test.skip(
      !HAVE_REAL_CODEX,
      'set KOLOFT_SMOKE_CODEX (absolute path of a real codex binary) and KOLOFT_SMOKE_CODEX_HOME (a signed-in CODEX_HOME; only its auth.json is copied)'
    )
    await refusedThenClosedForGood(env, 'other', useRealCodex)
  })
})
