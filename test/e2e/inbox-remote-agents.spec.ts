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
  installFakeRemote,
  killFakeRemote,
  machineCodexLog,
  machineHome,
  type OtherAgentName
} from './helpers/remote'
import { ASK_NO_LONGER_ON_SCREEN } from '../../src/main/koloftInbox'

test.setTimeout(240_000)
test.afterEach(({ env }) => killFakeRemote(env))

const ANSWER_WAITS_FOR_THE_UNDO_MS = 20_000
const ON_THE_MACHINE_WITHIN_MS = 60_000
const A_TURN_LONGER_THAN_ONE_MIRROR_PULL_MS = '5000'
const ASSIST_OFFERS_REPLIES = 'ACT\nQ: Merge PR #12?\n- Merge it\n- Not yet\n'

interface CodexAnswerFrame {
  direction: string
  frame: { result?: { answers?: Record<string, { answers: string[] }> } }
}

const machineText = (env: E2EEnv, name: string): string => {
  const file = path.join(machineHome(env), name)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

const ASKS: Record<
  OtherAgentName,
  {
    askLine: string
    pick: string
    answered: (env: E2EEnv, page: Page, tabId: string) => Promise<unknown>
    answer: unknown
    said: RegExp
    got: (env: E2EEnv, page: Page, tabId: string) => Promise<string>
    turnHold?: string
    questionOutlivesKoloft: boolean
  }
> = {
  Codex: {
    questionOutlivesKoloft: false,
    askLine: 'ask me a colour',
    pick: 'Green',
    answered: async (env) =>
      machineCodexLog<CodexAnswerFrame>(env, 'fake-codex-wire.jsonl')
        .filter((w) => w.direction === 'client' && w.frame.result?.answers)
        .map((w) => w.frame.result!.answers),
    answer: [{ colour: { answers: ['Green'] } }],
    said: /Codex fixture answered: Shall I merge PR #12\?/,
    got: async (env) => machineText(env, 'fake-codex-wire.jsonl')
  },
  Muse: {
    questionOutlivesKoloft: true,
    askLine: '/ask',
    pick: 'Blue',
    answered: async (_env, page, tabId) => /Picked: Blue/.test(await terminalText(page, tabId)),
    answer: true,
    said: /echo: Shall I merge PR #12\?/,
    got: async (_env, page, tabId) => terminalText(page, tabId),
    turnHold: 'fake-muse-delay'
  },
  Antigravity: {
    questionOutlivesKoloft: true,
    askLine: '/ask Which colour?|Red|Green',
    pick: 'Green',
    answered: async (_env, page, tabId) => /Picked: Green/.test(await terminalText(page, tabId)),
    answer: true,
    said: /Answer to: Shall I merge PR #12\?/,
    got: async (env) => machineText(env, 'fake-agy-api.jsonl')
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

async function startOnTheMachine(
  page: Page,
  env: E2EEnv,
  agent: (typeof OTHER_AGENTS_ON_THE_MACHINE)[number]
): Promise<string> {
  await addRemoteWorkspace(page, env)
  await newSessionInWith(page, REMOTE_WS_NAME, agent.label)
  await agent.bound?.(page)
  const row = wsRows(page, REMOTE_WS_NAME).first()
  await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: ON_THE_MACHINE_WITHIN_MS })
  return (await row.getAttribute('data-tab-id')) as string
}

async function launchWith(
  env: E2EEnv,
  agent: (typeof OTHER_AGENTS_ON_THE_MACHINE)[number]
): Promise<{ app: Awaited<ReturnType<typeof launchApp>>; page: Page }> {
  installFakeRemote(env)
  agent.install(env)
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await waitBooted(page)
  return { app, page }
}

for (const agent of OTHER_AGENTS_ON_THE_MACHINE) {
  const asks = ASKS[agent.label]

  test(`a question a remote ${agent.label} session asks is a card in the Inbox; picking an answer there reaches the session on the machine once the 5-second undo is over, and the card moves to Done as Answered`, async ({
    env
  }) => {
    const { app, page } = await launchWith(env, agent)
    try {
      const tabId = await startOnTheMachine(page, env, agent)
      await typeInto(page, tabId, asks.askLine)
      await expect(wsRows(page, REMOTE_WS_NAME).first()).toHaveClass(/\bst-approval\b/, {
        timeout: ON_THE_MACHINE_WITHIN_MS
      })
      await openInbox(page)
      const card = inboxCard(page, 'asks a question')
      await card.locator('.ibx-choice', { hasText: asks.pick }).click({ timeout: 30_000 })
      await expect(card.locator('.ibx-undo')).toBeVisible()
      await expect
        .poll(() => asks.answered(env, page, tabId), { timeout: ANSWER_WAITS_FOR_THE_UNDO_MS })
        .toEqual(asks.answer)
      await showDone(page)
      await expect(inboxCard(page, 'asks a question').locator('.ibx-dstat')).toContainText(
        'Answered'
      )
    } finally {
      await quitAndClose(app)
    }
  })

  test(`a finished turn of a remote ${agent.label} session the Assist offers replies for shows them as picks on its card, and one click sends the pick to the session on the machine`, async ({
    env
  }) => {
    fs.writeFileSync(path.join(env.home, 'fake-claude-assist-reply'), ASSIST_OFFERS_REPLIES)
    const { app, page } = await launchWith(env, agent)
    try {
      const tabId = await startOnTheMachine(page, env, agent)
      if (asks.turnHold)
        fs.writeFileSync(
          path.join(machineHome(env), asks.turnHold),
          A_TURN_LONGER_THAN_ONE_MIRROR_PULL_MS
        )
      await typeInto(page, tabId, 'Shall I merge PR #12?')
      await openInbox(page)
      const card = cardQuoting(page, asks.said)
      await expect(card.locator('.ibx-q')).toContainText('Merge PR #12?', { timeout: 60_000 })
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

  if (asks.questionOutlivesKoloft)
    test(`a question a remote ${agent.label} session still shows after a Koloft restart is still a card in Needs you, and picking an answer there reaches the session on the machine`, async ({
      env
    }) => {
      await askThenQuit(env, agent)
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        const asker = wsRows(page, REMOTE_WS_NAME).first()
        await expect(asker).toHaveClass(/\bst-approval\b/, { timeout: 90_000 })
        const tabId = (await asker.getAttribute('data-tab-id')) as string
        await openInbox(page)
        await inboxCard(page, 'asks a question')
          .locator('.ibx-choice', { hasText: asks.pick })
          .click({ timeout: 30_000 })
        await expect
          .poll(() => asks.answered(env, page, tabId), { timeout: ANSWER_WAITS_FOR_THE_UNDO_MS })
          .toEqual(asks.answer)
        await expect(inboxCard(page, 'asks a question')).toHaveCount(0)
      } finally {
        await quitAndClose(app)
      }
    })
  else
    // ADR-0039
    test(`a question a remote ${agent.label} session asked before a Koloft restart, whose turn the restart cuts off on the machine, stays in Needs you and then sends the owner to its tab`, async ({
      env
    }) => {
      await askThenQuit(env, agent)
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        await expect(wsRows(page, REMOTE_WS_NAME).first()).toHaveClass(/\bst-waiting\b/, {
          timeout: 90_000
        })
        await openInbox(page)
        const card = inboxCard(page, 'asks a question')
        await expect(card).toContainText(ASK_NO_LONGER_ON_SCREEN, { timeout: 15_000 })
        await expect(card.locator('.ibx-choice')).toHaveCount(0)
        await expect(card.locator('.ibx-btn')).toHaveText(['Dismiss'])
        await expect(card.locator('.ibx-link')).toHaveText(['Open session ›'])
      } finally {
        await quitAndClose(app)
      }
    })
}

async function askThenQuit(
  env: E2EEnv,
  agent: (typeof OTHER_AGENTS_ON_THE_MACHINE)[number]
): Promise<void> {
  const { app, page } = await launchWith(env, agent)
  try {
    const tabId = await startOnTheMachine(page, env, agent)
    await typeInto(page, tabId, ASKS[agent.label].askLine)
    await expect(wsRows(page, REMOTE_WS_NAME).first()).toHaveClass(/\bst-approval\b/, {
      timeout: ON_THE_MACHINE_WITHIN_MS
    })
    await openInbox(page)
    await expect(
      inboxCard(page, 'asks a question').locator('.ibx-choice', {
        hasText: ASKS[agent.label].pick
      })
    ).toBeVisible({ timeout: 30_000 })
  } finally {
    await quitAndClose(app)
  }
}
