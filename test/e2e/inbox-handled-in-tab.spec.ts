import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { BACKEND_LABEL, SESSION_BACKENDS } from '../../src/shared/sessionBackend'
import type { BackendId } from '../../src/shared/types'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { fakeCodexLog } from './helpers/codex'
import { installAgentFor, type E2EEnv } from './helpers/env'
import {
  centerTerm,
  newSessionInWith,
  runIn,
  terminalText,
  waitBooted,
  wsRows,
  type AgentName
} from './helpers/p1'
import {
  REMOTE_WS_NAME,
  agyReady,
  killFakeRemote,
  launchWithRemote,
  machineCodexLog
} from './helpers/remote'
import { installOnTheMachine, startRemoteTab } from './helpers/remoteTab'

const A_CASE_TAKES_MS = 240_000
const A_TAB_IS_READY_WITHIN_MS = 60_000
const A_CARD_SHOWS_WITHIN_MS = 30_000
const THE_ANSWER_LANDS_WITHIN_MS = 30_000
const THE_CARD_MOVES_TO_DONE_WITHIN_MS = 30_000
const KEYS_READ_APART_MS = 300
const QUESTION = 'asks a question'

function inboxCard(page: Page, title: string): Locator {
  return page.locator('.inbox-page .ibx-item', {
    has: page.locator('.ibx-what', { hasText: title })
  })
}

async function openInbox(page: Page): Promise<void> {
  await page.locator('.ibx-entry').click()
  await expect(page.locator('.inbox-page')).toBeVisible()
}

async function showDone(page: Page): Promise<void> {
  await page.locator('.ibx-seg button[data-tab="closed"]').click()
}

interface CodexAnswerLine {
  direction: string
  frame: { result?: { answers?: Record<string, { answers?: string[] }> } }
}

function codexPicked(env: E2EEnv, remote: boolean, pick: string): boolean {
  const read = remote ? machineCodexLog : fakeCodexLog
  return read<CodexAnswerLine>(env, 'fake-codex-wire.jsonl').some(
    (w) => w.direction === 'client' && w.frame.result?.answers?.colour?.answers?.[0] === pick
  )
}

interface Asker {
  askLine: string
  dialogOnScreen?: string
  keys: string[]
  pick: string
}

const ASKERS: Record<BackendId, Asker> = {
  claude: {
    askLine: '/ask Which colour?|Red|Green',
    dialogOnScreen: 'dialog on screen',
    keys: ['2'],
    pick: 'Green'
  },
  codex: {
    askLine: 'ask me a colour',
    dialogOnScreen: 'Which colour do you prefer?',
    keys: ['2'],
    pick: 'Green'
  },
  agy: { askLine: '/ask Which colour?|Red|Green', keys: ['2'], pick: 'Green' }
}

async function answered(
  env: E2EEnv,
  page: Page,
  tabId: string,
  backend: BackendId,
  remote: boolean
): Promise<boolean> {
  const { pick } = ASKERS[backend]
  if (backend === 'codex') return codexPicked(env, remote, pick)
  return (await terminalText(page, tabId)).includes(`Picked: ${pick}`)
}

function typeInto(page: Page, tabId: string, text: string): Promise<void> {
  return page.evaluate(([id, t]) => window.api.terminal.write(id, t), [tabId, text])
}

async function launch(
  env: E2EEnv,
  backend: BackendId,
  remote: boolean
): Promise<{ app: ElectronApplication; page: Page }> {
  if (remote) {
    installOnTheMachine(env, backend)
    return launchWithRemote(env)
  }
  installAgentFor(env, BACKEND_LABEL[backend] as AgentName, env.workspaces.a)
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await waitBooted(page)
  return { app, page }
}

async function ask(page: Page, env: E2EEnv, backend: BackendId, remote: boolean): Promise<Locator> {
  const { askLine } = ASKERS[backend]
  if (remote) {
    await typeInto(page, await startRemoteTab(page, env, backend), askLine + '\r')
    return wsRows(page, REMOTE_WS_NAME).first()
  }
  const row = wsRows(page, 'ws-a').first()
  await newSessionInWith(page, 'ws-a', BACKEND_LABEL[backend] as AgentName)
  if (backend === 'agy') {
    await agyReady(page)
    await runIn(page, centerTerm(page), askLine)
  } else {
    await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: A_TAB_IS_READY_WITHIN_MS })
    await typeInto(page, (await row.getAttribute('data-tab-id')) as string, askLine + '\r')
  }
  return row
}

const TAB_KINDS = [false, true].flatMap((remote) =>
  SESSION_BACKENDS.filter((b) => remote || b !== 'claude').map((backend) => ({ backend, remote }))
)

test.describe(() => {
  test.describe.configure({ mode: 'parallel' })
  test.setTimeout(A_CASE_TAKES_MS)
  test.afterEach(({ env }) => killFakeRemote(env))

  for (const { backend, remote } of TAB_KINDS)
    test(`a question a ${remote ? 'remote' : 'local'} ${BACKEND_LABEL[backend]} tab asks, answered in that tab instead of on its Inbox card, moves the card to Done as Handled in its tab`, async ({
      env
    }) => {
      const asker = ASKERS[backend]
      const { app, page } = await launch(env, backend, remote)
      try {
        const row = await ask(page, env, backend, remote)
        await expect(row).toHaveClass(/\bst-approval\b/, { timeout: A_TAB_IS_READY_WITHIN_MS })
        const tabId = (await row.getAttribute('data-tab-id')) as string
        await openInbox(page)
        const card = inboxCard(page, QUESTION)
        await expect(card.locator('.ibx-choice', { hasText: asker.pick })).toBeVisible({
          timeout: A_CARD_SHOWS_WITHIN_MS
        })
        if (asker.dialogOnScreen)
          await expect
            .poll(() => terminalText(page, tabId), { timeout: A_CARD_SHOWS_WITHIN_MS })
            .toContain(asker.dialogOnScreen)

        for (const [i, key] of asker.keys.entries()) {
          if (i > 0) await page.waitForTimeout(KEYS_READ_APART_MS)
          await typeInto(page, tabId, key)
        }
        await expect
          .poll(() => answered(env, page, tabId, backend, remote), {
            timeout: THE_ANSWER_LANDS_WITHIN_MS
          })
          .toBe(true)
        await expect(card).toHaveCount(0, { timeout: THE_CARD_MOVES_TO_DONE_WITHIN_MS })
        await showDone(page)
        await expect(card).toHaveCount(1)
        await expect(card.locator('.ibx-dstat')).toContainText('Handled in its tab')
      } finally {
        await quitAndClose(app)
      }
    })
})
