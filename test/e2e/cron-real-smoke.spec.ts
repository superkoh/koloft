import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import type { Locator, Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import { seedSettings, type E2EEnv } from './helpers/env'
import { encodeCwd, gitInit, openMenu, waitBooted, wsRows } from './helpers/p1'

function tokenFromKeychain(): string {
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
const TOKEN = process.env.KOLOFT_SMOKE_OAUTH_TOKEN || tokenFromKeychain()
const HAVE_REAL = !!REAL_CLAUDE && !!TOKEN && fs.existsSync(REAL_CLAUDE)

test.skip(
  !HAVE_REAL,
  'cron real smoke: set KOLOFT_SMOKE_CLAUDE (absolute path of a real claude binary) and either KOLOFT_SMOKE_OAUTH_TOKEN (an OAuth token) or KOLOFT_SMOKE_ACCOUNT (a Settings ▸ Accounts name, read off the Keychain) — it spends a few cents of real money'
)

const NO_RETRY_SINCE_EVERY_RUN_SPENDS_REAL_MONEY = 0
test.describe.configure({ retries: NO_RETRY_SINCE_EVERY_RUN_SPENDS_REAL_MONEY })

const AMBIENT_ENV_THAT_WOULD_BYPASS_THE_ACCOUNT_OR_THE_JOB_MODEL = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL'
]
const OTHER_MODEL_CHIP_NOT_THE_OTHER_SESSIONS_CHIP = /^Other…$/

const JOB = 'Smoke'
const TASK = 'Say exactly: koloft-smoke-ok'
const CHEAPEST_MODEL = 'claude-haiku-4-5-20251001'

function useRealClaudeBehindTheShim(env: E2EEnv): void {
  const spot = path.join(env.fakeBin, 'claude')
  fs.rmSync(spot, { force: true })
  fs.symlinkSync(REAL_CLAUDE, spot)
  // CC§7
  for (const k of AMBIENT_ENV_THAT_WOULD_BYPASS_THE_ACCOUNT_OR_THE_JOB_MODEL) {
    delete env.launchEnv[k]
  }
}

// CC§9 CC§10
function seedClaudeConfig(env: E2EEnv): void {
  fs.writeFileSync(
    path.join(env.home, '.claude.json'),
    JSON.stringify({
      hasCompletedOnboarding: true,
      bypassPermissionsModeAccepted: true,
      projects: { [env.workspaces.a]: { hasTrustDialogAccepted: true } }
    })
  )
}

interface Rec {
  type?: string
  customTitle?: string
  message?: { role?: string; model?: string; content?: unknown }
}

// CC§2
function transcripts(env: E2EEnv, worktree: string): string[] {
  const dirs = [path.join(env.workspaces.a, '.claude', 'worktrees', worktree), env.workspaces.a]
  const out: string[] = []
  for (const d of dirs) {
    const slug = path.join(env.home, '.claude', 'projects', encodeCwd(d))
    if (!fs.existsSync(slug)) continue
    for (const f of fs.readdirSync(slug)) {
      if (f.endsWith('.jsonl')) out.push(path.join(slug, f))
    }
  }
  return out
}

function completeRecords(file: string): Rec[] {
  let raw = ''
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return []
  }
  const out: Rec[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line) as Rec)
    } catch {}
  }
  return out
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as { type?: string; text?: string }[])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('')
}

function userTurns(file: string): string[] {
  return completeRecords(file)
    .filter((r) => r.type === 'user')
    .map((r) => textOf(r.message?.content))
}

function card(page: Page): Locator {
  return page.locator('.job-row').filter({ has: page.locator('.job-name', { hasText: JOB }) })
}

async function createSmokeJob(page: Page): Promise<void> {
  await openMenu(page, page.locator('.ws-head', { hasText: 'ws-a' }))
  await page.locator('.menu .mi', { hasText: 'Scheduled jobs' }).click()
  const dlg = page.locator('.modal.cronjobs')
  await expect(dlg).toBeVisible({ timeout: 15_000 })

  await dlg.locator('button.mini', { hasText: 'New job' }).click()
  await expect(dlg.locator('.fgrid')).toBeVisible()
  await dlg.locator('input[aria-label="Name"]').fill(JOB)
  await dlg.locator('[aria-label="What to run"]').fill(TASK)
  await dlg.locator('.chip', { hasText: 'Every day' }).click()
  await dlg.locator('input[aria-label="at"]').fill('21:00')
  await dlg.locator('.chip', { hasText: OTHER_MODEL_CHIP_NOT_THE_OTHER_SESSIONS_CHIP }).click()
  await dlg.locator('input[aria-label="Model name"]').fill(CHEAPEST_MODEL)
  await dlg.locator('.chip', { hasText: 'Never ask' }).click()
  await dlg.locator('.modal-foot .btn-primary').click()
  await expect(dlg.locator('.fgrid')).toHaveCount(0)
  await expect(card(page)).toHaveCount(1)
}

test.describe('Scheduled jobs on the REAL claude: the one opt-in case proving the launch line (--model, --name, the task after --) still works; one shot, it spends real money', () => {
  test('BB-R01: a scheduled job runs on the real claude — it binds, it finishes, and the transcript holds the task, the title and the model', async ({
    env
  }) => {
    test.setTimeout(300_000)
    gitInit(env.workspaces.a)
    useRealClaudeBehindTheShim(env)
    seedClaudeConfig(env)
    seedSettings(env, {
      multiAccount: true,
      skipPermissions: true,
      accounts: [
        { name: 'alpha', kind: 'oauth', enabled: true, fable: 'unknown', status: 'ok', addedAt: 1 }
      ]
    })
    fs.writeFileSync(
      env.keychainFile,
      JSON.stringify({ 'koloft-dev-claude-oauth': { alpha: TOKEN } })
    )

    const app = await launchApp(env)
    const page = await app.firstWindow()
    let worktree = ''
    try {
      await page.waitForLoadState('domcontentloaded')
      await waitBooted(page)

      await createSmokeJob(page)
      await card(page).locator('button.mini', { hasText: 'Run now' }).click()

      const row = wsRows(page, 'ws-a').filter({ has: page.locator('.ws-tab-cron') })
      await expect(row).toHaveCount(1, { timeout: 60_000 })
      await expect(row).toHaveClass(/\bst-(working|waiting)\b/, { timeout: 90_000 })
      const sub = row.locator('.ws-tab-sub')
      await expect(sub).toHaveText(/^smoke-/, { timeout: 30_000 })
      worktree = ((await sub.textContent()) ?? '').trim()

      await expect(card(page).locator('.job-last')).toContainText('done — waiting for you', {
        timeout: 120_000
      })

      await expect.poll(() => transcripts(env, worktree).length, { timeout: 30_000 }).toBe(1)
      const file = transcripts(env, worktree)[0]

      await expect.poll(() => userTurns(file)[0] ?? null, { timeout: 30_000 }).toBe(TASK)
      // CC§9
      expect(
        completeRecords(file).some((r) => r.type === 'custom-title' && r.customTitle === JOB)
      ).toBe(true)
      // CC§2
      await expect
        .poll(
          () =>
            completeRecords(file)
              .filter((r) => r.type === 'assistant')
              .map((r) => r.message?.model),
          { timeout: 30_000 }
        )
        .toContain(CHEAPEST_MODEL)
    } catch (e) {
      const screens = await page
        .locator('.terminals .term-wrap')
        .allInnerTexts()
        .catch(() => [] as string[])
      await test.info().attach('terminal-screens', {
        body: screens.join('\n\n────────\n\n'),
        contentType: 'text/plain'
      })
      const files = worktree ? transcripts(env, worktree) : []
      const shapes = files.map(
        (f) =>
          `${f}\n${completeRecords(f)
            .map((r) => `  ${r.type ?? '?'}${r.message?.model ? ' ' + r.message.model : ''}`)
            .join('\n')}`
      )
      await test.info().attach('transcripts', {
        body: shapes.join('\n\n') || '(no transcript found)',
        contentType: 'text/plain'
      })
      throw e
    } finally {
      await app.close().catch(() => {})
    }
  })
})
