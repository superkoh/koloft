import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  agySessionCalls,
  E2E_CLAUDE_ACCOUNT,
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
import { codexCalls, fakeCodexLog } from './helpers/codex'
import {
  agyConversationOnceFirstTurnEnded,
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
import { ONLY_ACCOUNT, untilTheActiveTabsTranscriptIsWritten } from './helpers/restartNoAccount'
import { BACKEND_LABEL } from '../../src/shared/sessionBackend'
import { SIGN_IN_FOLDER_OF, type AccountKind, type BackendId } from '../../src/shared/types'

const NO_ACCOUNT_CAN_BE_USED: Record<BackendId, string> = {
  claude: 'No Claude account can be used — check Settings ▸ Accounts.',
  codex: 'No Codex account can be used — check Settings ▸ Accounts.',
  muse: 'No Muse account can be used — check Settings ▸ Accounts.',
  agy: 'No Antigravity account can be used — check Settings ▸ Accounts.'
}

const FIRST_PROMPT = 'first words'

const START: Record<BackendId, (page: Page, wsName: string) => Promise<void>> = {
  claude: (page, wsName) => startSessionIn(page, wsName),
  codex: (page, wsName) => newSessionInWith(page, wsName, 'Codex'),
  muse: async (page, wsName) => {
    const row = wsRows(page, wsName).first()
    await newSessionInWith(page, wsName, 'Muse')
    await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
    await runIn(page, centerTerm(page), FIRST_PROMPT)
    await expect(row.locator('.ws-tab-title')).toHaveText(FIRST_PROMPT, { timeout: 60_000 })
    await expect(row.locator('.ws-tab-unread')).toHaveCount(1, { timeout: 60_000 })
  },
  agy: async (page, wsName) => {
    await newSessionInWith(page, wsName, 'Antigravity')
    await agyReady(page)
    await runIn(page, centerTerm(page), FIRST_PROMPT)
    await agyConversationOnceFirstTurnEnded(page)
  }
}

interface CodexServerCall {
  argv: string[]
  tabId: string | null
}

const SERVER_CALLS = 'fake-codex-server-calls.jsonl'

const LOCAL_LAUNCHES: Record<BackendId, (env: E2EEnv) => number> = {
  claude: (env) => readCalls(env).length,
  codex: (env) =>
    codexCalls(env).length +
    fakeCodexLog<CodexServerCall>(env, SERVER_CALLS).filter((c) => c.tabId).length,
  muse: (env) => museCalls(env).length,
  agy: (env) => agySessionCalls(env).length
}

const REMOTE_LAUNCHES: Record<Exclude<BackendId, 'claude'>, (env: E2EEnv) => number> = {
  codex: (env) =>
    codexCalls(env).length +
    machineCodexLog<CodexServerCall>(env, SERVER_CALLS).filter((c) => c.argv.includes('--listen'))
      .length,
  muse: (env) => machineMuseCalls(env).length,
  agy: (env) => machineAgyCalls(env).length
}

interface TabKind {
  backend: BackendId
  remote: boolean
  install: (env: E2EEnv) => void
  launches: (env: E2EEnv) => number
}

const backendOf = (agent: AgentName): BackendId =>
  (Object.keys(BACKEND_LABEL) as BackendId[]).find((b) => BACKEND_LABEL[b] === agent)!

const TAB_KINDS: TabKind[] = [
  ...(Object.keys(BACKEND_LABEL) as BackendId[]).map((backend) => ({
    backend,
    remote: false,
    install: (env: E2EEnv) =>
      installAgentFor(env, BACKEND_LABEL[backend] as AgentName, env.workspaces.a),
    launches: LOCAL_LAUNCHES[backend]
  })),
  ...OTHER_AGENTS_ON_THE_MACHINE.map((agent) => {
    const backend = backendOf(agent.label) as Exclude<BackendId, 'claude'>
    return { backend, remote: true, install: agent.install, launches: REMOTE_LAUNCHES[backend] }
  })
]

const itsOnlyAccount = (backend: BackendId): { name: string; kind: AccountKind } =>
  backend === 'claude'
    ? { name: E2E_CLAUDE_ACCOUNT, kind: 'apikey' }
    : { name: ONLY_ACCOUNT[backend], kind: SIGN_IN_FOLDER_OF[backend] }

const reopenedWhenKoloftStarts = (kind: TabKind): boolean => kind.backend !== 'claude'

const shimRefusesInItsOwnTab = (kind: TabKind): boolean => kind.backend === 'claude'

function openTabsFile(env: E2EEnv): string {
  return path.join(env.userData, 'open-tabs.json')
}

async function theOpenTabAsKoloftSavedIt(env: E2EEnv, sessionId: string): Promise<string> {
  let saved = ''
  await expect
    .poll(
      () => {
        try {
          saved = fs.readFileSync(openTabsFile(env), 'utf8')
          const tabs = (JSON.parse(saved) as { tabs: { sessionId: string; asleep?: boolean }[] })
            .tabs
          return tabs.length === 1 && tabs[0].sessionId === sessionId && !tabs[0].asleep
        } catch {
          return false
        }
      },
      { timeout: 30_000 }
    )
    .toBe(true)
  return saved
}

async function launch(env: E2EEnv): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

const asLiteralRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

function toastReading(page: Page, text: string): Locator {
  return page.locator('.toast-msg').filter({ hasText: new RegExp(`^${asLiteralRegex(text)}$`) })
}

test.afterEach(({ env }) => killFakeRemote(env))

for (const kind of TAB_KINDS) {
  const name = `${kind.remote ? 'a remote (ssh)' : 'a local'} ${BACKEND_LABEL[kind.backend]}`
  const reopenToo = reopenedWhenKoloftStarts(kind)
    ? ', and so does reopening its tab when Koloft starts again, naming the session'
    : ''
  test(`with no usable account, clicking the cold row of ${name} session says why in the toast and starts nothing${reopenToo}`, async ({
    env
  }) => {
    test.setTimeout(300_000)
    kind.install(env)
    seedSettings(env, { hintsOff: true })
    const wsName = kind.remote ? REMOTE_WS_NAME : 'ws-a'
    const row = (page: Page): Locator => wsRows(page, wsName).first()
    const why = NO_ACCOUNT_CAN_BE_USED[kind.backend]
    const account = itsOnlyAccount(kind.backend)

    const first = kind.remote ? await launchWithRemote(env) : await launch(env)
    let savedOpenTabs = ''
    let title = ''
    try {
      await waitBooted(first.page)
      if (kind.remote) await addRemoteWorkspace(first.page, env)
      await START[kind.backend](first.page, wsName)
      const sessionId = await untilTheActiveTabsTranscriptIsWritten(first.page, 90_000)
      await expect(row(first.page)).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      if (reopenedWhenKoloftStarts(kind))
        savedOpenTabs = await theOpenTabAsKoloftSavedIt(env, sessionId)
      await sendShortcut(first.app, 'shortcut:close-tab')
      await expect(row(first.page)).toHaveClass(/\bcold\b/, { timeout: 60_000 })
      title = await row(first.page).locator('.ws-tab-title').innerText()
      await first.page.evaluate(([n, k]) => window.api.accounts.toggle(n, k, false), [
        account.name,
        account.kind
      ] as const)
    } finally {
      await quitAndClose(first.app)
    }
    const launchedBefore = kind.launches(env)
    if (reopenedWhenKoloftStarts(kind)) fs.writeFileSync(openTabsFile(env), savedOpenTabs)

    const { app, page } = await launch(env)
    try {
      if (reopenedWhenKoloftStarts(kind)) {
        await expect(toastReading(page, `Could not start “${title}” — ${why}`)).toBeVisible({
          timeout: 90_000
        })
        expect(kind.launches(env)).toBe(launchedBefore)
      }
      await waitBooted(page)
      await expect(row(page)).toHaveClass(/\bcold\b/, { timeout: 60_000 })

      await row(page).click()
      await expect(toastReading(page, why)).toBeVisible({ timeout: 60_000 })
      expect(kind.launches(env)).toBe(launchedBefore)
      if (shimRefusesInItsOwnTab(kind))
        await expect(centerTerm(page)).toContainText(`[Koloft] ${why}`)
      else await expect(row(page)).toHaveClass(/\bcold\b/)
    } finally {
      await quitAndClose(app)
    }
  })
}
