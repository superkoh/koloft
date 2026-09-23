import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import type { Locator, Page } from '@playwright/test'
import { test, expect, launchApp } from './helpers/app'
import { seedSettings, type E2EEnv } from './helpers/env'
import { encodeCwd, gitInit, openMenu, waitBooted, wsRows } from './helpers/p1'

/**
 * Scheduled jobs against the REAL `claude` — the one case in the suite that is
 * not the fake.
 *
 * WHY IT EXISTS. Every other cron case drives `fixtures/fake-claude.js`, which reads
 * the launch line and believes it. So the whole suite would stay green if the launch
 * line the shim builds for a scheduled run — `--model <name>`, `--name <title>`, and
 * the task text after `--` (contract §9) — stopped meaning what it means to a real
 * build: a renamed flag, a `--` that is read as a flag again, a model alias the binary
 * rejects. This case is the only proof that line still works where it counts. It asserts
 * STRUCTURE only, never the model's words (canary rule, docs/claude-code-contract.md
 * intro): the run binds,
 * the card says the run finished, and the transcript claude itself wrote carries the
 * task text as the first user turn, the job name as the session title, and the asked-for
 * model on its assistant records.
 *
 * HOW TO RUN IT. Opt in with the binary plus ONE of two ways to the token — without
 * them, it skips:
 *
 *   KOLOFT_SMOKE_CLAUDE=/absolute/path/to/claude \
 *   KOLOFT_SMOKE_OAUTH_TOKEN=<oauth token> \
 *   npx playwright test cron-real-smoke
 *
 *   KOLOFT_SMOKE_CLAUDE=/absolute/path/to/claude \
 *   KOLOFT_SMOKE_ACCOUNT=<account name as shown in Settings ▸ Accounts> \
 *   npx playwright test cron-real-smoke
 *
 * The second form reads the token off this Mac's Keychain with the very call the product
 * makes (`security find-generic-password -s <service> -a <account> -w`, accounts.ts
 * keychainRead); the service defaults to the packaged app's `koloft-claude-oauth`, or
 * set KOLOFT_SMOKE_KEYCHAIN_SERVICE (the dev profile's is `koloft-dev-claude-oauth`).
 * macOS may ask once whether `security` may read the item. Either way the token lives
 * only in this process and the run's throwaway HOME, and is never printed. It spends
 * REAL money: one haiku turn of a few words, a few cents.
 *
 * IF IT STALLS, SUSPECT THE TRUST KEY. A directory claude has not seen before makes it
 * ask "Is this a project you created or one you trust?", and
 * `--dangerously-skip-permissions` does not skip that question (contract §9); `-w`
 * refuses outright there. Nothing can answer it here, so the run never binds and the
 * 90 s start deadline kills it — the failure is the first assertion below. The answer is
 * the `<home>/.claude.json` seed in `seedClaudeConfig`: `projects[<ws-a>]
 * .hasTrustDialogAccepted: true`, plus `hasCompletedOnboarding` so the first-run wizard
 * does not ask either. The key names come from the 2.1.263 binary's own error text
 * ("…or set projects[<path>].hasTrustDialogAccepted: true in ~/.claude.json", read with
 * `strings`,). A third one, `bypassPermissionsModeAccepted`, was found the
 * hard way on the first live run — see `seedClaudeConfig`.
 *
 * Case: BB-R01.
 */

/** The token off the Keychain, by account name — the product's own read. Empty when the
 *  account is not named, not there, or the read was refused. */
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

// A failing run costs money a second time, and the config's one retry would spend it
// without being asked. One shot.
test.describe.configure({ retries: 0 })

const JOB = 'Smoke'
const TASK = 'Say exactly: koloft-smoke-ok'
/** the cheapest model there is — the case is about the launch line, not about thinking */
const MODEL = 'claude-haiku-4-5-20251001'

/**
 * Point the run at the real binary.
 *
 * NOT `KOLOFT_CLAUDE_CMD`: that seam is the base command Koloft types into the login
 * shell, and an absolute path there would exec the real claude DIRECTLY — skipping the
 * shim, and with it the session registration, the account token, and the very
 * `--name` / `--` argv this case exists to check. The shim finds the real claude by
 * scanning PATH itself (`src/main/shim.ts`), and the suite owns that PATH: swapping the
 * fake `claude` in `fakeBin` for a link to the real one is the whole change, and every
 * line of Koloft the run touches stays production code.
 */
function useRealClaude(env: E2EEnv): void {
  const spot = path.join(env.fakeBin, 'claude')
  fs.rmSync(spot, { force: true })
  fs.symlinkSync(REAL_CLAUDE, spot)
  // An ambient key in the developer's own environment reaches the app through
  // `{...process.env}` and makes the shim skip balancing out loud ("auth token already
  // in env"), so the run would be billed to whatever that key is and the account path
  // this case seeds would never be walked. ANTHROPIC_MODEL goes for the same reason:
  // the model must come from the job's `--model`, not from the shell.
  for (const k of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_MODEL']) {
    delete env.launchEnv[k]
  }
}

/** The three questions a fresh $HOME would otherwise stall on: the first-run wizard, the
 *  "do you trust this folder" question (contract §9), and the one-time "Bypass
 *  Permissions mode" warning that `--dangerously-skip-permissions` shows until it has
 *  been accepted once — the run above seeds `skipPermissions`, so the shim adds that
 *  flag, and the first run here found that screen (2.1.263: the row sat at
 *  st-pending for the whole 90 s). All three key names are read off the binary. */
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

// ---- the transcript claude writes ----------------------------------------------------

interface Rec {
  type?: string
  customTitle?: string
  message?: { role?: string; model?: string; content?: unknown }
}

/** Every jsonl the run could have written. While a `-w` session is ALIVE its transcript
 *  sits in the worktree's slug and only the exit moves it to the root checkout's slug
 *  (contract §2) — but that placement is recorded there as the unreliable half of the
 *  contract, so both slugs are looked in and the case fails on the CONTENT instead. */
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

/** The file is being appended to while this reads it, so a half-written last line is
 *  ordinary and gets dropped rather than throwing. */
function records(file: string): Rec[] {
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
    } catch {
      /* the tail of a live file */
    }
  }
  return out
}

/** A user message is a plain string or a list of text blocks, depending on how it was
 *  submitted — both shapes read back as the same words. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as { type?: string; text?: string }[])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('')
}

function userTurns(file: string): string[] {
  return records(file)
    .filter((r) => r.type === 'user')
    .map((r) => textOf(r.message?.content))
}

// ---- the dialog ----------------------------------------------------------------------

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
  // the ellipsis matters: `hasText` is substring-and-case-insensitive, and a bare
  // 'Other' would also catch the permission chip "Same as my other sessions"
  await dlg.locator('.chip', { hasText: /^Other…$/ }).click()
  await dlg.locator('input[aria-label="Model name"]').fill(MODEL)
  await dlg.locator('.chip', { hasText: 'Never ask' }).click()
  await dlg.locator('.modal-foot .btn-primary').click()
  await expect(dlg.locator('.fgrid')).toHaveCount(0)
  await expect(card(page)).toHaveCount(1)
}

// ======================================================================================

// BB-R01 — one scheduled job, one real turn, driven by Run now (the same path a timed
// due walks, cron.spec.ts's header). The dialog stays open throughout: the card is where
// the run reports finishing, and the sidebar row's class is readable behind the modal.
test('BB-R01: a scheduled job runs on the real claude — it binds, it finishes, and the transcript holds the task, the title and the model', async ({
  env
}) => {
  test.setTimeout(300_000)
  gitInit(env.workspaces.a)
  useRealClaude(env)
  seedClaudeConfig(env)
  // the account balancer, exactly as BB-M12 sets it up — the shim reads the token out of
  // the keychain fixture and exports it as CLAUDE_CODE_OAUTH_TOKEN
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

    // ① it BOUND. A stalled trust question, a rejected flag or a refused `-w` all end
    // here: no SessionStart inside 90 s and main's start deadline kills the pty.
    const row = wsRows(page, 'ws-a').filter({ has: page.locator('.ws-tab-cron') })
    await expect(row).toHaveCount(1, { timeout: 60_000 })
    await expect(row).toHaveClass(/\bst-(working|waiting)\b/, { timeout: 90_000 })
    const sub = row.locator('.ws-tab-sub')
    await expect(sub).toHaveText(/^smoke-/, { timeout: 30_000 })
    worktree = ((await sub.textContent()) ?? '').trim()

    // ② it FINISHED — a real round-trip to the model and back to the Stop hook
    await expect(card(page).locator('.job-last')).toContainText('done — waiting for you', {
      timeout: 120_000
    })

    // ③ what claude wrote. One transcript, and it is this run's.
    await expect.poll(() => transcripts(env, worktree).length, { timeout: 30_000 }).toBe(1)
    const file = transcripts(env, worktree)[0]

    // the task text after `--` arrived as the session's first turn, byte for byte
    await expect.poll(() => userTurns(file)[0] ?? null, { timeout: 30_000 }).toBe(TASK)
    // `--name` became the session's title (contract §9: a `custom-title` record)
    expect(records(file).some((r) => r.type === 'custom-title' && r.customTitle === JOB)).toBe(true)
    // `--model` was honored — the assistant records say which model answered. Polled:
    // the Stop hook (which is what painted "done" above) can land a beat BEFORE the
    // assistant line is flushed to the file (seen live, 2.1.263,).
    await expect
      .poll(
        () =>
          records(file)
            .filter((r) => r.type === 'assistant')
            .map((r) => r.message?.model),
        { timeout: 30_000 }
      )
      .toContain(MODEL)
  } catch (e) {
    // This case runs blind — nobody is watching the real claude's screen — so a failure
    // keeps what that screen said. The DOM renderer (test seam) makes the terminal text
    // readable, hidden tabs included.
    const screens = await page
      .locator('.terminals .term-wrap')
      .allInnerTexts()
      .catch(() => [] as string[])
    await test.info().attach('terminal-screens', {
      body: screens.join('\n\n────────\n\n'),
      contentType: 'text/plain'
    })
    // and what claude had written by then — record types in order, one per line
    const files = worktree ? transcripts(env, worktree) : []
    const shapes = files.map(
      (f) =>
        `${f}\n${records(f)
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
