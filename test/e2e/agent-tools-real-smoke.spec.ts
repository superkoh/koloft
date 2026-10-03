import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import type { Page } from '@playwright/test'
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

function useRealClaude(env: E2EEnv, trusted: string[]): void {
  const spot = path.join(env.fakeBin, 'claude')
  fs.rmSync(spot, { force: true })
  fs.symlinkSync(REAL_CLAUDE, spot)
  for (const k of AMBIENT_ENV_THAT_WOULD_BYPASS_THE_ACCOUNT) delete env.launchEnv[k]
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

async function ask(page: Page, text: string): Promise<void> {
  await centerTerm(page).click()
  await page.keyboard.type(text)
  await page.waitForTimeout(PAST_CODEX_PASTE_BURST_THAT_SWALLOWS_AN_EARLY_ENTER_MS)
  await page.keyboard.press('Enter')
}

async function refusedThenClosedForGood(
  env: E2EEnv,
  backend: 'default' | 'other',
  useReal: (env: E2EEnv, trusted: string[]) => void
): Promise<void> {
  test.setTimeout(2 * A_REAL_MODEL_TURN_MS + 120_000)
  const fx = setupGitFixture(env)
  const tree = path.join(fx.clone, '.claude', 'worktrees', WORKTREE)
  useReal(env, [fx.clone, tree])
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

    fs.writeFileSync(path.join(tree, 'left-behind.txt'), 'not committed')
    await ask(page, ASK_FOR_THE_CLOSE)
    await expect
      .poll(() => screen(page), { timeout: A_REAL_MODEL_TURN_MS })
      .toContain('nothing was closed')
    await expect(rows).toHaveClass(/\bst-(waiting|idle)\b/, { timeout: A_REAL_MODEL_TURN_MS })
    expect(fs.existsSync(tree)).toBe(true)

    fs.rmSync(path.join(tree, 'left-behind.txt'))
    await ask(page, ASK_FOR_THE_CLOSE)
    await expect(rows).toHaveCount(0, { timeout: A_REAL_MODEL_TURN_MS })
    await expect.poll(() => fs.existsSync(tree), { timeout: 30_000 }).toBe(false)
    expect(runGit(fx.clone, 'branch', '--list', `worktree-${WORKTREE}`).trim()).toBe('')
  } catch (e) {
    await test.info().attach('terminal-screen', {
      body: await screen(page).catch(() => '(no terminal)'),
      contentType: 'text/plain'
    })
    throw e
  } finally {
    await quitAndClose(app)
  }
}

test.describe('`koloft session close` from a REAL agent in a worktree: opt-in cases proving the real claude and codex reach the command; they spend real money', () => {
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
