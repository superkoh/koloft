import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { addCodexAccount, installGhForWorkspaceA, seedSettings, type E2EEnv } from './helpers/env'
import {
  gitCommitAll,
  gitInit,
  seedJsonl,
  startSessionIn,
  terminalText,
  waitBooted,
  wsRows
} from './helpers/p1'
import { startFakeDiscord, type FakeDiscord } from './helpers/fakeDiscord'
import { BACKEND_LABEL } from '../../src/shared/sessionBackend'
import { ownerSays } from '../../src/shared/agentGuide'
import { lastCodexTurnPermissions } from './helpers/codexRollout'

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
const NEEDS_REAL_CLAUDE =
  'set KOLOFT_SMOKE_CLAUDE (absolute path of a real claude binary) and KOLOFT_SMOKE_OAUTH_TOKEN or KOLOFT_SMOKE_ACCOUNT (a Settings ▸ Accounts name, read off the Keychain)'
const NEEDS_REAL_CODEX =
  'set KOLOFT_SMOKE_CODEX (absolute path of a real codex binary) and KOLOFT_SMOKE_CODEX_HOME (a signed-in CODEX_HOME; only its auth.json is copied)'

const NO_RETRY_SINCE_EVERY_RUN_SPENDS_REAL_MONEY = 0
test.describe.configure({ retries: NO_RETRY_SINCE_EVERY_RUN_SPENDS_REAL_MONEY })

const OWNER = { id: '555', username: 'letian' }
const CHANNEL = '222'
const A_REAL_MODEL_TURN_MS = 180_000
const TWO_LINE_REPLY = 'PAPAYA-42\nGUAVA-17'
const ASK_FOR_TWO_LINES = `Reply with exactly these two lines and nothing else, no formatting:\n${TWO_LINE_REPLY}`
// CC§7
const AMBIENT_ENV_THAT_WOULD_BYPASS_THE_ACCOUNT = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_MODEL'
]

function seedConductor(env: E2EEnv, backend: 'claude' | 'codex'): void {
  gitInit(env.workspaces.a)
  seedSettings(env, {
    hintsOff: true,
    assist: { on: true, backend },
    discord: {
      userId: OWNER.id,
      userName: OWNER.username,
      channel: { guildId: '111', channelId: CHANNEL, name: 'koloft-all' }
    }
  })
}

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
}

function useRealCodex(env: E2EEnv): void {
  const spot = path.join(env.fakeBin, 'codex')
  fs.symlinkSync(REAL_CODEX, spot)
  const home = path.join(env.home, '.codex')
  fs.mkdirSync(home, { recursive: true })
  addCodexAccount(env, fs.readFileSync(path.join(SIGNED_IN_CODEX_HOME, 'auth.json'), 'utf8'))
  // CODEX§11
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    `[projects.${JSON.stringify(env.workspaces.a)}]\ntrust_level = "trusted"\n`
  )
  env.launchEnv.KOLOFT_CODEX_CMD = spot
  env.launchEnv.CODEX_HOME = home
}

function addClaudeAccountToKeychain(env: E2EEnv): void {
  const keychain = fs.existsSync(env.keychainFile)
    ? (JSON.parse(fs.readFileSync(env.keychainFile, 'utf8')) as Record<string, unknown>)
    : {}
  keychain['koloft-dev-claude-oauth'] = { alpha: CLAUDE_TOKEN }
  fs.writeFileSync(env.keychainFile, JSON.stringify(keychain))
}

function said(fake: FakeDiscord): string[] {
  return fake.posted.filter((p) => p.channelId === CHANNEL).map((p) => p.content)
}

function conductorSaid(fake: FakeDiscord): string[] {
  return fake.posted.filter((p) => p.channelId === CHANNEL && !p.card).map((p) => p.content)
}

function ran(fake: FakeDiscord): string[] {
  return said(fake).filter((p) => p.startsWith('⌨️ '))
}

function repliesAfter(fake: FakeDiscord, count: number): string[] {
  return conductorSaid(fake).slice(count)
}

interface Rec {
  type?: string
  message?: { role?: string; content?: unknown }
}

function transcriptRecords(env: E2EEnv, sessionId: string): Rec[] {
  const root = path.join(env.home, '.claude', 'projects')
  for (const dir of fs.readdirSync(root)) {
    const file = path.join(root, dir, `${sessionId}.jsonl`)
    if (!fs.existsSync(file)) continue
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Rec]
        } catch {
          return []
        }
      })
  }
  return []
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return (content as { type?: string; text?: string }[])
    .filter((c) => c.type === 'text' && typeof c.text === 'string')
    .map((c) => c.text)
    .join('')
}

function toolResults(env: E2EEnv, sessionId: string): string[] {
  return transcriptRecords(env, sessionId)
    .filter((r) => r.type === 'user' && Array.isArray(r.message?.content))
    .flatMap((r) => r.message!.content as { type?: string; content?: unknown }[])
    .filter((c) => c.type === 'tool_result')
    .map((c) => textOf(c.content))
}

function commandsRun(env: E2EEnv, sessionId: string): string[] {
  return transcriptRecords(env, sessionId)
    .filter((r) => r.type === 'assistant' && Array.isArray(r.message?.content))
    .flatMap((r) => r.message!.content as { type?: string; input?: { command?: unknown } }[])
    .flatMap((c) =>
      c.type === 'tool_use' && typeof c.input?.command === 'string' ? [c.input.command] : []
    )
}

function saidBy(env: E2EEnv, sessionId: string, role: 'user' | 'assistant'): string[] {
  return transcriptRecords(env, sessionId)
    .filter((r) => r.type === role)
    .map((r) => textOf(r.message?.content))
}

async function keepWhatHappened(env: E2EEnv, fake: FakeDiscord): Promise<void> {
  await test.info().attach('channel', { body: said(fake).join('\n────\n') || '(nothing)' })
  const projects = path.join(env.home, '.claude', 'projects')
  if (!fs.existsSync(projects)) return
  for (const slug of fs.readdirSync(projects))
    for (const f of fs.readdirSync(path.join(projects, slug)).filter((n) => n.endsWith('.jsonl')))
      await test.info().attach(f, { path: path.join(projects, slug, f) })
}

async function withConductor(
  env: E2EEnv,
  fake: FakeDiscord,
  body: (app: ElectronApplication, page: Page) => Promise<void>
): Promise<void> {
  const app = await launchApp(env)
  const page = await app.firstWindow()
  try {
    await waitBooted(page)
    await expect.poll(() => fake.identifies).toBe(1)
    await body(app, page)
  } finally {
    await keepWhatHappened(env, fake)
    await quitAndClose(app)
    await fake.close()
  }
}

async function realClaudeConductor(env: E2EEnv): Promise<FakeDiscord> {
  seedConductor(env, 'claude')
  useRealClaude(env)
  const fake = await startFakeDiscord(env)
  addClaudeAccountToKeychain(env)
  return fake
}

function hookDir(env: E2EEnv): string {
  return path.join(env.userData, 'hook-sessions')
}

function hookQuestionFiles(env: E2EEnv, tabId: string): string[] {
  return fs
    .readdirSync(hookDir(env))
    .filter((f) => f.startsWith(`${tabId}.`) && /\.(ask|answer)\.json$/.test(f))
}

function answerableMarker(env: E2EEnv, tabId: string): string {
  return path.join(hookDir(env), `${tabId}.answerable`)
}

async function liveClaudeTab(page: Page): Promise<{ tabId: string; sessionId: string }> {
  await startSessionIn(page, 'ws-a')
  return (await page.evaluate(() => window.api.sessions.list())).find((s) => s.alive && !s.butler)!
}

const CLAUDE_INPUT_READY = /^❯/m
// CC§12
const CR_AFTER_TEXT_MS = 300
let prompts = 0

async function typePrompt(page: Page, tabId: string, text: string): Promise<void> {
  const token = `KOLOFT-PROBE-${++prompts}`
  await expect
    .poll(() => terminalText(page, tabId), { timeout: 60_000 })
    .toMatch(CLAUDE_INPUT_READY)
  await page.evaluate(([id, l]) => window.api.terminal.write(id, l), [tabId, `${token} ${text}`])
  await expect.poll(() => terminalText(page, tabId), { timeout: 30_000 }).toContain(token)
  await page.waitForTimeout(CR_AFTER_TEXT_MS)
  await page.evaluate((id) => window.api.terminal.write(id, '\r'), tabId)
}

async function typeLine(page: Page, tabId: string, text: string): Promise<void> {
  await page.evaluate(([id, l]) => window.api.terminal.write(id, l), [tabId, text])
  await page.waitForTimeout(CR_AFTER_TEXT_MS)
  await page.evaluate((id) => window.api.terminal.write(id, '\r'), tabId)
}

const ENDED_TITLE = 'Old notes cleanup'

async function closesTheEndedSessionItIsAskedTo(
  env: E2EEnv,
  fake: FakeDiscord,
  page: Page,
  endedId: string
): Promise<void> {
  const seeded = transcriptRecords(env, endedId).length
  await expect(wsRows(page, 'ws-a')).toHaveCount(1, { timeout: 30_000 })
  fake.say(
    OWNER,
    `The session "${ENDED_TITLE}" in the ws-a workspace has ended and I do not need it any more. Take it off the Koloft list for good.`
  )
  await expect(wsRows(page, 'ws-a')).toHaveCount(0, { timeout: A_REAL_MODEL_TURN_MS })
  expect(transcriptRecords(env, endedId)).toHaveLength(seeded)
}

async function writesInTheWorkspaceItself(env: E2EEnv, fake: FakeDiscord): Promise<void> {
  const target = path.join(env.workspaces.a, 'butler-wrote.txt')
  fake.say(
    OWNER,
    `This checks your own permissions. Do not start or message any session. Try once, yourself, to create the file ${target} containing the word hi, then reply with exactly WRITE-DONE if the file was written or WRITE-REFUSED if it was refused.`
  )
  await expect
    .poll(() => conductorSaid(fake).join('\n'), { timeout: A_REAL_MODEL_TURN_MS })
    .toMatch(/WRITE-(DONE|REFUSED)/)
  expect(conductorSaid(fake).join('\n')).toContain('WRITE-DONE')
  expect(fs.readFileSync(target, 'utf8').trim()).toBe('hi')
}

const PR_TITLE_ONLY_GH_KNOWS = 'PLUM-58 tidy the docs'
const ISSUE_ONLY_GH_KNOWS = 'https://github.com/acme/app/issues/4242'

function fakeGhSaysMerged(env: E2EEnv): string {
  return installGhForWorkspaceA(
    env,
    `{"number":389,"state":"MERGED","title":"${PR_TITLE_ONLY_GH_KNOWS}"}`
  )
}

async function checksGithubItself(fake: FakeDiscord, log: string): Promise<void> {
  fake.say(
    OWNER,
    'Is pull request 389 of acme/app merged? Do not start or message any session; check it yourself on GitHub, then reply with its state and its exact title.'
  )
  await expect
    .poll(() => conductorSaid(fake).join('\n'), { timeout: A_REAL_MODEL_TURN_MS })
    .toContain('PLUM-58')
  expect(fs.readFileSync(log, 'utf8')).toMatch(/^pr (view|list|checks) .*(--repo|-R)[= ]acme\/app/m)
}

function fakeGhOpensIssue(env: E2EEnv): string {
  return installGhForWorkspaceA(env, '[]', ISSUE_ONLY_GH_KNOWS)
}

async function opensAnIssueItself(fake: FakeDiscord, log: string): Promise<void> {
  fake.say(
    OWNER,
    '请在 acme/app 仓库开一个 GitHub issue：搜索框输入第一个字以后就失去焦点。不要开会话，也不要叫别的会话做，你自己开，然后把 issue 地址回给我。'
  )
  await expect
    .poll(() => conductorSaid(fake).join('\n'), { timeout: A_REAL_MODEL_TURN_MS })
    .toContain(ISSUE_ONLY_GH_KNOWS)
  const calls = fs.readFileSync(log, 'utf8')
  const created = /^issue create [\s\S]*?(?=^(?:issue|pr|run) |(?![\s\S]))/m.exec(calls)
  expect(created).not.toBeNull()
  expect(created![0]).toMatch(/(--title|-t)[= ]/)
  expect(created![0]).toMatch(/(--repo|-R)[= ]acme\/app\b/)
  expect(created![0]).not.toMatch(/[　-鿿＀-￯]/)
  expect(calls.slice(0, created!.index)).toMatch(/^issue list /m)
}

async function answersWholeInTheChannel(fake: FakeDiscord): Promise<void> {
  const asked = fake.say(OWNER, ASK_FOR_TWO_LINES)
  await expect
    .poll(() => said(fake).map((p) => p.trim()), { timeout: A_REAL_MODEL_TURN_MS })
    .toContain(TWO_LINE_REPLY)
  expect(fake.reactions).toContainEqual({ messageId: asked, emoji: '✅', on: true })
  expect(fake.typing).toContain(CHANNEL)
}

async function startedSession(page: Page): Promise<{ tabId: string; sessionId: string }> {
  await expect(wsRows(page, 'ws-a')).toHaveCount(1, { timeout: A_REAL_MODEL_TURN_MS })
  let found: { tabId: string; sessionId: string } | undefined
  await expect
    .poll(
      async () => {
        found = (await page.evaluate(() => window.api.sessions.list())).find(
          (s) => s.alive && !s.butler && s.sessionId
        )
        return !!found
      },
      { timeout: A_REAL_MODEL_TURN_MS }
    )
    .toBe(true)
  return found!
}

test.describe('Discord conductors on the REAL claude and codex, with a fake Discord: opt-in cases that spend real money', () => {
  test('a real Claude conductor gets the owner’s message and its reply comes back to the channel whole', async ({
    env
  }) => {
    test.skip(!HAVE_REAL_CLAUDE, NEEDS_REAL_CLAUDE)
    test.setTimeout(A_REAL_MODEL_TURN_MS + 120_000)
    const fake = await realClaudeConductor(env)
    await withConductor(env, fake, async () => {
      await answersWholeInTheChannel(fake)
    })
  })

  // ADR-0029
  test('a real Claude conductor, permission checks skipped, writes a file in a workspace itself when told to, as any session may', async ({
    env
  }) => {
    test.skip(!HAVE_REAL_CLAUDE, NEEDS_REAL_CLAUDE)
    test.setTimeout(A_REAL_MODEL_TURN_MS + 120_000)
    const fake = await realClaudeConductor(env)
    await withConductor(env, fake, async () => {
      await writesInTheWorkspaceItself(env, fake)
    })
  })

  // ADR-0029
  test('a real Claude conductor told not to ask a session checks a pull request itself with koloft gh, naming the repository the owner named', async ({
    env
  }) => {
    test.skip(!HAVE_REAL_CLAUDE, NEEDS_REAL_CLAUDE)
    test.setTimeout(A_REAL_MODEL_TURN_MS + 120_000)
    const fake = await realClaudeConductor(env)
    const log = fakeGhSaysMerged(env)
    await withConductor(env, fake, async () => {
      await checksGithubItself(fake, log)
    })
  })

  // ADR-0029
  test('a real Claude conductor asked in Chinese to open an issue itself looks for one already open, then opens it in English with koloft gh, naming the repository the owner named', async ({
    env
  }) => {
    test.skip(!HAVE_REAL_CLAUDE, NEEDS_REAL_CLAUDE)
    test.setTimeout(A_REAL_MODEL_TURN_MS + 120_000)
    const fake = await realClaudeConductor(env)
    const log = fakeGhOpensIssue(env)
    await withConductor(env, fake, async () => {
      await opensAnIssueItself(fake, log)
    })
  })

  // ADR-0029
  test('a real Claude conductor asked to remember something writes it into its own memory folder', async ({
    env
  }) => {
    test.skip(!HAVE_REAL_CLAUDE, NEEDS_REAL_CLAUDE)
    test.setTimeout(A_REAL_MODEL_TURN_MS + 120_000)
    const fake = await realClaudeConductor(env)
    await withConductor(env, fake, async (_app, page) => {
      fake.say(
        OWNER,
        'Save this in your own memory for future conversations: my favourite fruit is LYCHEE-31. Then reply SAVED.'
      )
      await expect
        .poll(() => conductorSaid(fake).join('\n'), { timeout: A_REAL_MODEL_TURN_MS })
        .toContain('SAVED')
      const conductor = (await page.evaluate(() => window.api.sessions.list())).find(
        (s) => s.alive && s.butler
      )!
      const projects = path.join(env.home, '.claude', 'projects')
      const memory = fs
        .readdirSync(projects)
        .map((slug) => path.join(projects, slug))
        .find((dir) => fs.existsSync(path.join(dir, `${conductor.sessionId}.jsonl`)))!
      const saved = fs
        .readdirSync(path.join(memory, 'memory'))
        .map((f) => fs.readFileSync(path.join(memory, 'memory', f), 'utf8'))
        .join('\n')
      expect(saved).toContain('LYCHEE-31')
    })
  })

  test('a real Claude conductor asked in plain words starts a Claude session in its workspace, which answers, and the conductor reports its answer', async ({
    env
  }) => {
    test.skip(!HAVE_REAL_CLAUDE, NEEDS_REAL_CLAUDE)
    test.setTimeout(4 * A_REAL_MODEL_TURN_MS + 120_000)
    const fake = await realClaudeConductor(env)
    await withConductor(env, fake, async (_app, page) => {
      fake.say(
        OWNER,
        'Start one new Claude session in the ws-a workspace whose task is: "Reply with the word KIWI and nothing else." Then tell me you started it.'
      )
      const started = await startedSession(page)
      await expect
        .poll(() => saidBy(env, started.sessionId, 'assistant').join('\n'), {
          timeout: A_REAL_MODEL_TURN_MS
        })
        .toContain('KIWI')

      const before = conductorSaid(fake).length
      fake.say(
        OWNER,
        'What did that session answer? Read it with koloft session read and tell me only its answer.'
      )
      await expect
        .poll(() => repliesAfter(fake, before).join('\n'), { timeout: A_REAL_MODEL_TURN_MS })
        .toContain('KIWI')
    })
  })

  // CC§14
  test('a real Claude conductor asked in plain words starts a Claude session whose first turn asks a question: the question draws in the session’s terminal and never reaches the channel, the owner’s "pick Green" to the conductor answers it with koloft session answer or keys, and the session takes Green', async ({
    env
  }) => {
    test.skip(!HAVE_REAL_CLAUDE, NEEDS_REAL_CLAUDE)
    test.setTimeout(5 * A_REAL_MODEL_TURN_MS + 120_000)
    const fake = await realClaudeConductor(env)
    await withConductor(env, fake, async (_app, page) => {
      fake.say(
        OWNER,
        'Start one new Claude session in the ws-a workspace with this first message, word for word: "Right away, before anything else, use the AskUserQuestion tool once to ask me which colour I prefer, with exactly three options: Red, Green and Blue. Then reply with only the colour I picked." Then tell me you started it.'
      )
      const target = await startedSession(page)
      await wsRows(page, 'ws-a').first().click()
      await expect
        .poll(() => terminalText(page, target.tabId), { timeout: 2 * A_REAL_MODEL_TURN_MS })
        .toMatch(/1\. Red[\s\S]*2\. Green[\s\S]*3\. Blue/)
      const conductor = (await page.evaluate(() => window.api.sessions.list())).find(
        (s) => s.alive && s.butler
      )!
      expect(saidBy(env, target.sessionId, 'user').filter(Boolean)).toHaveLength(1)
      expect(hookQuestionFiles(env, target.tabId)).toEqual([])
      expect(fake.posted.filter((p) => p.card)).toEqual([])

      fake.say(
        OWNER,
        'The session you just started is asking me which colour I prefer. Pick Green for me.'
      )
      await expect
        .poll(() => toolResults(env, target.sessionId).join('\n'), {
          timeout: A_REAL_MODEL_TURN_MS
        })
        .toMatch(/green/i)
      expect(commandsRun(env, conductor.sessionId).join('\n')).toMatch(
        /koloft session (answer|keys)/
      )
      await expect
        .poll(() => saidBy(env, target.sessionId, 'assistant').filter(Boolean).at(-1), {
          timeout: A_REAL_MODEL_TURN_MS
        })
        .toMatch(/Green/i)
      expect(hookQuestionFiles(env, target.tabId)).toEqual([])
    })
  })

  test('a real Claude conductor asked in plain words to drop an ended session closes it with koloft session close, without resuming it', async ({
    env
  }) => {
    test.skip(!HAVE_REAL_CLAUDE, NEEDS_REAL_CLAUDE)
    test.setTimeout(A_REAL_MODEL_TURN_MS + 120_000)
    const endedId = seedJsonl(env, env.workspaces.a, { summary: ENDED_TITLE })
    const fake = await realClaudeConductor(env)
    await withConductor(env, fake, async (_app, page) => {
      await closesTheEndedSessionItIsAskedTo(env, fake, page, endedId)
      const conductor = (await page.evaluate(() => window.api.sessions.list())).find(
        (s) => s.alive && s.butler
      )!
      expect(commandsRun(env, conductor.sessionId).join('\n')).toContain('koloft session close')
    })
  })

  test('a real Claude conductor sends a line to a real Claude session already open in its workspace; the session takes it as the owner’s words and answers', async ({
    env
  }) => {
    test.skip(!HAVE_REAL_CLAUDE, NEEDS_REAL_CLAUDE)
    test.setTimeout(3 * A_REAL_MODEL_TURN_MS + 120_000)
    const fake = await realClaudeConductor(env)
    await withConductor(env, fake, async (_app, page) => {
      await startSessionIn(page, 'ws-a')
      const target = (await page.evaluate(() => window.api.sessions.list())).find(
        (s) => s.alive && !s.butler
      )!

      fake.say(
        OWNER,
        `Run this shell command exactly once: koloft session send ${target.sessionId} "Say the word MANGO and nothing else." — then tell me what it printed.`
      )
      await expect
        .poll(() => saidBy(env, target.sessionId, 'user').join('\n'), {
          timeout: A_REAL_MODEL_TURN_MS
        })
        .toContain(ownerSays('Say the word MANGO'))
      await expect
        .poll(() => saidBy(env, target.sessionId, 'assistant').join('\n'), {
          timeout: A_REAL_MODEL_TURN_MS
        })
        .toContain('MANGO')
    })
  })

  // CC§14
  test('with Discord off, a real Claude session’s question still draws and takes the digit pressed in its terminal: the dialog hook leaves at once, writes no question file, and the turn ends', async ({
    env
  }) => {
    test.skip(!HAVE_REAL_CLAUDE, NEEDS_REAL_CLAUDE)
    test.setTimeout(2 * A_REAL_MODEL_TURN_MS + 120_000)
    gitInit(env.workspaces.a)
    seedSettings(env, { hintsOff: true })
    useRealClaude(env)
    addClaudeAccountToKeychain(env)
    const app = await launchApp(env)
    const page = await app.firstWindow()
    try {
      await waitBooted(page)
      const target = await liveClaudeTab(page)
      await typePrompt(
        page,
        target.tabId,
        'Use the AskUserQuestion tool once to ask me which colour I prefer, with exactly two options, Red and Green. Then reply with only the colour I picked.'
      )
      await expect
        .poll(() => terminalText(page, target.tabId), { timeout: A_REAL_MODEL_TURN_MS })
        .toMatch(/2\. Green[\s\S]*Type something/)
      expect(fs.existsSync(answerableMarker(env, target.tabId))).toBe(false)
      expect(hookQuestionFiles(env, target.tabId)).toEqual([])

      await page.evaluate((id) => window.api.terminal.write(id, '2'), target.tabId)
      await expect
        .poll(() => toolResults(env, target.sessionId).join('\n'), {
          timeout: A_REAL_MODEL_TURN_MS
        })
        .toMatch(/Green/)
      await expect
        .poll(() => saidBy(env, target.sessionId, 'assistant').filter(Boolean).at(-1), {
          timeout: A_REAL_MODEL_TURN_MS
        })
        .toMatch(/Green/)
      await expect(wsRows(page, 'ws-a').first()).toHaveClass(/st-waiting/, {
        timeout: A_REAL_MODEL_TURN_MS
      })
      expect(hookQuestionFiles(env, target.tabId)).toEqual([])
    } finally {
      await quitAndClose(app)
    }
  })

  test('slash commands on the real Claude: the owner’s "/context" runs in the conductor and its report reaches the channel; /compact from Discord compacts the conductor and posts Compacted', async ({
    env
  }) => {
    test.skip(!HAVE_REAL_CLAUDE, NEEDS_REAL_CLAUDE)
    test.setTimeout(3 * A_REAL_MODEL_TURN_MS + 120_000)
    const fake = await realClaudeConductor(env)
    await withConductor(env, fake, async () => {
      await answersWholeInTheChannel(fake)
      fake.say(OWNER, '/context')
      await expect
        .poll(() => ran(fake), { timeout: A_REAL_MODEL_TURN_MS })
        .toContainEqual(expect.stringMatching(/\*\*Alfred\*\* ran \/context:\n## Context Usage/))

      fake.interact(OWNER, 'compact', {})
      await expect
        .poll(() => ran(fake).at(-1), { timeout: A_REAL_MODEL_TURN_MS })
        .toMatch(/\*\*Alfred\*\* ran \/compact:\nCompacted/)
    })
  })

  test('a slash command on the real Codex: the owner’s "/compact" compacts the Codex conductor and the channel hears it is done', async ({
    env
  }) => {
    test.skip(!HAVE_REAL_CODEX, NEEDS_REAL_CODEX)
    test.setTimeout(2 * A_REAL_MODEL_TURN_MS + 120_000)
    seedConductor(env, 'codex')
    useRealCodex(env)
    const fake = await startFakeDiscord(env)
    await withConductor(env, fake, async () => {
      await answersWholeInTheChannel(fake)
      fake.say(OWNER, '/compact')
      await expect
        .poll(() => ran(fake), { timeout: A_REAL_MODEL_TURN_MS })
        .toEqual([expect.stringMatching(/\*\*Alfred\*\* ran \/compact:\nDone\.$/)])
    })
  })

  test('a real Codex conductor gets the owner’s message and its reply comes back to the channel whole', async ({
    env
  }) => {
    test.skip(!HAVE_REAL_CODEX, NEEDS_REAL_CODEX)
    test.setTimeout(A_REAL_MODEL_TURN_MS + 120_000)
    seedConductor(env, 'codex')
    useRealCodex(env)
    const fake = await startFakeDiscord(env)
    await withConductor(env, fake, async () => {
      await answersWholeInTheChannel(fake)
    })
  })

  // ADR-0029
  test('a real Codex conductor, permission checks skipped, writes a file in a workspace itself when told to, as any session may', async ({
    env
  }) => {
    test.skip(!HAVE_REAL_CODEX, NEEDS_REAL_CODEX)
    test.setTimeout(A_REAL_MODEL_TURN_MS + 120_000)
    seedConductor(env, 'codex')
    useRealCodex(env)
    seedSettings(env, { skipPermissions: true })
    const fake = await startFakeDiscord(env)
    await withConductor(env, fake, async () => {
      await writesInTheWorkspaceItself(env, fake)
    })
  })

  // ADR-0029 CODEX§11
  test('a real Codex conductor whose tab closed is resumed by the owner’s next message, on the same thread, with the permission it started with, so it still writes in a workspace itself when told to', async ({
    env
  }) => {
    test.skip(!HAVE_REAL_CODEX, NEEDS_REAL_CODEX)
    test.setTimeout(2 * A_REAL_MODEL_TURN_MS + 120_000)
    seedConductor(env, 'codex')
    useRealCodex(env)
    seedSettings(env, { skipPermissions: true })
    const fake = await startFakeDiscord(env)
    await withConductor(env, fake, async (_app, page) => {
      await answersWholeInTheChannel(fake)
      const conductor = async (): Promise<{ tabId: string; sessionId: string } | undefined> =>
        (await page.evaluate(() => window.api.sessions.list())).find((s) => s.alive && s.butler)
      const first = (await conductor())!
      const started = lastCodexTurnPermissions(env, first.sessionId)
      expect(started).toEqual({ approval: 'never', sandbox: 'danger-full-access' })
      await page.evaluate((id) => window.api.terminal.kill(id), first.tabId)
      await expect.poll(conductor).toBeUndefined()

      await writesInTheWorkspaceItself(env, fake)
      const again = (await conductor())!
      expect(again.tabId).not.toBe(first.tabId)
      expect(again.sessionId).toBe(first.sessionId)
      expect(lastCodexTurnPermissions(env, again.sessionId)).toEqual(started)
    })
  })

  // ADR-0029
  test('a real Codex conductor checks a pull request itself with koloft gh, naming the repository the owner named', async ({
    env
  }) => {
    test.skip(!HAVE_REAL_CODEX, NEEDS_REAL_CODEX)
    test.setTimeout(A_REAL_MODEL_TURN_MS + 120_000)
    seedConductor(env, 'codex')
    useRealCodex(env)
    const log = fakeGhSaysMerged(env)
    const fake = await startFakeDiscord(env)
    await withConductor(env, fake, async () => {
      await checksGithubItself(fake, log)
    })
  })

  // ADR-0029
  test('a real Codex conductor asked in Chinese to open an issue itself looks for one already open, then opens it in English with koloft gh, naming the repository the owner named', async ({
    env
  }) => {
    test.skip(!HAVE_REAL_CODEX, NEEDS_REAL_CODEX)
    test.setTimeout(A_REAL_MODEL_TURN_MS + 120_000)
    seedConductor(env, 'codex')
    useRealCodex(env)
    const log = fakeGhOpensIssue(env)
    const fake = await startFakeDiscord(env)
    await withConductor(env, fake, async () => {
      await opensAnIssueItself(fake, log)
    })
  })

  test('a real Codex conductor asked in plain words to drop an ended session closes it without resuming it', async ({
    env
  }) => {
    test.skip(!HAVE_REAL_CODEX, NEEDS_REAL_CODEX)
    test.setTimeout(A_REAL_MODEL_TURN_MS + 120_000)
    const endedId = seedJsonl(env, env.workspaces.a, { summary: ENDED_TITLE })
    seedConductor(env, 'codex')
    useRealCodex(env)
    const fake = await startFakeDiscord(env)
    await withConductor(env, fake, async (_app, page) => {
      await closesTheEndedSessionItIsAskedTo(env, fake, page, endedId)
    })
  })

  // CODEX§20
  test('a real Codex conductor put in Plan mode at the Mac asks the owner a question of its own: it reaches the channel with its options, the owner’s "Green" picks that option, and the conductor goes on with Green', async ({
    env
  }) => {
    test.skip(!HAVE_REAL_CODEX, NEEDS_REAL_CODEX)
    test.setTimeout(3 * A_REAL_MODEL_TURN_MS + 120_000)
    seedConductor(env, 'codex')
    useRealCodex(env)
    const fake = await startFakeDiscord(env)
    await withConductor(env, fake, async (_app, page) => {
      await answersWholeInTheChannel(fake)
      const conductor = (await page.evaluate(() => window.api.sessions.list())).find(
        (s) => s.alive && s.butler
      )!
      await typeLine(page, conductor.tabId, '/plan')
      await expect
        .poll(() => terminalText(page, conductor.tabId), { timeout: 30_000 })
        .toMatch(/Plan mode/i)

      fake.say(
        OWNER,
        'Use your request_user_input tool once to ask me which colour I prefer, with exactly two options, Red and Green. After I answer, reply with only the colour I picked.'
      )
      await expect
        .poll(() => said(fake).join('\n'), { timeout: A_REAL_MODEL_TURN_MS })
        .toMatch(
          /❓ .+\n(.*\n)*1\. Red\b.*\n2\. Green\b.*\n-# Reply with the number or the name of one option\./
        )
      const before = conductorSaid(fake).length
      const green = fake.say(OWNER, 'Green')
      await expect
        .poll(() => repliesAfter(fake, before).join('\n'), { timeout: A_REAL_MODEL_TURN_MS })
        .toMatch(/Green/)
      expect(fake.reactions).toContainEqual({ messageId: green, emoji: '✅', on: true })
    })
  })

  const SECRET = 'SECRET-MANGO-73'
  const CHILD_WORKS_WHILE_THE_CONDUCTOR_IS_CLOSED_S = 40
  for (const conductor of ['claude', 'codex'] as const)
    for (const child of ['claude', 'codex'] as const)
      test(`a real ${BACKEND_LABEL[child]} session a real ${BACKEND_LABEL[conductor]} conductor started reports back after the conductor’s tab was closed: Koloft opens the conductor again, which gets the report and passes it on to the channel`, async ({
        env
      }) => {
        const needs = [conductor, child]
        test.skip(
          (needs.includes('claude') && !HAVE_REAL_CLAUDE) ||
            (needs.includes('codex') && !HAVE_REAL_CODEX),
          `${NEEDS_REAL_CLAUDE}; ${NEEDS_REAL_CODEX}`
        )
        test.setTimeout(5 * A_REAL_MODEL_TURN_MS)
        seedConductor(env, conductor)
        if (needs.includes('claude')) useRealClaude(env)
        if (needs.includes('codex')) useRealCodex(env)
        fs.writeFileSync(path.join(env.workspaces.a, 'secret.txt'), `${SECRET}\n`)
        gitCommitAll(env.workspaces.a)
        const fake = await startFakeDiscord(env)
        if (needs.includes('claude')) addClaudeAccountToKeychain(env)
        await withConductor(env, fake, async (_app, page) => {
          const conductorTab = async (): Promise<string | undefined> =>
            (await page.evaluate(() => window.api.sessions.list())).find((s) => s.butler && s.alive)
              ?.tabId
          fake.say(
            OWNER,
            `Start one new ${BACKEND_LABEL[child]} session (koloft session new --backend ${child} --workspace ws-a) in the ws-a workspace whose task is: "First run the shell command perl -e 'sleep ${CHILD_WORKS_WHILE_THE_CONDUCTOR_IS_CLOSED_S}' in the foreground and wait for it to end. Then read the file secret.txt in this folder and report its content back." Then end your turn at once: do not wait for it, check on it or read it, and do not read secret.txt yourself; it reports back to you on its own. When its report reaches you, tell me exactly what it reported.`
          )
          await expect(wsRows(page, 'ws-a')).toHaveCount(1, { timeout: A_REAL_MODEL_TURN_MS })
          await expect
            .poll(() => conductorSaid(fake).length, { timeout: A_REAL_MODEL_TURN_MS })
            .toBeGreaterThan(0)
          const closed = (await conductorTab())!
          await page.evaluate((tab) => window.api.terminal.kill(tab), closed)
          await expect.poll(conductorTab).toBeUndefined()
          expect(conductorSaid(fake).join('\n')).not.toContain(SECRET)
          await expect
            .poll(() => conductorSaid(fake).join('\n'), { timeout: 3 * A_REAL_MODEL_TURN_MS })
            .toContain(SECRET)
          expect(await conductorTab()).not.toBe(closed)
        })
      })
})
