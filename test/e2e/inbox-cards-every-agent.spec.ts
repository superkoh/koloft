import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { SESSION_BACKENDS } from '../../src/shared/sessionBackend'
import type { BackendId } from '../../src/shared/types'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { installAgentFor } from './helpers/env'
import {
  agyConversationOnceFirstTurnEnded,
  centerTerm,
  newSessionInWith,
  runIn,
  waitBooted,
  wsRows
} from './helpers/p1'
import { agyReady, killFakeRemote, launchWithRemote, machineHome } from './helpers/remote'
import { installOnTheMachine, koloftInSession, startRemoteTab } from './helpers/remoteTab'

const ANSWER_WAITS_FOR_THE_UNDO_MS = 20_000
const A_CARD_SHOWS_WITHIN_MS = 30_000
const A_LOCAL_AGENT_CASE_TAKES_MS = 150_000
const A_REMOTE_AGENT_CASE_TAKES_MS = 240_000

const WHAT_EACH_AGENT_WAS_TOLD: Record<BackendId, string> = {
  claude: 'fake-claude-peer.jsonl',
  codex: 'fake-codex-wire.jsonl',
  agy: 'fake-agy-api.jsonl'
}

function toldTo(backend: BackendId, home: string): string {
  const file = path.join(home, WHAT_EACH_AGENT_WAS_TOLD[backend])
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

async function startLocalTab(page: Page, agent: 'Codex' | 'Antigravity'): Promise<string> {
  const row = wsRows(page, 'ws-a').first()
  await newSessionInWith(page, 'ws-a', agent)
  if (agent === 'Antigravity') {
    await agyReady(page)
    await runIn(page, centerTerm(page), 'warm up')
    await agyConversationOnceFirstTurnEnded(page)
  }
  await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
  return (await row.getAttribute('data-tab-id'))!
}

const CARD = JSON.stringify({
  title: 'Pull request 8 is ready to merge',
  level: 'high',
  blocks: [{ type: 'input', id: 'note', placeholder: 'Anything to add?' }],
  actions: [
    {
      id: 'merge',
      label: 'Merge it',
      style: 'main',
      takes: ['note'],
      run: { type: 'session', session: 'card', message: 'Merge it. {answer:note}' },
      then: { done: { state: 'in-progress', status: 'Merging' } },
      lets: ['closed']
    }
  ]
})

function inboxCard(page: Page, title: string) {
  return page.locator('.inbox-page .ibx-item', {
    has: page.locator('.ibx-what', { hasText: title })
  })
}

async function postPressAndMove(page: Page, tabId: string, told: () => string): Promise<void> {
  expect(await koloftInSession(page, tabId, `inbox add pr-8 -- '${CARD}'`)).toBe('0')
  await page.locator('.ibx-entry').click()
  const shown = inboxCard(page, 'Pull request 8 is ready to merge')
  await expect(shown.locator('.ibx-lvp')).toHaveText('High', { timeout: A_CARD_SHOWS_WITHIN_MS })
  await shown.locator('.ibx-input').fill('squash please')
  await shown.locator('.ibx-btn', { hasText: 'Merge it' }).click()
  await expect
    .poll(told, { timeout: ANSWER_WAITS_FOR_THE_UNDO_MS })
    .toMatch(
      /From Inbox: the owner pressed “Merge it” on card pr-8[\s\S]*Merge it\. «squash please»/
    )
  await expect(shown).toHaveCount(0)
  await page.locator('.ibx-seg button[data-tab="in-progress"]').click()
  await expect(inboxCard(page, 'Pull request 8')).toBeVisible()

  expect(await koloftInSession(page, tabId, `inbox move pr-8 closed -- "Merged"`)).toBe('0')
  await expect(inboxCard(page, 'Pull request 8')).toHaveCount(0)
  await page.locator('.ibx-seg button[data-tab="closed"]').click()
  await expect(inboxCard(page, 'Pull request 8').locator('.ibx-dstat')).toContainText('Merged')
}

test.describe(() => {
  test.setTimeout(A_LOCAL_AGENT_CASE_TAKES_MS)

  for (const [agent, backend] of [
    ['Codex', 'codex'],
    ['Antigravity', 'agy']
  ] as const)
    test(`a card a ${backend} session posts with koloft inbox add has a button that sends the owner’s words back to that session, and koloft inbox move from the session moves the card to Done`, async ({
      env
    }) => {
      installAgentFor(env, agent, env.workspaces.a)
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        const tabId = await startLocalTab(page, agent)
        await postPressAndMove(page, tabId, () => toldTo(backend, env.home))
      } finally {
        await quitAndClose(app)
      }
    })
})

test.describe(() => {
  test.describe.configure({ mode: 'parallel' })
  test.setTimeout(A_REMOTE_AGENT_CASE_TAKES_MS)
  test.afterEach(({ env }) => killFakeRemote(env))

  for (const backend of SESSION_BACKENDS)
    test(`a card a ${backend} session on another machine posts with koloft inbox add has a button that sends the owner’s words back to that session on the machine, and koloft inbox move from it moves the card to Done`, async ({
      env
    }) => {
      installOnTheMachine(env, backend)
      const { app, page } = await launchWithRemote(env)
      try {
        const tabId = await startRemoteTab(page, env, backend)
        await postPressAndMove(page, tabId, () => toldTo(backend, machineHome(env)))
      } finally {
        await quitAndClose(app)
      }
    })
})
