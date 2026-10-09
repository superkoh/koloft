import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import type { Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  HAVE_REAL_GH,
  NEEDS_REAL_GH,
  installRealGhThatOnlyReads,
  seedSettings,
  setGithubFixture,
  type E2EEnv
} from './helpers/env'
import { runGit, setupGitFixture } from './helpers/gitFixture'
import {
  boundSessionId,
  centerTerm,
  chooseBackend,
  openWorktreeSession,
  waitBooted,
  wsRows
} from './helpers/p1'
import { portOffset } from '../../src/shared/worktreeName'
import {
  PR_3_CHECKS_LINE,
  PR_3_FAILING_CHECK_PASTE_HEAD,
  PR_3_FIRST_ERROR_LINE,
  PR_3_NPM_ERROR,
  PR_3_OF_KOLOFT,
  WORKBENCH,
  claudePromptsIn,
  claudeRepliesIn,
  claudeToolResultsIn,
  outsideThePaste,
  putCommentOnFirstHunkInSession,
  showBrowse
} from './helpers/workbench'

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
  body: (s: RealWorktreeSession) => Promise<void>,
  seedRepo?: (repo: string) => void
): Promise<void> {
  const fx = setupGitFixture(env)
  seedRepo?.(fx.clone)
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
const CHILD_TASK = 'Reply with the single word ok.'
const START_A_CHILD_THEN_CLOSE_IT = {
  default: `Run these shell commands one after another, each exactly once: koloft session new -w ${CHILD} -- "${CHILD_TASK}" — it prints the new session's name in quotes — then sleep 20 — then koloft session close with that name in quotes. Then say only what the last command printed. Do nothing else.`,
  other: `Run this shell command exactly once: koloft session new -w ${CHILD} -- "${CHILD_TASK}" It prints a tab id. Then run sleep 20, then run koloft session close with that tab id. Then say only what the last command printed. Do nothing else.`
}
const TITLE_SAMPLE_EVERY_MS = 250
// CODEX§17
const TITLE_DRAWN_FROM_THE_HANDOVER = /Koloft started you|hand-?off|hand-?over/i

// CC§9
function launchNameOfTheChild(env: E2EEnv): string | undefined {
  const projects = path.join(env.home, '.claude', 'projects')
  for (const slug of fs.readdirSync(projects))
    for (const f of fs.readdirSync(path.join(projects, slug)).filter((n) => n.endsWith('.jsonl'))) {
      const text = fs.readFileSync(path.join(projects, slug, f), 'utf8')
      if (!text.includes(CHILD_TASK)) continue
      const named = text
        .split('\n')
        .map((l) => {
          try {
            return JSON.parse(l)
          } catch {
            return null
          }
        })
        .find((r) => r?.type === 'custom-title')
      if (named) return named.customTitle
    }
  return undefined
}

async function titlesSeenUntilOneRowIsLeft(rows: Locator, parentTabId: string): Promise<string[]> {
  const seen = new Set<string>()
  await expect
    .poll(
      async () => {
        const tabs = await rows.evaluateAll((els) =>
          els.map((el) => ({
            tabId: el.getAttribute('data-tab-id'),
            title: el.querySelector('.ws-tab-title')?.textContent ?? ''
          }))
        )
        for (const t of tabs) if (t.tabId !== parentTabId) seen.add(t.title)
        return tabs.length
      },
      { intervals: [TITLE_SAMPLE_EVERY_MS], timeout: A_REAL_MODEL_TURN_MS }
    )
    .toBe(1)
  return [...seen]
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
      const childTitles = await titlesSeenUntilOneRowIsLeft(rows, parentTabId!)
      await test.info().attach('child-titles', { body: childTitles.join('\n') })
      if (backend === 'default') {
        const name = launchNameOfTheChild(env)
        expect(name).toBeTruthy()
        expect(name).not.toBe(CHILD_TASK)
        expect(childTitles).toContain(name)
      }
      expect(childTitles.join('\n')).not.toMatch(TITLE_DRAWN_FROM_THE_HANDOVER)
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
  if (fs.existsSync(projects))
    for (const slug of fs.readdirSync(projects))
      for (const f of fs.readdirSync(path.join(projects, slug)).filter((n) => n.endsWith('.jsonl')))
        await test.info().attach(f, { path: path.join(projects, slug, f) })
  for (const f of codexRollouts(env)) await test.info().attach(path.basename(f), { path: f })
}

function codexRollouts(env: E2EEnv): string[] {
  const root = path.join(env.home, '.codex', 'sessions')
  if (!fs.existsSync(root)) return []
  return fs
    .readdirSync(root, { recursive: true, encoding: 'utf8' })
    .filter((f) => /(^|\/)rollout-[^/]*\.jsonl$/.test(f))
    .map((f) => path.join(root, f))
}

function jsonLines(file: string): Record<string, unknown>[] {
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>]
      } catch {
        return []
      }
    })
}

interface CodexItem {
  type?: string
  content?: { text?: unknown }[]
  aggregated_output?: unknown
}

function contentText(item: CodexItem): string {
  return (item.content ?? [])
    .map((c) => c.text)
    .filter((t) => typeof t === 'string')
    .join('')
}

function rolloutThreadId(file: string): string {
  return (
    /-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/.exec(file)?.[1] ?? ''
  )
}

function codexItems(
  env: E2EEnv,
  sessionId: string,
  itemType: string,
  textOf: (item: CodexItem) => string = contentText
): string[] {
  return codexRollouts(env)
    .filter((f) => !!rolloutThreadId(f) && sessionId.endsWith(rolloutThreadId(f)))
    .flatMap(jsonLines)
    .flatMap((r) => {
      const payload = r.payload as { type?: string; item?: CodexItem } | undefined
      const item = r.type === 'event_msg' && payload?.type === 'item_completed' && payload.item
      return item && item.type === itemType ? [textOf(item)] : []
    })
}

function claudeTranscript(env: E2EEnv, sessionId: string): string {
  const projects = path.join(env.home, '.claude', 'projects')
  if (!fs.existsSync(projects)) return ''
  return fs
    .readdirSync(projects)
    .map((slug) => path.join(projects, slug, `${sessionId}.jsonl`))
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f, 'utf8'))
    .join('\n')
}

interface RealTranscript {
  prompts: (env: E2EEnv, sessionId: string) => string[]
  replies: (env: E2EEnv, sessionId: string) => string[]
  pasteOnScreen: RegExp
}

const CLAUDE_TRANSCRIPT: RealTranscript = {
  prompts: (env, sessionId) => claudePromptsIn(claudeTranscript(env, sessionId)),
  replies: (env, sessionId) => claudeRepliesIn(claudeTranscript(env, sessionId)),
  // CC§18
  pasteOnScreen: /\[Pasted text #\d+ \+\d+ lines\]/
}

const HUNK_FILE = 'README.md'
const LINE_THE_HUNK_ADDS = 'a line for the hunk comment'
const REPLY_WORD = 'KIWI'
const NOTE_ASKING_FOR_ONE_WORD = `Koloft paste check.\nReply with only the word ${REPLY_WORD}.`

const CODEX_TRANSCRIPT: RealTranscript = {
  prompts: (env, sessionId) => codexItems(env, sessionId, 'UserMessage'),
  replies: (env, sessionId) => codexItems(env, sessionId, 'AgentMessage'),
  pasteOnScreen: new RegExp(REPLY_WORD)
}

const A_PASTE_THAT_SENT_ITSELF_WOULD_HAVE_STARTED_A_TURN_BY_MS = 5_000

function aHunkCommentWaitsForEnterThenGoesAsOneMessage(
  env: E2EEnv,
  backend: 'default' | 'other',
  useReal: (env: E2EEnv, trusted: string[]) => void,
  transcript: RealTranscript
): Promise<void> {
  test.setTimeout(A_REAL_MODEL_TURN_MS + 180_000)
  return inARealWorktreeSession(env, backend, useReal, [], async ({ page, rows, tree }) => {
    fs.appendFileSync(path.join(tree, HUNK_FILE), `${LINE_THE_HUNK_ADDS}\n`)
    const tabId = (await rows.getAttribute('data-tab-id'))!
    const sessionId = (await boundSessionId(page, tabId)) ?? ''
    expect(sessionId).not.toBe('')
    await showBrowse(page)
    await page
      .locator(`${WORKBENCH.kindBar} .seg[aria-label="Files view"] button`)
      .filter({ hasText: 'Changes' })
      .click()
    const promptsBefore = transcript.prompts(env, sessionId).length
    const repliesBefore = transcript.replies(env, sessionId).length

    const head = await putCommentOnFirstHunkInSession(page, HUNK_FILE, NOTE_ASKING_FOR_ONE_WORD)
    await expect.poll(() => screen(page), { timeout: 30_000 }).toMatch(transcript.pasteOnScreen)
    await page.waitForTimeout(A_PASTE_THAT_SENT_ITSELF_WOULD_HAVE_STARTED_A_TURN_BY_MS)
    await test.info().attach('screen-before-enter', { body: await screen(page) })
    expect(transcript.prompts(env, sessionId)).toHaveLength(promptsBefore)
    await expect(rows).not.toHaveClass(/\bst-working\b/)

    await page.evaluate((id) => window.api.terminal.write(id, '\r'), tabId)
    await expect
      .poll(() => transcript.prompts(env, sessionId).length, { timeout: A_REAL_MODEL_TURN_MS })
      .toBe(promptsBefore + 1)
    const sent = transcript.prompts(env, sessionId).at(-1)!
    await test.info().attach('the-one-message', { body: sent })
    expect(sent).toContain(head)
    expect(sent).toContain(`+${LINE_THE_HUNK_ADDS}`)
    expect(outsideThePaste(sent)).toContain(NOTE_ASKING_FOR_ONE_WORD)
    await expect
      .poll(() => transcript.replies(env, sessionId).length, { timeout: A_REAL_MODEL_TURN_MS })
      .toBeGreaterThan(repliesBefore)
    await expect(rows).toHaveClass(/\bst-(waiting|idle)\b/, { timeout: A_REAL_MODEL_TURN_MS })
    const replies = transcript.replies(env, sessionId).slice(repliesBefore)
    await test.info().attach('the-reply', { body: replies.join('\n') })
    expect(replies.at(-1)?.trim()).toBe(REPLY_WORD)
    expect(transcript.prompts(env, sessionId)).toHaveLength(promptsBefore + 1)
  })
}

const ASK_FOR_THE_NPM_ERROR_CODE = 'Reply with only the npm error code.'
const PR_3_NPM_ERROR_CODE = 'ERESOLVE'
const TYPED_TEXT_SETTLES_IN_THE_INPUT_BOX_MS = 1_000
const A_SUBMITTED_PROMPT_REACHES_THE_TRANSCRIPT_MS = 15_000
const CHECKS_PASTE_ON_SCREEN = {
  // CC§18
  default: /\[Pasted text #\d+ \+\d+ lines\]/,
  // CODEX§23
  other: /\[Pasted Content \d+ chars\]/
}

function failingChecksWaitForEnterThenGoWithTheTypedQuestion(
  env: E2EEnv,
  backend: 'default' | 'other',
  useReal: (env: E2EEnv, trusted: string[]) => void,
  transcript: RealTranscript
): Promise<void> {
  test.setTimeout(A_REAL_MODEL_TURN_MS + 180_000)
  return inARealWorktreeSession(
    env,
    backend,
    useReal,
    [],
    async ({ page, rows }) => {
      const tabId = (await rows.getAttribute('data-tab-id'))!
      const sessionId = (await boundSessionId(page, tabId)) ?? ''
      expect(sessionId).not.toBe('')
      await expect(page.locator('.wb-gh .ci')).toHaveClass(/\bfail\b/, { timeout: 60_000 })
      const promptsBefore = transcript.prompts(env, sessionId).length
      const repliesBefore = transcript.replies(env, sessionId).length

      await page.locator('.wb-gh').click({ button: 'right' })
      await expect(page.locator('.wb-ghmenu .mi.head')).toHaveText(PR_3_CHECKS_LINE)
      await page.locator('.wb-ghmenu .mi', { hasText: 'Send failing checks' }).click()
      await expect
        .poll(() => screen(page), { timeout: 60_000 })
        .toMatch(CHECKS_PASTE_ON_SCREEN[backend])
      await page.waitForTimeout(A_PASTE_THAT_SENT_ITSELF_WOULD_HAVE_STARTED_A_TURN_BY_MS)
      await test.info().attach('screen-before-the-question', { body: await screen(page) })
      expect(transcript.prompts(env, sessionId)).toHaveLength(promptsBefore)
      await expect(rows).not.toHaveClass(/\bst-working\b/)

      await expect
        .poll(() => page.evaluate(() => !!document.activeElement?.closest('.term-island')))
        .toBe(true)
      await page.keyboard.type(ASK_FOR_THE_NPM_ERROR_CODE)
      for (let i = 0; i < ENTERS_BEFORE_GIVING_UP; i++) {
        await page.waitForTimeout(TYPED_TEXT_SETTLES_IN_THE_INPUT_BOX_MS)
        await page.keyboard.press('Enter')
        const sent = await expect
          .poll(() => transcript.prompts(env, sessionId).length, {
            timeout: A_SUBMITTED_PROMPT_REACHES_THE_TRANSCRIPT_MS
          })
          .toBeGreaterThan(promptsBefore)
          .then(() => true)
          .catch(() => false)
        if (sent) break
      }
      expect(transcript.prompts(env, sessionId)).toHaveLength(promptsBefore + 1)
      const sent = transcript.prompts(env, sessionId).at(-1)!
      await test.info().attach('the-one-message', { body: sent })
      expect(sent).toContain(PR_3_FAILING_CHECK_PASTE_HEAD)
      expect(sent).toContain(PR_3_NPM_ERROR)
      expect(sent).toContain(PR_3_FIRST_ERROR_LINE)
      expect(outsideThePaste(sent)).toContain(ASK_FOR_THE_NPM_ERROR_CODE)
      await expect
        .poll(() => transcript.replies(env, sessionId).length, { timeout: A_REAL_MODEL_TURN_MS })
        .toBeGreaterThan(repliesBefore)
      await expect(rows).toHaveClass(/\bst-(waiting|idle)\b/, { timeout: A_REAL_MODEL_TURN_MS })
      const replies = transcript.replies(env, sessionId).slice(repliesBefore)
      await test.info().attach('the-reply', { body: replies.join('\n') })
      console.log(
        `message: ${JSON.stringify(sent.slice(0, 160))} … ${JSON.stringify(sent.slice(-140))} reply: ${JSON.stringify(replies.at(-1))}`
      )
      expect(replies.at(-1)?.trim()).toBe(PR_3_NPM_ERROR_CODE)
      expect(transcript.prompts(env, sessionId)).toHaveLength(promptsBefore + 1)
    },
    (repo) => {
      installRealGhThatOnlyReads(env)
      setGithubFixture(env, { [path.join(repo, '.claude', 'worktrees', WORKTREE)]: PR_3_OF_KOLOFT })
    }
  )
}

const ECHO_THE_PORT_OFFSET = {
  default:
    'Run this shell command exactly once with your Bash tool: echo "$KOLOFT_PORT_OFFSET" — then reply with only the number it printed. Do nothing else.',
  other:
    'Run this shell command exactly once with your shell tool: echo "$KOLOFT_PORT_OFFSET" — then reply with only the number it printed. Do nothing else.'
}
const IGNORED_FILE_THE_WORKTREE_INCLUDE_LISTS = '.env'
const IGNORED_FILE_TEXT = 'PORT=3000\n'

function ignoredEnvFileListedInWorktreeInclude(repo: string): void {
  fs.writeFileSync(path.join(repo, '.gitignore'), `${IGNORED_FILE_THE_WORKTREE_INCLUDE_LISTS}\n`)
  fs.writeFileSync(
    path.join(repo, '.worktreeinclude'),
    `${IGNORED_FILE_THE_WORKTREE_INCLUDE_LISTS}\n`
  )
  runGit(repo, 'add', '-A')
  runGit(repo, 'commit', '-q', '-m', 'worktreeinclude')
  fs.writeFileSync(path.join(repo, IGNORED_FILE_THE_WORKTREE_INCLUDE_LISTS), IGNORED_FILE_TEXT)
}

interface ShellTranscript {
  replies: (env: E2EEnv, sessionId: string) => string[]
  shellOutputs: (env: E2EEnv, sessionId: string) => string[]
}

const CLAUDE_SHELL_TRANSCRIPT: ShellTranscript = {
  replies: CLAUDE_TRANSCRIPT.replies,
  shellOutputs: (env, sessionId) => claudeToolResultsIn(claudeTranscript(env, sessionId))
}

const CODEX_SHELL_TRANSCRIPT: ShellTranscript = {
  replies: CODEX_TRANSCRIPT.replies,
  shellOutputs: (env, sessionId) =>
    codexItems(env, sessionId, 'CommandExecution', (item) => String(item.aggregated_output ?? ''))
}

function theAgentsOwnShellSeesItsWorktreesPortOffset(
  env: E2EEnv,
  backend: 'default' | 'other',
  useReal: (env: E2EEnv, trusted: string[]) => void,
  transcript: ShellTranscript,
  withWorktreeInclude = false
): Promise<void> {
  test.setTimeout(A_REAL_MODEL_TURN_MS + 180_000)
  return inARealWorktreeSession(
    env,
    backend,
    useReal,
    [],
    async ({ page, rows, tree }) => {
      if (withWorktreeInclude)
        expect(
          fs.readFileSync(path.join(tree, IGNORED_FILE_THE_WORKTREE_INCLUDE_LISTS), 'utf8')
        ).toBe(IGNORED_FILE_TEXT)
      const sessionId =
        (await boundSessionId(page, (await rows.getAttribute('data-tab-id'))!)) ?? ''
      expect(sessionId).not.toBe('')
      await ask(page, rows, ECHO_THE_PORT_OFFSET[backend])
      await expect(rows).toHaveClass(/\bst-(waiting|idle)\b/, { timeout: A_REAL_MODEL_TURN_MS })
      await expect
        .poll(() => transcript.replies(env, sessionId).length, { timeout: 30_000 })
        .toBeGreaterThan(0)
      const replies = transcript.replies(env, sessionId)
      const outputs = transcript.shellOutputs(env, sessionId)
      await test.info().attach('the-reply', { body: replies.join('\n') })
      await test.info().attach('the-shell-output', { body: outputs.join('\n') })
      console.log(`reply: ${JSON.stringify(replies.at(-1))} shell: ${JSON.stringify(outputs)}`)
      const offset = String(portOffset(WORKTREE))
      expect(replies.at(-1)?.trim()).toBe(offset)
      expect(outputs.map((o) => o.trim())).toContain(offset)
    },
    withWorktreeInclude ? ignoredEnvFileListedInWorktreeInclude : undefined
  )
}

test.describe('KOLOFT_PORT_OFFSET reaches the REAL agent’s own shell in a worktree session: opt-in cases; they spend real money', () => {
  test('a real Claude Code in a worktree session echoes, with its Bash tool, the port offset of that worktree’s name', async ({
    env
  }) => {
    test.skip(
      !HAVE_REAL_CLAUDE,
      'set KOLOFT_SMOKE_CLAUDE (absolute path of a real claude binary) and KOLOFT_SMOKE_OAUTH_TOKEN or KOLOFT_SMOKE_ACCOUNT (a Settings ▸ Accounts name, read off the Keychain)'
    )
    await theAgentsOwnShellSeesItsWorktreesPortOffset(
      env,
      'default',
      useRealClaude,
      CLAUDE_SHELL_TRANSCRIPT
    )
  })

  test('a real Codex in a worktree Koloft made gets the ignored files .worktreeinclude lists, and echoes, with its shell tool, the port offset of that worktree’s name', async ({
    env
  }) => {
    test.skip(
      !HAVE_REAL_CODEX,
      'set KOLOFT_SMOKE_CODEX (absolute path of a real codex binary) and KOLOFT_SMOKE_CODEX_HOME (a signed-in CODEX_HOME; only its auth.json is copied)'
    )
    await theAgentsOwnShellSeesItsWorktreesPortOffset(
      env,
      'other',
      useRealCodex,
      CODEX_SHELL_TRANSCRIPT,
      true
    )
  })
})

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

test.describe('✎ comment on a Changes hunk with the REAL claude and codex: opt-in cases proving the paste waits in the input box; they spend real money', () => {
  test('a real Claude Code holds the hunk comment in its input box unsent, and the next Enter sends path, diff fence and hunk as a paste and the two-line note as typed words in one message, which the model obeys', async ({
    env
  }) => {
    test.skip(
      !HAVE_REAL_CLAUDE,
      'set KOLOFT_SMOKE_CLAUDE (absolute path of a real claude binary) and KOLOFT_SMOKE_OAUTH_TOKEN or KOLOFT_SMOKE_ACCOUNT (a Settings ▸ Accounts name, read off the Keychain)'
    )
    await aHunkCommentWaitsForEnterThenGoesAsOneMessage(
      env,
      'default',
      useRealClaude,
      CLAUDE_TRANSCRIPT
    )
  })

  test('a real Codex holds the hunk comment in its composer unsent, and the next Enter sends path, diff fence, hunk and the two-line note as one message, which the model obeys', async ({
    env
  }) => {
    test.skip(
      !HAVE_REAL_CODEX,
      'set KOLOFT_SMOKE_CODEX (absolute path of a real codex binary) and KOLOFT_SMOKE_CODEX_HOME (a signed-in CODEX_HOME; only its auth.json is copied)'
    )
    await aHunkCommentWaitsForEnterThenGoesAsOneMessage(
      env,
      'other',
      useRealCodex,
      CODEX_TRANSCRIPT
    )
  })
})

test.describe('GitHub button ▸ Send failing checks with the REAL gh, claude and codex: opt-in cases on superkoh/koloft PR #3 proving the checks wait in the input box; they spend real money', () => {
  test('a real Claude Code holds the failing checks of PR #3 in its input box unsent, and the question typed after them goes with them as one message, which the model answers from the log excerpt', async ({
    env
  }) => {
    test.skip(
      !HAVE_REAL_CLAUDE,
      'set KOLOFT_SMOKE_CLAUDE (absolute path of a real claude binary) and KOLOFT_SMOKE_OAUTH_TOKEN or KOLOFT_SMOKE_ACCOUNT (a Settings ▸ Accounts name, read off the Keychain)'
    )
    test.skip(!HAVE_REAL_GH, NEEDS_REAL_GH)
    await failingChecksWaitForEnterThenGoWithTheTypedQuestion(
      env,
      'default',
      useRealClaude,
      CLAUDE_TRANSCRIPT
    )
  })

  test('a real Codex holds the failing checks of PR #3 in its composer unsent, and the question typed after them goes with them as one message, which the model answers from the log excerpt', async ({
    env
  }) => {
    test.skip(
      !HAVE_REAL_CODEX,
      'set KOLOFT_SMOKE_CODEX (absolute path of a real codex binary) and KOLOFT_SMOKE_CODEX_HOME (a signed-in CODEX_HOME; only its auth.json is copied)'
    )
    test.skip(!HAVE_REAL_GH, NEEDS_REAL_GH)
    await failingChecksWaitForEnterThenGoWithTheTypedQuestion(
      env,
      'other',
      useRealCodex,
      CODEX_TRANSCRIPT
    )
  })
})
