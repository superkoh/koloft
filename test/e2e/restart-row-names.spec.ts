import fs from 'fs'
import path from 'path'
import { DatabaseSync } from 'node:sqlite'
import type { Locator, Page } from '@playwright/test'
import { test, expect, quitAndClose } from './helpers/app'
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
import { untilTheActiveTabsTranscriptIsWritten } from './helpers/restartNoAccount'
import { launch, openTabsFile, theOpenTabAsKoloftSavedIt } from './helpers/restartTabs'
import { BACKEND_LABEL } from '../../src/shared/sessionBackend'
import { SIGN_IN_FOLDER_OF, type SignInBackend } from '../../src/shared/types'

const NAME_GIVEN_OUTSIDE_KOLOFT = 'renamed outside Koloft'

const START: Record<SignInBackend, (page: Page, wsName: string) => Promise<void>> = {
  codex: (page, wsName) => newSessionInWith(page, wsName, 'Codex'),
  agy: async (page, wsName) => {
    await newSessionInWith(page, wsName, 'Antigravity')
    await agyReady(page)
    await runIn(page, centerTerm(page), 'first words')
    await agyConversationOnceFirstTurnEnded(page)
  }
}

function renameEveryAgyConversation(env: E2EEnv, remote: boolean): void {
  const gemini = remote ? path.join(machineHome(env), '.gemini') : ownersGemini(env)
  const db = new DatabaseSync(path.join(gemini, 'antigravity-cli', 'conversation_summaries.db'))
  try {
    const { changes } = db
      .prepare('UPDATE conversation_summaries SET title = ?')
      .run(NAME_GIVEN_OUTSIDE_KOLOFT)
    expect(changes).toBeGreaterThan(0)
  } finally {
    db.close()
  }
}

interface AgentsOwnName {
  name: string
  renameWhileItsTabIsOpen?: (env: E2EEnv, remote: boolean) => void
  renameWhileKoloftIsClosed?: (env: E2EEnv, remote: boolean) => void
}

const NAMED_BY_THE_AGENT: Record<SignInBackend, AgentsOwnName> = {
  codex: {
    name: NAME_GIVEN_OUTSIDE_KOLOFT,
    renameWhileItsTabIsOpen: (env, remote) =>
      fs.writeFileSync(
        path.join(remote ? machineHome(env) : env.home, 'fake-codex-renamed-elsewhere'),
        NAME_GIVEN_OUTSIDE_KOLOFT
      )
  },
  agy: { name: NAME_GIVEN_OUTSIDE_KOLOFT, renameWhileKoloftIsClosed: renameEveryAgyConversation }
}

const COMMAND_ENV: Record<SignInBackend, string> = {
  codex: 'KOLOFT_CODEX_CMD',
  agy: 'KOLOFT_AGY_CMD'
}

test.afterEach(({ env }) => killFakeRemote(env))

for (const backend of Object.keys(SIGN_IN_FOLDER_OF) as SignInBackend[]) {
  for (const remote of [false, true]) {
    const label = BACKEND_LABEL[backend] as AgentName
    const where = remote ? 'a remote (ssh)' : 'a local'
    const unread = remote ? 'its machine cannot be reached' : 'the agent cannot be run'
    test(`${where} ${label} session keeps the name its agent's list gave it, on its row and in the toast about reopening its tab, when Koloft starts again and ${unread}`, async ({
      env
    }) => {
      test.setTimeout(300_000)
      if (remote) OTHER_AGENTS_ON_THE_MACHINE.find((a) => a.label === label)!.install(env)
      else installAgentFor(env, label, env.workspaces.a)
      seedSettings(env, { hintsOff: true })
      const wsName = remote ? REMOTE_WS_NAME : 'ws-a'
      const title = (page: Page): Locator => wsRows(page, wsName).first().locator('.ws-tab-title')
      const named = NAMED_BY_THE_AGENT[backend]

      const first = remote ? await launchWithRemote(env) : await launch(env)
      let savedOpenTabs = ''
      try {
        await waitBooted(first.page)
        if (remote) await addRemoteWorkspace(first.page, env)
        await START[backend](first.page, wsName)
        const sessionId = await untilTheActiveTabsTranscriptIsWritten(first.page, 90_000)
        const row = wsRows(first.page, wsName).first()
        await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
        savedOpenTabs = await theOpenTabAsKoloftSavedIt(env, sessionId)
        named.renameWhileItsTabIsOpen?.(env, remote)
        await sendShortcut(first.app, 'shortcut:close-tab')
        await expect(row).toHaveClass(/\bcold\b/, { timeout: 60_000 })
        if (!named.renameWhileKoloftIsClosed)
          await expect(title(first.page)).toHaveText(named.name, { timeout: 60_000 })
      } finally {
        await quitAndClose(first.app)
      }
      if (named.renameWhileKoloftIsClosed) {
        named.renameWhileKoloftIsClosed(env, remote)
        const listed = await launch(env)
        try {
          await waitBooted(listed.page)
          await expect(title(listed.page)).toHaveText(named.name, { timeout: 60_000 })
        } finally {
          await quitAndClose(listed.app)
        }
      }
      if (remote) breakConnection(env)
      else env.launchEnv[COMMAND_ENV[backend]] = path.join(env.fakeBin, 'no-such-agent')
      fs.writeFileSync(openTabsFile(env), savedOpenTabs)

      const { app, page } = await launch(env)
      try {
        await expect(
          page
            .locator('.toast-msg')
            .filter({ hasText: new RegExp(`^\\s*Could not start “${named.name}” — `) })
        ).toBeVisible({ timeout: 90_000 })
        await waitBooted(page)
        await expect(title(page)).toHaveText(named.name, { timeout: 30_000 })
      } finally {
        await quitAndClose(app)
      }
    })
  }
}
