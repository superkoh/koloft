import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import type { E2EEnv } from './helpers/env'
import { newSessionInWith, terminalText, waitBooted, wsRows } from './helpers/p1'
import {
  OTHER_AGENTS_ON_THE_MACHINE,
  REMOTE_WS_NAME,
  addRemoteWorkspace,
  killFakeRemote,
  launchWithRemote,
  machineAgyApiCalls,
  machineCodexLog,
  machineHome,
  type OtherAgentName
} from './helpers/remote'
import { ASKED_BEFORE_IT_STOPPED } from '../../src/main/koloftInbox'

test.setTimeout(240_000)
test.afterEach(({ env }) => killFakeRemote(env))

type AgentOnTheMachine = (typeof OTHER_AGENTS_ON_THE_MACHINE)[number]

const ANSWER_WAITS_FOR_THE_UNDO_MS = 20_000
const ON_THE_MACHINE_WITHIN_MS = 60_000
const A_RESTARTED_TAB_ATTACHES_WITHIN_MS = 90_000
const A_CARD_SHOWS_WITHIN_MS = 30_000
const A_TURN_LONGER_THAN_ONE_MIRROR_PULL_MS = '5000'
const ASSIST_OFFERS_REPLIES = 'ACT\nQ: Merge PR #12?\n- Merge it\n- Not yet\n'

interface CodexClientFrame {
  direction: string
  frame: { result?: { answers?: Record<string, { answers: string[] }> } }
}

const codexClientFrames = (env: E2EEnv): CodexClientFrame[] =>
  machineCodexLog<CodexClientFrame>(env, 'fake-codex-wire.jsonl').filter(
    (w) => w.direction === 'client'
  )

const pickedInItsTerminal =
  (pick: string) =>
  async (_env: E2EEnv, page: Page, tabId: string): Promise<boolean> =>
    (await terminalText(page, tabId)).includes(`Picked: ${pick}`)

const ASKS: Record<
  OtherAgentName,
  {
    askLine: string
    pick: string
    answered: (env: E2EEnv, page: Page, tabId: string) => Promise<boolean>
    said: RegExp
    got: (env: E2EEnv, page: Page, tabId: string) => Promise<string>
    turnHold?: string
    questionOutlivesKoloft?: false
  }
> = {
  Codex: {
    askLine: 'ask me a colour',
    pick: 'Green',
    answered: async (env) =>
      codexClientFrames(env).some((w) => w.frame.result?.answers?.colour?.answers[0] === 'Green'),
    said: /Codex fixture answered: Shall I merge PR #12\?/,
    got: async (env) => JSON.stringify(codexClientFrames(env)),
    questionOutlivesKoloft: false
  },
  Muse: {
    askLine: '/ask',
    pick: 'Blue',
    answered: pickedInItsTerminal('Blue'),
    said: /echo: Shall I merge PR #12\?/,
    got: async (_env, page, tabId) => terminalText(page, tabId),
    turnHold: 'fake-muse-delay'
  },
  Antigravity: {
    askLine: '/ask Which colour?|Red|Green',
    pick: 'Green',
    answered: pickedInItsTerminal('Green'),
    said: /Answer to: Shall I merge PR #12\?/,
    got: async (env) => JSON.stringify(machineAgyApiCalls(env)),
    turnHold: 'fake-agy-delay'
  }
}

function inboxCard(page: Page, title: string) {
  return page.locator('.inbox-page .ibx-item', {
    has: page.locator('.ibx-what', { hasText: title })
  })
}

function cardQuoting(page: Page, words: RegExp) {
  return page.locator('.inbox-page .ibx-item', {
    has: page.locator('.ibx-quote', { hasText: words })
  })
}

async function openInbox(page: Page): Promise<void> {
  await page.locator('.ibx-entry').click()
  await expect(page.locator('.inbox-page')).toBeVisible()
}

async function showDone(page: Page): Promise<void> {
  await page.locator('.ibx-seg button[data-tab="closed"]').click()
}

function typeInto(page: Page, tabId: string, line: string): Promise<void> {
  return page.evaluate(([id, l]) => window.api.terminal.write(id, l + '\r'), [tabId, line])
}

async function launchWith(env: E2EEnv, agent: AgentOnTheMachine) {
  agent.install(env)
  return launchWithRemote(env)
}

async function startOnTheMachine(page: Page, env: E2EEnv, agent: AgentOnTheMachine) {
  await addRemoteWorkspace(page, env)
  await newSessionInWith(page, REMOTE_WS_NAME, agent.label)
  await agent.bound?.(page)
  const row = wsRows(page, REMOTE_WS_NAME).first()
  await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: ON_THE_MACHINE_WITHIN_MS })
  return { row, tabId: (await row.getAttribute('data-tab-id')) as string }
}

async function askOnTheMachine(page: Page, env: E2EEnv, agent: AgentOnTheMachine) {
  const { row, tabId } = await startOnTheMachine(page, env, agent)
  const asks = ASKS[agent.label]
  await typeInto(page, tabId, asks.askLine)
  await expect(row).toHaveClass(/\bst-approval\b/, { timeout: ON_THE_MACHINE_WITHIN_MS })
  await openInbox(page)
  const card = inboxCard(page, 'asks a question')
  const choice = card.locator('.ibx-choice', { hasText: asks.pick })
  await expect(choice).toBeVisible({ timeout: A_CARD_SHOWS_WITHIN_MS })
  return { tabId, card, choice }
}

async function askThenRestart(env: E2EEnv, agent: AgentOnTheMachine) {
  const first = await launchWith(env, agent)
  try {
    await askOnTheMachine(first.page, env, agent)
  } finally {
    await quitAndClose(first.app)
  }
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await waitBooted(page)
  return { app, page, card: inboxCard(page, 'asks a question') }
}

for (const agent of OTHER_AGENTS_ON_THE_MACHINE) {
  const asks = ASKS[agent.label]

  test(`a question a remote ${agent.label} session asks is a card in the Inbox; picking an answer there reaches the session on the machine once the 5-second undo is over, and the card moves to Done as Answered`, async ({
    env
  }) => {
    const { app, page } = await launchWith(env, agent)
    try {
      const { tabId, card, choice } = await askOnTheMachine(page, env, agent)
      await choice.click()
      await expect(card.locator('.ibx-undo')).toBeVisible()
      expect(await asks.answered(env, page, tabId)).toBe(false)
      await expect
        .poll(() => asks.answered(env, page, tabId), { timeout: ANSWER_WAITS_FOR_THE_UNDO_MS })
        .toBe(true)
      await showDone(page)
      await expect(card.locator('.ibx-dstat')).toContainText('Answered')
    } finally {
      await quitAndClose(app)
    }
  })

  test(`a finished turn of a remote ${agent.label} session the Assist offers replies for shows them as picks on its card, and one click sends the pick to the session on the machine`, async ({
    env
  }) => {
    const { app, page } = await launchWith(env, agent)
    try {
      const { tabId } = await startOnTheMachine(page, env, agent)
      fs.writeFileSync(path.join(env.home, 'fake-claude-assist-reply'), ASSIST_OFFERS_REPLIES)
      if (asks.turnHold)
        fs.writeFileSync(
          path.join(machineHome(env), asks.turnHold),
          A_TURN_LONGER_THAN_ONE_MIRROR_PULL_MS
        )
      await typeInto(page, tabId, 'Shall I merge PR #12?')
      await openInbox(page)
      const card = cardQuoting(page, asks.said)
      await expect(card.locator('.ibx-q')).toContainText('Merge PR #12?', {
        timeout: ON_THE_MACHINE_WITHIN_MS
      })
      await card.locator('.ibx-choice', { hasText: 'Not yet' }).click()
      await expect
        .poll(() => asks.got(env, page, tabId), { timeout: ANSWER_WAITS_FOR_THE_UNDO_MS })
        .toContain('Merge PR #12? «Not yet»')
      await showDone(page)
      await expect(
        inboxCard(page, 'finished and waits for you').filter({
          has: page.locator('.ibx-dstat', { hasText: 'Replied' })
        })
      ).toHaveCount(1)
    } finally {
      await quitAndClose(app)
    }
  })

  if (asks.questionOutlivesKoloft === false)
    // ADR-0039
    test(`a question a remote ${agent.label} session asked before a Koloft restart, whose turn the restart cuts off on the machine, stays in Needs you, and a pick there then reaches the resumed session as a message`, async ({
      env
    }) => {
      const { app, page, card } = await askThenRestart(env, agent)
      try {
        const row = wsRows(page, REMOTE_WS_NAME).first()
        await expect(row).toHaveClass(/\bst-waiting\b/, {
          timeout: A_RESTARTED_TAB_ATTACHES_WITHIN_MS
        })
        const tabId = (await row.getAttribute('data-tab-id')) as string
        await openInbox(page)
        await expect(card).toContainText(ASKED_BEFORE_IT_STOPPED, {
          timeout: A_CARD_SHOWS_WITHIN_MS
        })
        await card.locator('.ibx-choice', { hasText: asks.pick }).click()
        await expect
          .poll(() => asks.got(env, page, tabId), { timeout: ON_THE_MACHINE_WITHIN_MS })
          .toContain(`«${asks.pick}»`)
        await showDone(page)
        await expect(card.locator('.ibx-dstat')).toContainText('Answered')
      } finally {
        await quitAndClose(app)
      }
    })
  else
    test(`a question a remote ${agent.label} session still shows after a Koloft restart is still one card in Needs you, and picking an answer there reaches the session on the machine and moves that one card to Done as Answered`, async ({
      env
    }) => {
      const { app, page, card } = await askThenRestart(env, agent)
      try {
        const asker = wsRows(page, REMOTE_WS_NAME).first()
        await expect(asker).toHaveClass(/\bst-approval\b/, {
          timeout: A_RESTARTED_TAB_ATTACHES_WITHIN_MS
        })
        const tabId = (await asker.getAttribute('data-tab-id')) as string
        await openInbox(page)
        await card
          .locator('.ibx-choice', { hasText: asks.pick })
          .click({ timeout: A_CARD_SHOWS_WITHIN_MS })
        await expect
          .poll(() => asks.answered(env, page, tabId), { timeout: ANSWER_WAITS_FOR_THE_UNDO_MS })
          .toBe(true)
        await showDone(page)
        await expect(card).toHaveCount(1)
        await expect(card.locator('.ibx-dstat')).toContainText('Answered')
      } finally {
        await quitAndClose(app)
      }
    })
}
