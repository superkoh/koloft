import fs from 'fs'
import http from 'http'
import type { AddressInfo } from 'net'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, quitAndClose } from './helpers/app'
import {
  addKeychainEntry,
  agyCalls,
  agySessionCalls,
  installAgyWithNoAccount,
  installCodex,
  seedSettings,
  signInAgyWithGoogle,
  trustInAgy,
  type AgyCall,
  type E2EEnv
} from './helpers/env'
import {
  agyReady,
  installCodexOnFakeRemote,
  installRemoteAgy,
  killFakeRemote,
  launchWithRemote,
  machineAgyCalls,
  machineCodexLog,
  REMOTE_WS_NAME,
  seedRemoteWorkspace
} from './helpers/remote'
import { fakeCodexLog } from './helpers/codex'
import {
  agyConversationOnceFirstTurnEnded,
  centerTerm,
  newSessionInWith,
  openMenu,
  openSessionTerminal,
  panelTerm,
  runIn,
  sendShortcut,
  wsRows,
  type AgentName
} from './helpers/p1'
import { untilTheActiveTabsTranscriptIsWritten } from './helpers/restartNoAccount'

test.setTimeout(240_000)

const PINNED = path.join(__dirname, 'account-per-tab')
const HERE = 'ws-a'
const THERE = REMOTE_WS_NAME
const A_LAUNCH_IS_LOGGED_WITHIN_MS = 60_000

const KEYCHAIN_OF_A_DEV_BUILD = {
  oauth: 'koloft-dev-claude-oauth',
  apikey: 'koloft-dev-anthropic-api',
  custom: 'koloft-dev-custom-endpoint',
  'agy-home': 'koloft-dev-agy-home'
} as const

type Kind = 'oauth' | 'apikey' | 'custom' | 'codex-home' | 'agy-home'

interface Seeded {
  name: string
  kind: Kind
  enabled: boolean
  fable: string
  status: string
  addedAt: number
  baseUrl?: string
  model?: string
}

const account = (name: string, kind: Kind, extra: Partial<Seeded> = {}): Seeded => ({
  name,
  kind,
  enabled: true,
  fable: 'unknown',
  status: 'ok',
  addedAt: 1,
  ...extra
})

function claudeAccount(env: E2EEnv, a: Seeded, secret: string): Seeded {
  addKeychainEntry(
    env,
    KEYCHAIN_OF_A_DEV_BUILD[a.kind as 'oauth' | 'apikey' | 'custom'],
    a.name,
    secret
  )
  return a
}

function codexAccount(env: E2EEnv, name: string, auth: Record<string, unknown>): Seeded {
  const home = path.join(env.userData, 'codex-homes', name)
  fs.mkdirSync(home, { recursive: true })
  fs.writeFileSync(path.join(home, 'auth.json'), JSON.stringify(auth), { mode: 0o600 })
  return account(name, 'codex-home')
}

const signedInToCodex = (name: string, usedPercent = 10): Record<string, unknown> => ({
  usedPercent,
  tokens: { access_token: `made-up-access-token-of-${name}`, account_id: name }
})

const codexKey = (name: string): Record<string, unknown> => ({
  auth_mode: 'apikey',
  OPENAI_API_KEY: `made-up-openai-key-of-${name}`
})

function agyGoogleAccount(env: E2EEnv, name: string): Seeded {
  signInAgyWithGoogle(env, name)
  return account(name, 'agy-home')
}

function agyKeyAccount(env: E2EEnv, name: string): Seeded {
  const cache = path.join(env.userData, 'agy-homes', name, 'antigravity-cli', 'cache')
  fs.mkdirSync(cache, { recursive: true })
  fs.writeFileSync(
    path.join(cache, 'onboarding.json'),
    JSON.stringify({ onboardingComplete: true })
  )
  addKeychainEntry(env, KEYCHAIN_OF_A_DEV_BUILD['agy-home'], name, `made-up-gemini-key-of-${name}`)
  return account(name, 'agy-home')
}

function withTheAgents(env: E2EEnv, remote: boolean): void {
  if (remote) {
    installCodexOnFakeRemote(env)
    installRemoteAgy(env)
    seedRemoteWorkspace(env)
  } else installCodex(env)
  installAgyWithNoAccount(env)
  trustInAgy(env, env.workspaces.a)
}

function onlyTheseAccounts(
  env: E2EEnv,
  accounts: Seeded[],
  extra: Record<string, unknown> = {}
): void {
  seedSettings(env, { accounts, hintsOff: true, ...extra })
}

async function launch(env: E2EEnv): Promise<{ app: ElectronApplication; page: Page }> {
  return launchWithRemote(env)
}

interface ClaudeCall {
  argv: string[]
  cwd: string
  sessionId: string
  account: Record<string, string>
}

function jsonl<T>(file: string): T[] {
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as T)
}

const claudeCalls = (env: E2EEnv): ClaudeCall[] =>
  jsonl<ClaudeCall>(env.claudeCalls).filter(
    (c) => path.basename(path.dirname(c.cwd)) !== 'conductors'
  )

const assistCalls = (env: E2EEnv): { account: Record<string, string> }[] =>
  jsonl(path.join(env.home, 'fake-claude-print-calls.jsonl'))

interface CodexServer {
  argv: string[]
  codexHome: string
  tabId: string | null
}

const codexServersHere = (env: E2EEnv): CodexServer[] =>
  fakeCodexLog<CodexServer>(env, 'fake-codex-server-calls.jsonl').filter((c) => c.tabId)

interface CodexLogin {
  type: string
  accessToken: string | null
  accountId: string | null
  apiKey?: string
}

const codexLoginsThere = (env: E2EEnv): CodexLogin[] =>
  machineCodexLog<CodexLogin>(env, 'fake-codex-logins.jsonl')

async function afterOneMore<T>(
  page: Page,
  records: () => T[],
  start: () => Promise<void>
): Promise<T> {
  const before = records().length
  const notices = new Set<string>()
  await start()
  try {
    await expect
      .poll(
        async () => {
          for (const n of await page.locator('.toast-msg').allInnerTexts()) notices.add(n)
          return records().length
        },
        { timeout: A_LAUNCH_IS_LOGGED_WITHIN_MS }
      )
      .toBeGreaterThan(before)
  } catch (error) {
    const screen = await centerTerm(page)
      .innerText()
      .catch(() => '')
    throw new Error(
      `${(error as Error).message}\nnotices: ${[...notices].join(' | ')}\nscreen:\n${screen.slice(-1500)}`
    )
  }
  return records()[before]
}

const sorted = (o: Record<string, unknown>): string[] =>
  Object.keys(o)
    .sort()
    .map((k) => `  ${k}=${String(o[k])}`)

function ofClaude(c: ClaudeCall): string[] {
  return [
    `  skips permissions: ${c.argv.includes('--dangerously-skip-permissions') ? 'yes' : 'no'}`,
    `  --model on its line: ${c.argv.includes('--model') ? c.argv[c.argv.indexOf('--model') + 1] : '(none)'}`,
    '  its account environment:',
    ...sorted(c.account).map((l) => `  ${l}`)
  ]
}

const ofCodexHere = (s: CodexServer): string[] => [`  its server's CODEX_HOME=${s.codexHome}`]

const ofCodexThere = (l: CodexLogin): string[] => [
  "  the machine's server is signed in with:",
  ...sorted(l as unknown as Record<string, unknown>).map((x) => `  ${x}`)
]

const ofAgy = (c: AgyCall): string[] => [
  `  --gemini_dir=${c.geminiDir}`,
  `  ANT_ACCOUNT=${c.env.ANT_ACCOUNT ?? '(none)'}`,
  `  GEMINI_API_KEY is set: ${c.env.GEMINI_API_KEY ? 'yes' : 'no'}`
]

async function newSessionOf(page: Page, ws: string, agent: AgentName): Promise<void> {
  await expect(wsRows(page, ws).and(page.locator('.st-pending'))).toHaveCount(0, {
    timeout: 60_000
  })
  const rows = wsRows(page, ws)
  const before = await rows.count()
  await newSessionInWith(page, ws, agent)
  await expect(rows).toHaveCount(before + 1, { timeout: 30_000 })
}

const START = {
  claude: (page: Page, ws: string) => newSessionOf(page, ws, 'Claude'),
  codex: (page: Page, ws: string) => newSessionOf(page, ws, 'Codex'),
  agy: (page: Page, ws: string) => newSessionOf(page, ws, 'Antigravity')
}

interface Table {
  rows: string[]
  cell(title: string, lines: string[]): void
}

function table(env: E2EEnv): Table {
  const rows: string[] = []
  return {
    rows,
    cell: (title, lines) =>
      rows.push(`=== ${title} ===`, ...lines.map((l) => sameOnEveryRun(env, l)))
  }
}

const SESSION_ID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

function sameOnEveryRun(env: E2EEnv, text: string): string {
  return text.replaceAll(env.home, '<home>').replace(SESSION_ID, '<id>')
}

function pin(rows: string[], name: string): void {
  const file = path.join(PINNED, `${name}.txt`)
  const text = rows.join('\n') + '\n'
  if (!fs.existsSync(file)) {
    fs.mkdirSync(PINNED, { recursive: true })
    fs.writeFileSync(file, text)
  }
  expect(text).toBe(fs.readFileSync(file, 'utf8'))
}

test.describe('which account each kind of tab starts on, with which environment and arguments, for every kind of account — the end-to-end half of the table, through the entry file’s own wiring', () => {
  test.afterEach(({ env }) => killFakeRemote(env))

  test('a subscription of each agent: Claude Code signed in, Codex signed in, Antigravity signed in with Google — on this Mac and over SSH, Koloft set to skip permissions', async ({
    env
  }) => {
    withTheAgents(env, true)
    onlyTheseAccounts(
      env,
      [
        claudeAccount(env, account('made-up-pro', 'oauth'), 'made-up-oauth-token-of-made-up-pro'),
        codexAccount(env, 'made-up-codex', signedInToCodex('made-up-codex')),
        agyGoogleAccount(env, 'made-up-gemini')
      ],
      { skipPermissions: true }
    )
    const { app, page } = await launch(env)
    const t = table(env)
    try {
      for (const ws of [HERE, THERE]) {
        const where = ws === HERE ? 'on this Mac' : 'over SSH'
        t.cell(
          `Claude Code ${where}`,
          ofClaude(
            await afterOneMore(
              page,
              () => claudeCalls(env),
              () => START.claude(page, ws)
            )
          )
        )
        t.cell(
          `Codex ${where}`,
          ws === HERE
            ? ofCodexHere(
                await afterOneMore(
                  page,
                  () => codexServersHere(env),
                  () => START.codex(page, ws)
                )
              )
            : ofCodexThere(
                await afterOneMore(
                  page,
                  () => codexLoginsThere(env),
                  () => START.codex(page, ws)
                )
              )
        )
        t.cell(
          `Antigravity ${where}`,
          ofAgy(
            await afterOneMore(
              page,
              () => (ws === HERE ? agySessionCalls(env) : machineAgyCalls(env)),
              () => START.agy(page, ws)
            )
          )
        )
      }
      await expect
        .poll(() => assistCalls(env).length, { timeout: A_LAUNCH_IS_LOGGED_WITHIN_MS })
        .toBeGreaterThan(0)
      t.cell('Assist’s one-shot claude -p (the title of a new session)', [
        '  its account environment:',
        ...sorted(assistCalls(env)[0].account).map((l) => `  ${l}`)
      ])
    } finally {
      await quitAndClose(app)
    }
    pin(t.rows, 'subscriptions')
  })

  test('a key of each agent: a Claude API key, an OpenAI API key for Codex, a Gemini API key for Antigravity — on this Mac and over SSH, and agy -p in a session’s terminal on this Mac', async ({
    env
  }) => {
    withTheAgents(env, true)
    onlyTheseAccounts(env, [
      claudeAccount(env, account('made-up-key', 'apikey'), 'made-up-anthropic-key'),
      codexAccount(env, 'made-up-codex-key', codexKey('made-up-codex-key')),
      agyKeyAccount(env, 'made-up-gemini-key')
    ])
    fs.writeFileSync(path.join(env.home, '.zprofile'), `export PATH="${env.fakeBin}:$PATH"\n`)
    const { app, page } = await launch(env)
    const t = table(env)
    try {
      for (const ws of [HERE, THERE]) {
        const where = ws === HERE ? 'on this Mac' : 'over SSH'
        t.cell(
          `Claude Code ${where}`,
          ofClaude(
            await afterOneMore(
              page,
              () => claudeCalls(env),
              () => START.claude(page, ws)
            )
          )
        )
        t.cell(
          `Codex ${where}`,
          ws === HERE
            ? ofCodexHere(
                await afterOneMore(
                  page,
                  () => codexServersHere(env),
                  () => START.codex(page, ws)
                )
              )
            : ofCodexThere(
                await afterOneMore(
                  page,
                  () => codexLoginsThere(env),
                  () => START.codex(page, ws)
                )
              )
        )
        t.cell(
          `Antigravity ${where}`,
          ofAgy(
            await afterOneMore(
              page,
              () => (ws === HERE ? agySessionCalls(env) : machineAgyCalls(env)),
              () => START.agy(page, ws)
            )
          )
        )
      }
      await wsRows(page, HERE).filter({ hasText: 'Fake session' }).click()
      await openSessionTerminal(app, page)
      const printCalls = (): AgyCall[] => agyCalls(env).filter((c) => c.argv.includes('-p'))
      t.cell(
        'agy -p typed in a session’s terminal on this Mac',
        ofAgy(
          await afterOneMore(page, printCalls, () => runIn(page, panelTerm(page), 'agy -p hello'))
        )
      )
    } finally {
      await quitAndClose(app)
    }
    pin(t.rows, 'keys')
  })

  test('a custom endpoint of Claude Code, with a model of its own and without one — on this Mac and over SSH', async ({
    env
  }) => {
    installCodex(env)
    seedRemoteWorkspace(env)
    const proxy = { baseUrl: 'https://llm-proxy.example.test/v1' }
    for (const [label, extra] of [
      ['with the model made-up-model-7b', { ...proxy, model: 'made-up-model-7b' }],
      ['with no model of its own', proxy]
    ] as const) {
      onlyTheseAccounts(env, [
        claudeAccount(env, account('made-up-proxy', 'custom', extra), 'made-up-endpoint-token')
      ])
      const { app, page } = await launch(env)
      const t = table(env)
      try {
        for (const ws of [HERE, THERE])
          t.cell(
            `Claude Code ${ws === HERE ? 'on this Mac' : 'over SSH'}, ${label}`,
            ofClaude(
              await afterOneMore(
                page,
                () => claudeCalls(env),
                () => START.claude(page, ws)
              )
            )
          )
      } finally {
        await quitAndClose(app)
      }
      pin(t.rows, `custom-endpoint-${'model' in extra ? 'with-a-model' : 'without-a-model'}`)
    }
  })

  test('restarting a session keeps the account it ran on, though two accounts of each agent have equal room and a new session would take the other — Claude Code over SSH, Codex and Antigravity on this Mac', async ({
    env
  }) => {
    withTheAgents(env, true)
    onlyTheseAccounts(env, [
      claudeAccount(env, account('made-up-left', 'oauth'), 'made-up-oauth-token-of-made-up-left'),
      claudeAccount(env, account('made-up-right', 'oauth'), 'made-up-oauth-token-of-made-up-right'),
      codexAccount(env, 'made-up-left', signedInToCodex('made-up-left')),
      codexAccount(env, 'made-up-right', signedInToCodex('made-up-right')),
      agyGoogleAccount(env, 'made-up-left'),
      agyGoogleAccount(env, 'made-up-right')
    ])
    const claudeAccountOf = (c: ClaudeCall): string =>
      `${c.account.ANT_ACCOUNT ?? '(none)'}${c.argv.includes('--resume') ? ', its line resumes the session' : ''}`
    const t = table(env)
    const { app, page } = await launch(env)
    const startThenResume = async <T>(
      records: () => T[],
      start: () => Promise<void>,
      firstTurn: () => Promise<unknown>,
      accountOf: (r: T) => string
    ): Promise<string[]> => {
      const started = await afterOneMore(page, records, start)
      await firstTurn()
      const resumed = await afterOneMore(page, records, () =>
        sendShortcut(app, 'shortcut:restart-session')
      )
      return [`  started on ${accountOf(started)}`, `  resumed on ${accountOf(resumed)}`]
    }
    try {
      t.cell(
        'Claude Code over SSH, restarted',
        await startThenResume(
          () => claudeCalls(env),
          () => START.claude(page, THERE),
          () => untilTheActiveTabsTranscriptIsWritten(page),
          claudeAccountOf
        )
      )
      t.cell(
        'Codex on this Mac, restarted',
        await startThenResume(
          () => codexServersHere(env),
          () => START.codex(page, HERE),
          () => untilTheActiveTabsTranscriptIsWritten(page),
          (s) => path.basename(s.codexHome)
        )
      )
      expect(
        await page.evaluate((ws) => window.api.cron.trusted(ws, 'agy'), env.workspaces.b)
      ).toBe(false)
      t.cell(
        'Antigravity on this Mac, after Koloft only asked once whether an account trusts a folder; restarted',
        await startThenResume(
          () => agySessionCalls(env),
          () => START.agy(page, HERE),
          async () => {
            await agyReady(page)
            await runIn(page, centerTerm(page), 'first words')
            await agyConversationOnceFirstTurnEnded(page)
          },
          (c) => path.basename(c.geminiDir)
        )
      )
    } finally {
      await quitAndClose(app)
    }
    pin(t.rows, 'resume')
  })

  test('a subscription at its limit is passed over for the next one: Claude Code by its probed usage, Codex by the limits its server reports — on this Mac', async ({
    env
  }) => {
    const probe = await startClaudeProbe({
      'made-up-oauth-token-of-made-up-full': { s5: 'rejected', u5: 1 },
      'made-up-oauth-token-of-made-up-roomy': { s5: 'allowed', u5: 0.1 }
    })
    env.launchEnv.KOLOFT_PROBE_BASE_URL = probe.base
    withTheAgents(env, false)
    onlyTheseAccounts(env, [
      claudeAccount(env, account('made-up-full', 'oauth'), 'made-up-oauth-token-of-made-up-full'),
      claudeAccount(env, account('made-up-roomy', 'oauth'), 'made-up-oauth-token-of-made-up-roomy'),
      codexAccount(env, 'made-up-full', signedInToCodex('made-up-full', 100)),
      codexAccount(env, 'made-up-roomy', signedInToCodex('made-up-roomy', 10))
    ])
    const { app, page } = await launch(env)
    const t = table(env)
    try {
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.api.accounts.list())).filter(
              (a) => a.usage || a.limits
            ).length,
          { timeout: 30_000 }
        )
        .toBe(4)
      t.cell(
        'Claude Code on this Mac',
        ofClaude(
          await afterOneMore(
            page,
            () => claudeCalls(env),
            () => START.claude(page, HERE)
          )
        )
      )
      t.cell(
        'Codex on this Mac',
        ofCodexHere(
          await afterOneMore(
            page,
            () => codexServersHere(env),
            () => START.codex(page, HERE)
          )
        )
      )
    } finally {
      await quitAndClose(app)
      await probe.close()
    }
    pin(t.rows, 'next-account-when-one-is-full')
  })

  test('with no account at all every agent’s new-session item is shut; with an account whose secret the Keychain no longer holds, Claude Code refuses to start and says why', async ({
    env
  }) => {
    withTheAgents(env, true)
    onlyTheseAccounts(env, [])
    let started = await launch(env)
    const t = table(env)
    try {
      for (const ws of [HERE, THERE]) {
        await openMenu(started.page, started.page.locator('.ws-head', { hasText: ws }))
        const items = started.page.locator('.menu .mi').filter({ hasText: /^New .* session/ })
        t.cell(
          `the new-session items of a workspace ${ws === HERE ? 'on this Mac' : 'over SSH'}`,
          (
            await items.evaluateAll((all) =>
              all.map(
                (el) =>
                  `${el.textContent?.trim()}: ${el.classList.contains('disabled') ? 'shut' : 'open'}`
              )
            )
          ).map((l) => `  ${l}`)
        )
        await started.page.keyboard.press('Escape')
      }
    } finally {
      await quitAndClose(started.app)
    }
    onlyTheseAccounts(env, [account('made-up-gone', 'oauth')])
    started = await launch(env)
    try {
      const { page } = started
      await newSessionOf(page, HERE, 'Claude')
      await expect(centerTerm(page)).toContainText('koloft:', { timeout: 30_000 })
      t.cell(
        'Claude Code on this Mac, its account’s secret gone from the Keychain',
        (await centerTerm(page).innerText())
          .split('\n')
          .filter((l) => l.startsWith('koloft:'))
          .map((l) => `  ${l}`)
      )
      const notices = new Set<string>()
      await newSessionInWith(page, THERE, 'Claude')
      await expect
        .poll(
          async () => {
            for (const n of await page.locator('.toast-msg').allInnerTexts()) notices.add(n)
            return notices.size
          },
          { timeout: 30_000 }
        )
        .toBeGreaterThan(0)
      t.cell(
        'Claude Code over SSH, its account’s secret gone from the Keychain',
        [...notices].map((n) => `  notice: ${n}`)
      )
    } finally {
      await quitAndClose(started.app)
    }
    pin(t.rows, 'no-account')
  })
})

test.describe('what each kind of account leaves in the Keychain (the test keychain file) as it is added, signed in and removed', () => {
  test('one of each kind, added the way the accounts page adds it, then each removed', async ({
    env
  }) => {
    installCodex(env)
    installAgyWithNoAccount(env)
    onlyTheseAccounts(env, [])
    addKeychainEntry(
      env,
      KEYCHAIN_OF_A_DEV_BUILD['agy-home'],
      'made-up-signed-in',
      'a-key-left-from-before'
    )
    env.launchEnv.KOLOFT_FAKE_SETUP_TOKEN = `sk-ant-oat01-${'made-up-setup-token-'.repeat(5)}`
    const { app, page } = await launch(env)
    const t = table(env)
    const keychain = (): string[] => {
      const all = JSON.parse(fs.readFileSync(env.keychainFile, 'utf8')) as Record<
        string,
        Record<string, string>
      >
      return Object.keys(all)
        .sort()
        .flatMap((svc) =>
          Object.keys(all[svc])
            .sort()
            .map((name) => `  ${svc} · ${name} = ${all[svc][name]}`)
        )
    }
    const codexKeyFile = (name: string): string[] => {
      const file = path.join(env.userData, 'codex-homes', name, 'auth.json')
      return [
        `  codex-homes/${name}/auth.json: ${fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '(none)'}`
      ]
    }
    try {
      t.cell('the keychain before', keychain())
      await page.evaluate(() =>
        Promise.all([
          window.api.accounts.add('made-up-pasted', 'oauth', 'made-up-pasted-oauth-token'),
          window.api.accounts.add('made-up-key', 'apikey', 'made-up-anthropic-key'),
          window.api.accounts.add('made-up-proxy', 'custom', 'made-up-endpoint-token', {
            baseUrl: 'https://llm-proxy.example.test/v1',
            model: 'made-up-model-7b'
          }),
          window.api.accounts.add('made-up-gemini-key', 'agy-home', 'made-up-gemini-key'),
          window.api.accounts.add('made-up-codex-key', 'codex-home', 'made-up-openai-key')
        ])
      )
      expect(
        await page.evaluate(() => window.api.accounts.startLogin('made-up-signed-in-claude'))
      ).toBe('ok')
      await expect
        .poll(() => keychain().some((l) => l.includes('made-up-signed-in-claude')), {
          timeout: 30_000
        })
        .toBe(true)
      const signIn = await page.evaluate(() =>
        window.api.accounts.signIn('agy-home', 'made-up-signed-in')
      )
      expect(signIn.ok).toBe(true)
      t.cell(
        'the keychain once each is added, Claude Code signed in, and Antigravity’s sign-in begun',
        [...keychain(), ...codexKeyFile('made-up-codex-key')]
      )
      const accounts = await page.evaluate(() => window.api.accounts.list())
      for (const a of accounts)
        await page.evaluate(([name, kind]) => window.api.accounts.remove(name, kind), [
          a.name,
          a.kind
        ] as const)
      t.cell('the keychain once every account is removed', [
        ...keychain(),
        ...codexKeyFile('made-up-codex-key')
      ])
    } finally {
      await quitAndClose(app)
    }
    pin(t.rows, 'keychain')
  })
})

interface ProbeScript {
  s5: string
  u5: number
}

async function startClaudeProbe(
  byToken: Record<string, ProbeScript>
): Promise<{ base: string; close(): Promise<void> }> {
  const nowSec = Math.floor(Date.now() / 1000)
  const server = http.createServer((req, res) => {
    const token = String(req.headers['authorization'] ?? req.headers['x-api-key'] ?? '').replace(
      /^Bearer /,
      ''
    )
    const s = byToken[token] ?? { s5: 'allowed', u5: 0.1 }
    req.resume()
    req.on('end', () => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'anthropic-ratelimit-unified-5h-utilization': String(s.u5),
        'anthropic-ratelimit-unified-5h-status': s.s5,
        'anthropic-ratelimit-unified-5h-reset': String(nowSec + 7200),
        'anthropic-ratelimit-unified-7d-utilization': '0.2',
        'anthropic-ratelimit-unified-7d-status': 'allowed',
        'anthropic-ratelimit-unified-7d-reset': String(nowSec + 200000),
        'anthropic-ratelimit-unified-7d_oi-utilization': '0.1',
        'anthropic-ratelimit-unified-7d_oi-status': 'allowed',
        'anthropic-ratelimit-unified-7d_oi-reset': String(nowSec + 200000)
      })
      res.end('{}')
    })
  })
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok))
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise((ok) => server.close(() => ok()))
  }
}
