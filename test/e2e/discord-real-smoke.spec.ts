import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { seedSettings, type E2EEnv } from './helpers/env'
import { gitInit, startSessionIn, terminalText, waitBooted, wsRows } from './helpers/p1'
import { startFakeDiscord, type FakeDiscord } from './helpers/fakeDiscord'

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
    discord: {
      userId: OWNER.id,
      userName: OWNER.username,
      bindings: [
        {
          id: 'b1',
          scope: env.workspaces.a,
          backend,
          channel: { guildId: '111', channelId: CHANNEL, name: 'koloft-all' },
          sessionIds: [],
          touched: []
        }
      ]
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
    multiAccount: true,
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
  fs.copyFileSync(path.join(SIGNED_IN_CODEX_HOME, 'auth.json'), path.join(home, 'auth.json'))
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

function ran(fake: FakeDiscord): string[] {
  return said(fake).filter((p) => p.startsWith('⌨️ '))
}

function notices(fake: FakeDiscord): string[] {
  return said(fake)
    .flatMap((p) => p.split('\n'))
    .filter((l) => /^(🔔|❓|⏹|▶)/.test(l))
}

function repliesAfter(fake: FakeDiscord, count: number): string[] {
  return said(fake)
    .slice(count)
    .filter((p) => !/^(🔔|❓|⏹|▶)/.test(p))
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

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function dialogHookWaiting(env: E2EEnv, tabId: string): Promise<number> {
  await expect
    .poll(() => hookQuestionFiles(env, tabId), { timeout: A_REAL_MODEL_TURN_MS })
    .toEqual([expect.stringMatching(/\.ask\.json$/)])
  return Number(hookQuestionFiles(env, tabId)[0].split('.')[1])
}

async function dialogHookLetGo(env: E2EEnv, tabId: string, hookPid: number): Promise<void> {
  await expect.poll(() => hookQuestionFiles(env, tabId), { timeout: 30_000 }).toEqual([])
  await expect.poll(() => pidAlive(hookPid)).toBe(false)
}

async function liveClaudeTab(page: Page): Promise<{ tabId: string; sessionId: string }> {
  await startSessionIn(page, 'ws-a')
  return (await page.evaluate(() => window.api.sessions.list())).find(
    (s) => s.alive && !s.conductor
  )!
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

async function answersWholeInTheChannel(fake: FakeDiscord): Promise<void> {
  const asked = fake.say(OWNER, ASK_FOR_TWO_LINES)
  await expect
    .poll(() => said(fake).map((p) => p.trim()), { timeout: A_REAL_MODEL_TURN_MS })
    .toContain(TWO_LINE_REPLY)
  expect(fake.reactions).toContainEqual({ messageId: asked, emoji: '✅', on: true })
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

  test('a real Claude conductor asked in plain words starts a Claude session in its workspace; the channel hears it started and finished, and the conductor reports its answer', async ({
    env
  }) => {
    test.skip(!HAVE_REAL_CLAUDE, NEEDS_REAL_CLAUDE)
    test.setTimeout(4 * A_REAL_MODEL_TURN_MS + 120_000)
    const fake = await realClaudeConductor(env)
    await withConductor(env, fake, async () => {
      fake.say(
        OWNER,
        'Start one new Claude session in this workspace whose task is: "Reply with the word KIWI and nothing else." Then tell me you started it.'
      )
      await expect
        .poll(() => notices(fake), { timeout: A_REAL_MODEL_TURN_MS })
        .toContainEqual(expect.stringMatching(/^▶ Started .+ \(ws-a, Claude\)$/))
      await expect
        .poll(() => notices(fake), { timeout: A_REAL_MODEL_TURN_MS })
        .toContainEqual(expect.stringMatching(/^🔔 .+ finished\.$/))

      const before = said(fake).length
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
  test('a real Claude conductor asked in plain words starts a Claude session whose first turn asks a question: the question reaches the channel with its options while the hook waits, the owner’s "pick green" to the conductor answers it with koloft session answer, and the session takes Green', async ({
    env
  }) => {
    test.skip(!HAVE_REAL_CLAUDE, NEEDS_REAL_CLAUDE)
    test.setTimeout(5 * A_REAL_MODEL_TURN_MS + 120_000)
    const fake = await realClaudeConductor(env)
    await withConductor(env, fake, async (_app, page) => {
      fake.say(
        OWNER,
        'Start one new Claude session in this workspace with this first message, word for word: "Right away, before anything else, use the AskUserQuestion tool once to ask me which colour I prefer, with exactly three options: Red, Green and Blue. Then reply with only the colour I picked." Then tell me you started it.'
      )
      await expect
        .poll(() => notices(fake), { timeout: 2 * A_REAL_MODEL_TURN_MS })
        .toContainEqual(expect.stringMatching(/^❓ .+ is waiting for you: /))
      expect(said(fake).join('\n')).toMatch(/\n1\. Red\b.*\n2\. Green\b.*\n3\. Blue\b/)
      const sessions = await page.evaluate(() => window.api.sessions.list())
      const target = sessions.find((s) => s.alive && !s.conductor)!
      const conductor = sessions.find((s) => s.alive && s.conductor)!
      expect(saidBy(env, target.sessionId, 'user').filter(Boolean)).toHaveLength(1)
      expect(hookQuestionFiles(env, target.tabId)).toEqual([expect.stringMatching(/\.ask\.json$/)])

      fake.say(OWNER, 'pick green')
      await expect
        .poll(() => toolResults(env, target.sessionId).join('\n'), {
          timeout: A_REAL_MODEL_TURN_MS
        })
        .toMatch(/green/i)
      expect(commandsRun(env, conductor.sessionId).join('\n')).toContain('koloft session answer')
      const name = notices(fake)
        .map((l) => /^▶ Started (.+) \(ws-a, Claude\)$/.exec(l)?.[1])
        .find(Boolean)
      expect(toolResults(env, conductor.sessionId)).toContain(`Answered ${name}.`)
      await expect
        .poll(() => saidBy(env, target.sessionId, 'assistant').filter(Boolean).at(-1), {
          timeout: A_REAL_MODEL_TURN_MS
        })
        .toMatch(/Green/i)
      expect(hookQuestionFiles(env, target.tabId)).toEqual([])
    })
  })

  test('a real Claude conductor sends a line to a real Claude session already open in its workspace; the session takes it as the owner’s words and answers, and the channel hears it finished', async ({
    env
  }) => {
    test.skip(!HAVE_REAL_CLAUDE, NEEDS_REAL_CLAUDE)
    test.setTimeout(3 * A_REAL_MODEL_TURN_MS + 120_000)
    const fake = await realClaudeConductor(env)
    await withConductor(env, fake, async (_app, page) => {
      await startSessionIn(page, 'ws-a')
      const target = (await page.evaluate(() => window.api.sessions.list())).find(
        (s) => s.alive && !s.conductor
      )!

      fake.say(
        OWNER,
        `Run this shell command exactly once: koloft session send ${target.sessionId} "Say the word MANGO and nothing else." — then tell me what it printed.`
      )
      await expect
        .poll(() => saidBy(env, target.sessionId, 'user').join('\n'), {
          timeout: A_REAL_MODEL_TURN_MS
        })
        .toContain('(Your owner, via the Koloft conductor:) Say the word MANGO')
      await expect
        .poll(() => saidBy(env, target.sessionId, 'assistant').join('\n'), {
          timeout: A_REAL_MODEL_TURN_MS
        })
        .toContain('MANGO')
      await expect
        .poll(() => notices(fake), { timeout: A_REAL_MODEL_TURN_MS })
        .toContainEqual(expect.stringMatching(/^🔔 .+ finished\.$/))
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

  // CC§14
  test('a real Claude session in a conductor’s care, its command dialog in its very first turn relayed to the channel with the hook waiting, is answered "1" at the Mac: Koloft lets the hook go once the command ran, and the session goes on', async ({
    env
  }) => {
    test.skip(!HAVE_REAL_CLAUDE, NEEDS_REAL_CLAUDE)
    test.setTimeout(2 * A_REAL_MODEL_TURN_MS + 120_000)
    const fake = await realClaudeConductor(env)
    seedSettings(env, { skipPermissions: false })
    fs.writeFileSync(
      path.join(env.home, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { defaultMode: 'default' } })
    )
    await withConductor(env, fake, async (_app, page) => {
      const target = await liveClaudeTab(page)
      expect(saidBy(env, target.sessionId, 'user')).toEqual([])
      await expect.poll(() => fs.existsSync(answerableMarker(env, target.tabId))).toBe(true)
      await typePrompt(
        page,
        target.tabId,
        'Run exactly this shell command with the Bash tool: touch mac-yes.txt — then reply with only the word DONE.'
      )
      const hookPid = await dialogHookWaiting(env, target.tabId)
      await expect
        .poll(() => notices(fake), { timeout: 30_000 })
        .toContainEqual(expect.stringMatching(/^❓ .+ is waiting for you: Bash asks to run:$/))
      expect(said(fake).join('\n')).toContain('touch mac-yes.txt')
      await expect
        .poll(() => terminalText(page, target.tabId), { timeout: 30_000 })
        .toMatch(/1\. Yes/)

      await page.evaluate((id) => window.api.terminal.write(id, '1'), target.tabId)
      await expect
        .poll(() => fs.existsSync(path.join(env.workspaces.a, 'mac-yes.txt')), { timeout: 30_000 })
        .toBe(true)
      await dialogHookLetGo(env, target.tabId, hookPid)
      await expect
        .poll(() => saidBy(env, target.sessionId, 'assistant').join('\n'), {
          timeout: A_REAL_MODEL_TURN_MS
        })
        .toContain('DONE')
    })
  })

  // CC§14
  test('a real Claude session in a conductor’s care, its question relayed to the channel with the hook waiting, is answered "2" at the Mac: Koloft lets the hook go, and a later /exit takes the row off the list', async ({
    env
  }) => {
    test.skip(!HAVE_REAL_CLAUDE, NEEDS_REAL_CLAUDE)
    test.setTimeout(2 * A_REAL_MODEL_TURN_MS + 120_000)
    const fake = await realClaudeConductor(env)
    await withConductor(env, fake, async (_app, page) => {
      const target = await liveClaudeTab(page)
      await expect.poll(() => fs.existsSync(answerableMarker(env, target.tabId))).toBe(true)
      await typePrompt(
        page,
        target.tabId,
        'Use the AskUserQuestion tool once to ask me which colour I prefer, with exactly two options, Red and Green. Then reply with only the colour I picked.'
      )
      const hookPid = await dialogHookWaiting(env, target.tabId)
      await expect
        .poll(() => terminalText(page, target.tabId), { timeout: 30_000 })
        .toMatch(/2\. Green[\s\S]*Type something/)

      await page.evaluate((id) => window.api.terminal.write(id, '2'), target.tabId)
      await expect
        .poll(() => toolResults(env, target.sessionId).join('\n'), { timeout: 30_000 })
        .toMatch(/Green/)
      await dialogHookLetGo(env, target.tabId, hookPid)
      await expect
        .poll(() => saidBy(env, target.sessionId, 'assistant').filter(Boolean).at(-1), {
          timeout: A_REAL_MODEL_TURN_MS
        })
        .toMatch(/Green/)

      const rowsBefore = await wsRows(page, 'ws-a').count()
      await expect
        .poll(() => terminalText(page, target.tabId), { timeout: 30_000 })
        .toMatch(CLAUDE_INPUT_READY)
      await typeLine(page, target.tabId, '/exit')
      await expect(wsRows(page, 'ws-a')).toHaveCount(rowsBefore - 1, { timeout: 30_000 })
    })
  })

  test('slash commands on the real Claude: the owner’s "/context" runs in the conductor and its report reaches the channel; /compact picked in Discord compacts a session and posts Compacted', async ({
    env
  }) => {
    test.skip(!HAVE_REAL_CLAUDE, NEEDS_REAL_CLAUDE)
    test.setTimeout(3 * A_REAL_MODEL_TURN_MS + 120_000)
    const fake = await realClaudeConductor(env)
    await withConductor(env, fake, async (_app, page) => {
      await answersWholeInTheChannel(fake)
      fake.say(OWNER, '/context')
      await expect
        .poll(() => ran(fake), { timeout: A_REAL_MODEL_TURN_MS })
        .toContainEqual(expect.stringMatching(/conductor ran \/context:\n## Context Usage/))

      const child = await liveClaudeTab(page)
      await typePrompt(page, child.tabId, 'Say the word MANGO and nothing else.')
      await expect
        .poll(() => saidBy(env, child.sessionId, 'assistant').join('\n'), {
          timeout: A_REAL_MODEL_TURN_MS
        })
        .toContain('MANGO')
      fake.interact(OWNER, 'compact', { session: child.sessionId })
      await expect
        .poll(() => ran(fake).at(-1), { timeout: A_REAL_MODEL_TURN_MS })
        .toMatch(/ran \/compact:\nCompacted/)
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
        .toEqual([expect.stringMatching(/conductor ran \/compact:\nDone\.$/)])
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
        (s) => s.alive && s.conductor
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
          /❓ .+\n1\. Red\b.*\n2\. Green\b.*\n\nReply with the number or the name of one option\./
        )
      const before = said(fake).length
      const green = fake.say(OWNER, 'Green')
      await expect
        .poll(() => repliesAfter(fake, before).join('\n'), { timeout: A_REAL_MODEL_TURN_MS })
        .toMatch(/Green/)
      expect(fake.reactions).toContainEqual({ messageId: green, emoji: '✅', on: true })
    })
  })
})
