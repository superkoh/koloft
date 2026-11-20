import fs from 'fs'
import path from 'path'
import type { Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  installAgy,
  installCodex,
  installMuse,
  trustInAgy,
  trustInMuse,
  type E2EEnv
} from './helpers/env'
import {
  centerTerm,
  newSessionInWith,
  runIn,
  startSessionIn,
  terminalText,
  waitBooted,
  wsRows,
  type AgentName
} from './helpers/p1'
import {
  OTHER_AGENTS_ON_THE_MACHINE,
  REMOTE_WS_NAME,
  addRemoteWorkspace,
  agyReady,
  installFakeRemote,
  killFakeRemote,
  machineHome
} from './helpers/remote'

const A_CASE_TAKES_MS = 240_000
const A_TAB_IS_READY_WITHIN_MS = 60_000
const A_CARD_SHOWS_WITHIN_MS = 30_000
const THE_ANSWER_LANDS_WITHIN_MS = 30_000
const KEYS_READ_APART_MS = 300

function inboxCard(page: Page, title: string | RegExp): Locator {
  return page.locator('.inbox-page .ibx-item', {
    has: page.locator('.ibx-what', { hasText: title })
  })
}

async function openInbox(page: Page): Promise<void> {
  await page.locator('.ibx-entry').click()
  await expect(page.locator('.inbox-page')).toBeVisible()
}

async function doneStatus(page: Page, title: string): Promise<Locator> {
  await page.locator('.ibx-seg button[data-tab="closed"]').click()
  return inboxCard(page, title).first().locator('.ibx-dstat')
}

function codexPicked(home: string, pick: string): boolean {
  const file = path.join(home, 'fake-codex-wire.jsonl')
  if (!fs.existsSync(file)) return false
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .some((w) => w.direction === 'client' && w.frame.result?.answers?.colour?.answers?.[0] === pick)
}

interface Asker {
  askLine: string
  keys: string[]
  pick: string
  answered: (env: E2EEnv, page: Page, tabId: string, remote: boolean) => Promise<boolean>
}

const pickedOnScreen =
  (pick: string) =>
  async (_env: E2EEnv, page: Page, tabId: string): Promise<boolean> =>
    (await terminalText(page, tabId)).includes(`Picked: ${pick}`)

const ASKERS: Record<AgentName, Asker> = {
  Claude: {
    askLine: '/ask Which colour?|Red|Green',
    keys: ['2'],
    pick: 'Green',
    answered: pickedOnScreen('Green')
  },
  Codex: {
    askLine: 'ask me a colour',
    keys: ['2'],
    pick: 'Green',
    answered: async (env, _page, _tabId, remote) =>
      codexPicked(remote ? machineHome(env) : env.home, 'Green')
  },
  Muse: {
    askLine: '/ask',
    keys: ['2', '\r'],
    pick: 'Blue',
    answered: pickedOnScreen('Blue')
  },
  Antigravity: {
    askLine: '/ask Which colour?|Red|Green',
    keys: ['2'],
    pick: 'Green',
    answered: pickedOnScreen('Green')
  }
}

function typeInto(page: Page, tabId: string, text: string): Promise<void> {
  return page.evaluate(([id, t]) => window.api.terminal.write(id, t), [tabId, text])
}

const LOCAL_INSTALL: Record<AgentName, (env: E2EEnv) => void> = {
  Claude: () => {},
  Codex: (env) => installCodex(env),
  Muse: (env) => {
    installMuse(env)
    trustInMuse(env, env.workspaces.a)
  },
  Antigravity: (env) => {
    installAgy(env)
    trustInAgy(env, env.workspaces.a)
  }
}

async function askLocally(page: Page, agent: AgentName): Promise<Locator> {
  const line = ASKERS[agent].askLine
  const row = wsRows(page, 'ws-a').first()
  if (agent === 'Claude') await startSessionIn(page, 'ws-a')
  else await newSessionInWith(page, 'ws-a', agent)
  if (agent === 'Antigravity') {
    await agyReady(page)
    await runIn(page, centerTerm(page), line)
    return row
  }
  await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: A_TAB_IS_READY_WITHIN_MS })
  await typeInto(page, (await row.getAttribute('data-tab-id')) as string, line + '\r')
  return row
}

async function askOnTheMachine(page: Page, env: E2EEnv, agent: AgentName): Promise<Locator> {
  await addRemoteWorkspace(page, env)
  if (agent === 'Claude') await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
  else {
    await newSessionInWith(page, REMOTE_WS_NAME, agent)
    await OTHER_AGENTS_ON_THE_MACHINE.find((a) => a.label === agent)!.bound?.(page)
  }
  const row = wsRows(page, REMOTE_WS_NAME).first()
  await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: A_TAB_IS_READY_WITHIN_MS })
  const line = ASKERS[agent].askLine + '\r'
  await typeInto(page, (await row.getAttribute('data-tab-id')) as string, line)
  return row
}

function installOnTheMachine(env: E2EEnv, agent: AgentName): void {
  if (agent === 'Claude') return installFakeRemote(env)
  OTHER_AGENTS_ON_THE_MACHINE.find((a) => a.label === agent)!.install(env)
  installFakeRemote(env)
}

test.describe(() => {
  test.describe.configure({ mode: 'parallel' })
  test.setTimeout(A_CASE_TAKES_MS)
  test.afterEach(({ env }) => killFakeRemote(env))

  for (const remote of [false, true])
    for (const agent of Object.keys(ASKERS) as AgentName[])
      test(`a question a ${remote ? 'remote' : 'local'} ${agent} tab asks, answered in that tab instead of on its Inbox card, moves the card to Done as Handled in its tab`, async ({
        env
      }) => {
        const asker = ASKERS[agent]
        if (remote) installOnTheMachine(env, agent)
        else LOCAL_INSTALL[agent](env)
        const app = await launchApp(env)
        try {
          const page = await app.firstWindow()
          await waitBooted(page)
          const row = remote
            ? await askOnTheMachine(page, env, agent)
            : await askLocally(page, agent)
          await expect(row).toHaveClass(/\bst-approval\b/, { timeout: A_TAB_IS_READY_WITHIN_MS })
          const tabId = (await row.getAttribute('data-tab-id')) as string
          await openInbox(page)
          await expect(
            inboxCard(page, 'asks a question').locator('.ibx-choice', { hasText: asker.pick })
          ).toBeVisible({ timeout: A_CARD_SHOWS_WITHIN_MS })

          for (const key of asker.keys) {
            await typeInto(page, tabId, key)
            await page.waitForTimeout(KEYS_READ_APART_MS)
          }
          await expect
            .poll(() => asker.answered(env, page, tabId, remote), {
              timeout: THE_ANSWER_LANDS_WITHIN_MS
            })
            .toBe(true)
          await expect(await doneStatus(page, 'asks a question')).toContainText(
            'Handled in its tab',
            { timeout: A_CARD_SHOWS_WITHIN_MS }
          )
        } finally {
          await quitAndClose(app)
        }
      })
})
