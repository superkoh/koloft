import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  agySessionCalls,
  E2E_AGY_ACCOUNT,
  E2E_CLAUDE_ACCOUNT,
  E2E_CODEX_ACCOUNT,
  E2E_MUSE_ACCOUNT,
  installAgentFor,
  museCalls,
  seedSettings,
  type E2EEnv
} from './helpers/env'
import {
  addRemoteWorkspace,
  agyReady,
  killFakeRemote,
  launchWithRemote,
  machineAgyCalls,
  machineCodexLog,
  machineMuseCalls,
  OTHER_AGENTS_ON_THE_MACHINE,
  REMOTE_WS_NAME
} from './helpers/remote'
import { codexCalls } from './helpers/codex'
import {
  type AgentName,
  centerTerm,
  newSessionInWith,
  readCalls,
  runIn,
  sendShortcut,
  startSessionIn,
  waitBooted,
  wsRows
} from './helpers/p1'
import { noAccountMessage } from '../../src/shared/accountUsage'
import type { AccountKind, BackendId } from '../../src/shared/types'

interface TabKind {
  name: string
  agent: AgentName
  backend: BackendId
  remote: boolean
  account: { name: string; kind: AccountKind }
  reopenedAtLaunch: boolean
  install: (env: E2EEnv) => void
  launches: (env: E2EEnv) => number
}

const ONLY_ACCOUNT: Record<AgentName, TabKind['account']> = {
  Claude: { name: E2E_CLAUDE_ACCOUNT, kind: 'apikey' },
  Codex: { name: E2E_CODEX_ACCOUNT, kind: 'codex-home' },
  Muse: { name: E2E_MUSE_ACCOUNT, kind: 'muse-home' },
  Antigravity: { name: E2E_AGY_ACCOUNT, kind: 'agy-home' }
}

const BACKEND_OF: Record<AgentName, BackendId> = {
  Claude: 'claude',
  Codex: 'codex',
  Muse: 'muse',
  Antigravity: 'agy'
}

const machineCodexServers = (env: E2EEnv): number =>
  machineCodexLog<{ argv: string[] }>(env, 'fake-codex-server-calls.jsonl').filter((c) =>
    c.argv.includes('--listen')
  ).length

const LOCAL_LAUNCHES: Record<AgentName, (env: E2EEnv) => number> = {
  Claude: (env) => readCalls(env).length,
  Codex: (env) => codexCalls(env).length,
  Muse: (env) => museCalls(env).length,
  Antigravity: (env) => agySessionCalls(env).length
}

const REMOTE_LAUNCHES: Record<Exclude<AgentName, 'Claude'>, (env: E2EEnv) => number> = {
  Codex: (env) => codexCalls(env).length + machineCodexServers(env),
  Muse: (env) => machineMuseCalls(env).length,
  Antigravity: (env) => machineAgyCalls(env).length
}

const LOCAL_KINDS: TabKind[] = (['Claude', 'Codex', 'Muse', 'Antigravity'] as const).map(
  (agent) => ({
    name: `a local ${agent === 'Claude' ? 'Claude Code' : agent}`,
    agent,
    backend: BACKEND_OF[agent],
    remote: false,
    account: ONLY_ACCOUNT[agent],
    reopenedAtLaunch: agent !== 'Claude',
    install: (env) => installAgentFor(env, agent, env.workspaces.a),
    launches: LOCAL_LAUNCHES[agent]
  })
)

const REMOTE_KINDS: TabKind[] = OTHER_AGENTS_ON_THE_MACHINE.map((agent) => ({
  name: `a remote (ssh) ${agent.label}`,
  agent: agent.label,
  backend: BACKEND_OF[agent.label],
  remote: true,
  account: ONLY_ACCOUNT[agent.label],
  reopenedAtLaunch: true,
  install: agent.install,
  launches: REMOTE_LAUNCHES[agent.label]
}))

const FIRST_PROMPT = 'first words'

const wsNameOf = (kind: TabKind): string => (kind.remote ? REMOTE_WS_NAME : 'ws-a')

async function untilItsTranscriptIsWritten(page: Page): Promise<void> {
  const tabId = await page.locator('.ws .ws-tab.active').getAttribute('data-tab-id')
  await expect
    .poll(
      async () => {
        const live = await page.evaluate(() => window.api.sessions.list())
        const s = live.find((x) => x.tabId === tabId && x.sessionId)
        if (!s) return false
        return page.evaluate((id) => window.api.sessions.transcriptExists(id), s.sessionId)
      },
      { timeout: 90_000 }
    )
    .toBe(true)
}

async function startOne(page: Page, kind: TabKind): Promise<void> {
  const wsName = wsNameOf(kind)
  if (kind.agent === 'Claude') await startSessionIn(page, wsName)
  else await newSessionInWith(page, wsName, kind.agent)
  const row = wsRows(page, wsName).first()
  if (kind.agent === 'Antigravity') await agyReady(page)
  if (kind.agent === 'Muse') await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
  if (kind.agent === 'Antigravity' || kind.agent === 'Muse') {
    await runIn(page, centerTerm(page), FIRST_PROMPT)
    await expect(row.locator('.ws-tab-title')).toHaveText(FIRST_PROMPT, { timeout: 60_000 })
    await expect(row.locator('.ws-tab-unread')).toHaveCount(1, { timeout: 60_000 })
  }
  await untilItsTranscriptIsWritten(page)
  await expect(wsRows(page, wsName).first()).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
}

function openTabsFile(env: E2EEnv): string {
  return path.join(env.userData, 'open-tabs.json')
}

async function theOpenTabAsKoloftSavedIt(env: E2EEnv): Promise<string> {
  let saved = ''
  await expect
    .poll(
      () => {
        try {
          saved = fs.readFileSync(openTabsFile(env), 'utf8')
          const tabs = (JSON.parse(saved) as { tabs: { asleep?: boolean }[] }).tabs
          return tabs.length === 1 && !tabs[0].asleep
        } catch {
          return false
        }
      },
      { timeout: 30_000 }
    )
    .toBe(true)
  return saved
}

async function launchAgain(env: E2EEnv): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

async function whyNoAccount(page: Page, backend: BackendId): Promise<string> {
  const why = noAccountMessage(await page.evaluate(() => window.api.accounts.list()), backend)
  expect(why).toMatch(/^No .+ account can be used — check Settings ▸ Accounts\.$/)
  return why
}

function toastSaying(page: Page, why: string): Locator {
  return page.locator('.toast-msg').filter({ hasText: why })
}

test.afterEach(({ env }) => killFakeRemote(env))

for (const kind of [...LOCAL_KINDS, ...REMOTE_KINDS]) {
  test.describe(`resuming ${kind.name} session while no Koloft account for it can be used`, () => {
    const reopenToo = kind.reopenedAtLaunch
      ? ', and so does reopening its tab when Koloft starts again, naming the session'
      : ''
    test(`clicking its cold row says why in the toast and starts nothing${reopenToo}`, async ({
      env
    }) => {
      test.setTimeout(300_000)
      kind.install(env)
      seedSettings(env, { hintsOff: true })
      const wsName = wsNameOf(kind)
      const row = (page: Page): Locator => wsRows(page, wsName).first()

      const first = kind.remote
        ? await launchWithRemote(env)
        : await launchAgain(env).then(async (r) => (await waitBooted(r.page), r))
      let savedOpenTabs = ''
      let title = ''
      try {
        if (kind.remote) await addRemoteWorkspace(first.page, env)
        await startOne(first.page, kind)
        savedOpenTabs = await theOpenTabAsKoloftSavedIt(env)
        await sendShortcut(first.app, 'shortcut:close-tab')
        await expect(row(first.page)).toHaveClass(/\bcold\b/, { timeout: 60_000 })
        title = await row(first.page).locator('.ws-tab-title').innerText()
        await first.page.evaluate(([name, k]) => window.api.accounts.toggle(name, k, false), [
          kind.account.name,
          kind.account.kind
        ] as const)
      } finally {
        await quitAndClose(first.app)
      }
      const launchedBefore = kind.launches(env)
      if (kind.reopenedAtLaunch) fs.writeFileSync(openTabsFile(env), savedOpenTabs)

      const { app, page } = await launchAgain(env)
      try {
        const why = await whyNoAccount(page, kind.backend)
        if (kind.reopenedAtLaunch) {
          await expect(toastSaying(page, why)).toHaveText(`Could not start “${title}” — ${why}`, {
            timeout: 90_000
          })
          expect(kind.launches(env)).toBe(launchedBefore)
          await expect(toastSaying(page, why)).toHaveCount(0, { timeout: 30_000 })
        }
        await waitBooted(page)
        await expect(row(page)).toHaveClass(/\bcold\b/, { timeout: 60_000 })

        await row(page).click()
        await expect(toastSaying(page, why)).toHaveText(why, { timeout: 60_000 })
        expect(kind.launches(env)).toBe(launchedBefore)
        if (kind.agent !== 'Claude') await expect(row(page)).toHaveClass(/\bcold\b/)
      } finally {
        await quitAndClose(app)
      }
    })
  })
}
