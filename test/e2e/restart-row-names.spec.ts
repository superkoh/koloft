import fs from 'fs'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { installAgentFor, ownersGemini, seedSettings, type E2EEnv } from './helpers/env'
import {
  addRemoteWorkspace,
  agyReady,
  breakConnection,
  killFakeRemote,
  launchWithRemote,
  machineHome,
  OTHER_AGENTS_ON_THE_MACHINE,
  REMOTE_WS_NAME
} from './helpers/remote'
import {
  agyConversationOnceFirstTurnEnded,
  type AgentName,
  centerTerm,
  newSessionInWith,
  runIn,
  sendShortcut,
  waitBooted,
  wsRows
} from './helpers/p1'
import {
  openTabsFile,
  theOpenTabAsKoloftSavedIt,
  untilTheActiveTabsTranscriptIsWritten
} from './helpers/restartNoAccount'
import { BACKEND_LABEL } from '../../src/shared/sessionBackend'
import type { SignInBackend } from '../../src/shared/types'

const NAME_GIVEN_OUTSIDE_KOLOFT = 'renamed outside Koloft'

const MUSE_OWN_NAME_FOR_A_SESSION_WITH_NO_PROMPT = 'fake-name'

const START: Record<SignInBackend, (page: Page, wsName: string) => Promise<void>> = {
  codex: (page, wsName) => newSessionInWith(page, wsName, 'Codex'),
  muse: (page, wsName) => newSessionInWith(page, wsName, 'Muse'),
  agy: async (page, wsName) => {
    await newSessionInWith(page, wsName, 'Antigravity')
    await agyReady(page)
    await runIn(page, centerTerm(page), 'first words')
    await agyConversationOnceFirstTurnEnded(page)
  }
}

function renameEveryCodexThread(codexHome: string, name: string): void {
  const sessions = path.join(codexHome, 'sessions')
  for (const file of fs.readdirSync(sessions).filter((n) => n.endsWith('.json'))) {
    const thread = JSON.parse(fs.readFileSync(path.join(sessions, file), 'utf8')) as {
      name: string | null
    }
    thread.name = name
    fs.writeFileSync(path.join(sessions, file), JSON.stringify(thread))
  }
}

function retitleEveryAgyConversation(gemini: string, title: string): void {
  const db = new DatabaseSync(path.join(gemini, 'antigravity-cli', 'conversation_summaries.db'))
  try {
    db.prepare('UPDATE conversation_summaries SET title = ?').run(title)
  } finally {
    db.close()
  }
}

interface AgentsOwnName {
  name: string
  giveIt: (env: E2EEnv, remote: boolean) => void
  givenWhile: 'its tab is open' | 'Koloft is closed'
}

const NAMED_BY_THE_AGENT: Record<SignInBackend, AgentsOwnName> = {
  codex: {
    name: NAME_GIVEN_OUTSIDE_KOLOFT,
    givenWhile: 'its tab is open',
    giveIt: (env, remote) =>
      renameEveryCodexThread(
        remote ? path.join(machineHome(env), '.koloft', 'codex-home') : env.launchEnv.CODEX_HOME!,
        NAME_GIVEN_OUTSIDE_KOLOFT
      )
  },
  muse: {
    name: MUSE_OWN_NAME_FOR_A_SESSION_WITH_NO_PROMPT,
    givenWhile: 'its tab is open',
    giveIt: () => undefined
  },
  agy: {
    name: NAME_GIVEN_OUTSIDE_KOLOFT,
    givenWhile: 'Koloft is closed',
    giveIt: (env, remote) =>
      retitleEveryAgyConversation(
        remote ? path.join(machineHome(env), '.gemini') : ownersGemini(env),
        NAME_GIVEN_OUTSIDE_KOLOFT
      )
  }
}

const COMMAND_ENV: Record<SignInBackend, string> = {
  codex: 'KOLOFT_CODEX_CMD',
  muse: 'KOLOFT_MUSE_CMD',
  agy: 'KOLOFT_AGY_CMD'
}

interface TabKind {
  backend: SignInBackend
  remote: boolean
  install: (env: E2EEnv) => void
  keepTheListUnread: (env: E2EEnv) => void
}

const BACKENDS = Object.keys(COMMAND_ENV) as SignInBackend[]

const TAB_KINDS: TabKind[] = [
  ...BACKENDS.map((backend) => ({
    backend,
    remote: false,
    install: (env: E2EEnv) =>
      installAgentFor(env, BACKEND_LABEL[backend] as AgentName, env.workspaces.a),
    keepTheListUnread: (env: E2EEnv) => {
      env.launchEnv[COMMAND_ENV[backend]] = path.join(env.fakeBin, 'no-such-agent')
    }
  })),
  ...BACKENDS.map((backend) => ({
    backend,
    remote: true,
    install: OTHER_AGENTS_ON_THE_MACHINE.find((a) => a.label === BACKEND_LABEL[backend])!.install,
    keepTheListUnread: breakConnection
  }))
]

async function launch(env: E2EEnv): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

test.afterEach(({ env }) => killFakeRemote(env))

for (const kind of TAB_KINDS) {
  const where = kind.remote ? 'a remote (ssh)' : 'a local'
  const unread = kind.remote ? 'its machine cannot be reached' : 'the agent cannot be run'
  test(`${where} ${BACKEND_LABEL[kind.backend]} session keeps the name its agent's list gave it, on its row and in the toast about reopening its tab, when Koloft starts again and ${unread}`, async ({
    env
  }) => {
    test.setTimeout(300_000)
    kind.install(env)
    seedSettings(env, { hintsOff: true })
    const wsName = kind.remote ? REMOTE_WS_NAME : 'ws-a'
    const title = (page: Page): Locator => wsRows(page, wsName).first().locator('.ws-tab-title')
    const named = NAMED_BY_THE_AGENT[kind.backend]

    const first = kind.remote ? await launchWithRemote(env) : await launch(env)
    let savedOpenTabs = ''
    try {
      await waitBooted(first.page)
      if (kind.remote) await addRemoteWorkspace(first.page, env)
      await START[kind.backend](first.page, wsName)
      const sessionId = await untilTheActiveTabsTranscriptIsWritten(first.page, 90_000)
      const row = wsRows(first.page, wsName).first()
      await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      savedOpenTabs = await theOpenTabAsKoloftSavedIt(env, sessionId)
      if (named.givenWhile === 'its tab is open') named.giveIt(env, kind.remote)
      await sendShortcut(first.app, 'shortcut:close-tab')
      await expect(row).toHaveClass(/\bcold\b/, { timeout: 60_000 })
      if (named.givenWhile === 'its tab is open')
        await expect(title(first.page)).toHaveText(named.name, { timeout: 60_000 })
    } finally {
      await quitAndClose(first.app)
    }
    if (named.givenWhile === 'Koloft is closed') {
      named.giveIt(env, kind.remote)
      const listed = await launch(env)
      try {
        await waitBooted(listed.page)
        await expect(title(listed.page)).toHaveText(named.name, { timeout: 60_000 })
      } finally {
        await quitAndClose(listed.app)
      }
    }
    kind.keepTheListUnread(env)
    fs.writeFileSync(openTabsFile(env), savedOpenTabs)

    const { app, page } = await launch(env)
    try {
      await expect(
        page.locator('.toast-msg').filter({ hasText: `Could not start “${named.name}” — ` })
      ).toBeVisible({ timeout: 90_000 })
      await waitBooted(page)
      await expect(title(page)).toHaveText(named.name, { timeout: 30_000 })
    } finally {
      await quitAndClose(app)
    }
  })
}
