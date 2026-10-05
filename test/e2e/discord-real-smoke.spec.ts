import fs from 'fs'
import path from 'path'
import { execFileSync } from 'child_process'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { seedSettings, type E2EEnv } from './helpers/env'
import { gitInit, startSessionIn, waitBooted } from './helpers/p1'
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

function addClaudeAccountBesideTheBotToken(env: E2EEnv): void {
  const keychain = JSON.parse(fs.readFileSync(env.keychainFile, 'utf8')) as Record<string, unknown>
  keychain['koloft-dev-claude-oauth'] = { alpha: CLAUDE_TOKEN }
  fs.writeFileSync(env.keychainFile, JSON.stringify(keychain))
}

function said(fake: FakeDiscord): string[] {
  return fake.posted.filter((p) => p.channelId === CHANNEL).map((p) => p.content)
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
  addClaudeAccountBesideTheBotToken(env)
  return fake
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
})
