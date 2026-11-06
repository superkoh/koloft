import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  installCodex,
  installMuse,
  museCalls,
  museSaid,
  trustInMuse,
  type E2EEnv
} from './helpers/env'
import {
  centerTerm,
  killSession,
  newSessionInWith,
  runIn,
  startSessionIn,
  terminalText,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'
import { REMOTE_WS_NAME, addRemoteWorkspace, installFakeRemote } from './helpers/remote'
import { ANSWER_NOT_TAKEN } from '../../src/main/koloftInbox'
import { A_TAKEN_ANSWER_SHOWS_WITHIN_MS } from '../../src/main/discord/relay'

const ANSWER_WAITS_FOR_THE_UNDO_MS = 20_000
const KEYS_READ_APART_MS = 300

function inboxCard(page: Page, title: string | RegExp) {
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

async function doneStatus(page: Page, text: string | RegExp) {
  await page.locator('.ibx-seg button[data-tab="closed"]').click()
  return inboxCard(page, text).first().locator('.ibx-dstat')
}

function typeInto(page: Page, tabId: string, line: string): Promise<void> {
  return page.evaluate(([id, l]) => window.api.terminal.write(id, l + '\r'), [tabId, line])
}

function peerMessages(env: E2EEnv): string {
  const file = path.join(env.home, 'fake-claude-peer.jsonl')
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.stringify(JSON.parse(l)))
        .join('\n')
        .replace(/\\n/g, '\n')
    : ''
}

function codexAnswers(env: E2EEnv): unknown[] {
  const file = path.join(env.home, 'fake-codex-wire.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { direction: string; frame: { result?: { decision?: string } } })
    .filter((w) => w.direction === 'client' && w.frame.result?.decision)
    .map((w) => w.frame.result)
}

for (const remote of [false, true]) {
  test(`a question a ${remote ? 'remote ' : ''}Claude Code session asks is a card in the Inbox; picking an answer there reaches the session once the 5-second undo is over, even with the owner's arrow keys left on the own-words row, and the card moves to Done as Answered`, async ({
    env
  }) => {
    if (remote) installFakeRemote(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      if (remote) await addRemoteWorkspace(page, env)
      const ws = remote ? REMOTE_WS_NAME : 'ws-a'
      await startSessionIn(page, ws, { remote })
      const row = wsRows(page, ws).first()
      await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 30_000 })
      const tabId = (await row.getAttribute('data-tab-id')) as string

      await runIn(page, centerTerm(page), '/ask Which colour?|Red|Green')
      await expect(row).toHaveClass(/\bst-approval\b/, { timeout: 30_000 })
      await expect
        .poll(() => terminalText(page, tabId), { timeout: 15_000 })
        .toContain('dialog on screen')
      for (let i = 0; i < 2; i++) {
        await page.evaluate((id) => window.api.terminal.write(id, '\x1b[B'), tabId)
        await page.waitForTimeout(KEYS_READ_APART_MS)
      }
      await openInbox(page)
      const card = inboxCard(page, 'asks a question')
      await expect(card.locator('.ibx-choice', { hasText: 'Green' })).toBeVisible({
        timeout: 10_000
      })
      await card.locator('.ibx-choice', { hasText: 'Green' }).click()
      await expect(card.locator('.ibx-undo')).toBeVisible()
      await expect
        .poll(() => terminalText(page, tabId), { timeout: ANSWER_WAITS_FOR_THE_UNDO_MS })
        .toMatch(/Picked: Green/)
      await expect(await doneStatus(page, 'asks a question')).toContainText('Answered')
    } finally {
      await quitAndClose(app)
    }
  })
}

test('a question answered in its own tab closes its Inbox card as handled there, and an undo inside the 5 seconds sends nothing', async ({
  page
}) => {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  const row = wsRows(page, 'ws-a').first()
  await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 15_000 })
  const tabId = (await row.getAttribute('data-tab-id')) as string

  await runIn(page, centerTerm(page), '/ask Which colour?|Red|Green')
  await expect(row).toHaveClass(/\bst-approval\b/, { timeout: 15_000 })
  await openInbox(page)
  const card = inboxCard(page, 'asks a question')
  await card.locator('.ibx-choice', { hasText: 'Red' }).click()
  await card.locator('.ibx-undo').click()
  await expect(card.locator('.ibx-undo')).toHaveCount(0)
  await expect(card.locator('.ibx-choice', { hasText: 'Red' })).toBeEnabled()

  await row.click()
  await expect(page.locator('.inbox-page')).toHaveCount(0)
  await centerTerm(page).click()
  await page.keyboard.press('2')
  await expect.poll(() => terminalText(page, tabId), { timeout: 15_000 }).toContain('Picked: Green')
  expect(await terminalText(page, tabId)).not.toContain('Picked: Red')
  await openInbox(page)
  await expect(await doneStatus(page, 'asks a question')).toContainText('Handled in its tab')
})

test('a card a session posts with koloft inbox shows in the Inbox; its button sends the owner’s words to that session, and the session moves the card to Done', async ({
  page,
  env
}, testInfo) => {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  const row = wsRows(page, 'ws-a').first()
  await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 15_000 })
  const tabId = (await row.getAttribute('data-tab-id')) as string
  const card = JSON.stringify({
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

  await runIn(page, centerTerm(page), `/koloft inbox add pr-8 -- '${card}'`)
  await expect
    .poll(() => terminalText(page, tabId), { timeout: 15_000 })
    .toContain('Added card pr-8.')
  await expect(page.locator('.ibx-entry .ibx-count')).toHaveText('1')
  await openInbox(page)
  const shown = inboxCard(page, 'Pull request 8 is ready to merge')
  await expect(shown.locator('.ibx-lvp')).toHaveText('High')
  await shown.locator('.ibx-input').fill('squash please')
  await page.screenshot({ path: testInfo.outputPath('inbox-page.png') })
  await shown.locator('.ibx-btn', { hasText: 'Merge it' }).click()
  await expect
    .poll(() => peerMessages(env), { timeout: ANSWER_WAITS_FOR_THE_UNDO_MS })
    .toMatch(
      /From Inbox: the owner pressed “Merge it” on card pr-8[\s\S]*Merge it\. «squash please»/
    )
  await page.locator('.ibx-seg button[data-tab="in-progress"]').click()
  await expect(inboxCard(page, 'Pull request 8')).toBeVisible()

  await typeInto(page, tabId, `/koloft inbox move pr-8 closed -- "Merged"`)
  await expect(await doneStatus(page, 'Pull request 8')).toContainText('Merged')
})

async function allowFromItsCard(page: Page, command: string) {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  const row = wsRows(page, 'ws-a').first()
  await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 30_000 })
  const tabId = (await row.getAttribute('data-tab-id')) as string
  await runIn(page, centerTerm(page), `/bash ${command}`)
  await expect(row).toHaveClass(/\bst-approval\b/, { timeout: 30_000 })
  await openInbox(page)
  const card = inboxCard(page, 'wants to run a command')
  await card.locator('.ibx-btn', { hasText: 'Allow' }).click()
  return { tabId, card }
}

// CC§12
test('a command a Claude Code session wants to run is a card; Allow there moves it to Done as Answered once the dialog closes, while the command still runs', async ({
  env
}) => {
  env.launchEnv.KOLOFT_FAKE_PROGRAM_STATUS = '1'
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    const { tabId } = await allowFromItsCard(page, 'slow make test')
    await expect(await doneStatus(page, 'wants to run a command')).toContainText('Answered', {
      timeout: ANSWER_WAITS_FOR_THE_UNDO_MS
    })
    expect(await terminalText(page, tabId)).not.toContain('Ran: slow make test')
    fs.writeFileSync(path.join(env.home, 'go-run'), '')
    await expect
      .poll(() => terminalText(page, tabId), { timeout: 15_000 })
      .toContain('Ran: slow make test')
  } finally {
    await quitAndClose(app)
  }
})

// CC§12
test('an Allow pressed on a card that the Claude Code session ignores stays in Needs you and sends the owner to the session', async ({
  env
}) => {
  env.launchEnv.KOLOFT_FAKE_PROGRAM_STATUS = '1'
  fs.writeFileSync(path.join(env.home, 'fake-claude-drop-key'), '')
  const app = await launchApp(env)
  try {
    const { card } = await allowFromItsCard(await app.firstWindow(), 'make test')
    await expect(card).toContainText(ANSWER_NOT_TAKEN, {
      timeout: ANSWER_WAITS_FOR_THE_UNDO_MS + A_TAKEN_ANSWER_SHOWS_WITHIN_MS
    })
  } finally {
    await quitAndClose(app)
  }
})

test('a command a Codex session wants to run is a card in the Inbox, and Allow there approves it', async ({
  env
}) => {
  installCodex(env)
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await waitBooted(page)
    await newSessionInWith(page, 'ws-a', 'Codex')
    await expect(wsRows(page, 'ws-a')).toHaveClass(/st-waiting/, { timeout: 60_000 })
    const codexTab = (await page.evaluate(() => window.api.sessions.list())).find(
      (s) => s.backendId === 'codex'
    )!.tabId as string
    await typeInto(page, codexTab, 'please approve')
    await expect(wsRows(page, 'ws-a')).toHaveClass(/st-approval/, { timeout: 30_000 })
    await openInbox(page)
    const card = inboxCard(page, 'wants to run a command')
    await card.locator('.ibx-btn', { hasText: 'Allow' }).click()
    await expect
      .poll(() => codexAnswers(env), { timeout: ANSWER_WAITS_FOR_THE_UNDO_MS })
      .toEqual([{ decision: 'accept' }])
    await expect(await doneStatus(page, 'wants to run a command')).toContainText('Answered')
  } finally {
    await quitAndClose(app)
  }
})

// MUSE§5
test('a command a Muse session wants to run is a card in the Inbox; Allow there runs it and moves the card to Done as Answered', async ({
  env
}) => {
  installMuse(env)
  trustInMuse(env, env.workspaces.a)
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await waitBooted(page)
    await newSessionInWith(page, 'ws-a', 'Muse')
    await expect(wsRows(page, 'ws-a')).toHaveClass(/st-waiting/, { timeout: 60_000 })
    const museId = museCalls(env)[0].sessionId
    const museTab = (await page.evaluate(() => window.api.sessions.list())).find(
      (s) => s.backendId === 'muse'
    )!.tabId as string
    await typeInto(page, museTab, '/approve')
    await expect(wsRows(page, 'ws-a')).toHaveClass(/\bst-approval\b/, { timeout: 30_000 })
    await openInbox(page)
    await inboxCard(page, 'wants to run a command')
      .locator('.ibx-btn', { hasText: 'Allow' })
      .click()
    await expect
      .poll(() => museSaid(env, museId), { timeout: ANSWER_WAITS_FOR_THE_UNDO_MS })
      .toContain('Ran: ls -la')
    await expect(await doneStatus(page, 'wants to run a command')).toContainText('Answered')
  } finally {
    await quitAndClose(app)
  }
})

test('a session on another machine posts a card with koloft inbox, tagged with that machine', async ({
  env
}) => {
  installFakeRemote(env)
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await waitBooted(page)
    await addRemoteWorkspace(page, env)
    await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
    const row = wsRows(page, REMOTE_WS_NAME).first()
    await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 30_000 })
    const card = JSON.stringify({ title: 'Built on the machine', level: 'low' })
    await runIn(page, centerTerm(page), `/koloft inbox add built -- '${card}'`)
    await openInbox(page)
    const shown = inboxCard(page, 'Built on the machine')
    await expect(shown.locator('.ibx-lvp')).toHaveText('Low', { timeout: 30_000 })
    await expect(shown.locator('.ibx-tag')).toContainText(/Koloft · \S+ · \S+/)
    await expect(page.locator('.ibx-entry .ibx-count')).toHaveCount(0)
  } finally {
    await quitAndClose(app)
  }
})

test('a session that stopped unexpectedly is a card; Start it again resumes it in its one row and tells it to carry on, and Hand to a new session starts a session with the owner’s note', async ({
  page,
  env
}) => {
  test.setTimeout(150_000)
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  const row = wsRows(page, 'ws-a').first()
  await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 25_000 })
  const [first] = await waitForCalls(env, 1)
  killSession(first.pid, env)
  await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })

  await openInbox(page)
  const card = inboxCard(page, 'stopped unexpectedly')
  await card.locator('.ibx-btn', { hasText: 'Start it again' }).click()
  await expect
    .poll(() => peerMessages(env), { timeout: 60_000 })
    .toContain('Carry on where you left off')
  await expect(wsRows(page, 'ws-a')).toHaveCount(1)
  await expect(await doneStatus(page, 'stopped unexpectedly')).toContainText('Restarted')

  const [, again] = await waitForCalls(env, 2)
  killSession(again.pid, env)
  await expect(wsRows(page, 'ws-a').first()).toHaveClass(/\bcold\b/, { timeout: 30_000 })
  await page.locator('.ibx-seg button[data-tab="needs-you"]').click()
  const next = inboxCard(page, 'stopped unexpectedly')
  await next.locator('.ibx-input').fill('finish the docs')
  await next.locator('.ibx-btn', { hasText: 'Hand to a new session' }).click()
  const calls = await waitForCalls(env, 3, 60_000)
  expect(calls[2].firstPrompt ?? calls[2].argv.join(' ')).toContain(
    'Pick up the work of the session'
  )
  expect(calls[2].firstPrompt ?? calls[2].argv.join(' ')).toContain('«finish the docs»')
  await expect(await doneStatus(page, 'stopped unexpectedly')).toContainText(
    'Handed to a new session'
  )
})

test('a session that ends its turn waiting on the owner is a card with its last words; a reply typed on the card reaches it, and one typed in its tab closes the card', async ({
  page,
  env
}) => {
  await waitBooted(page)
  await startSessionIn(page, 'ws-a')
  const row = wsRows(page, 'ws-a').first()
  await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 15_000 })
  const tabId = (await row.getAttribute('data-tab-id')) as string

  await runIn(page, centerTerm(page), '/answer Shall I merge it?')
  await openInbox(page)
  const card = cardQuoting(page, /Answer to: Shall I merge it\?/)
  await expect(card.locator('.ibx-what')).toContainText('finished and waits for you', {
    timeout: 15_000
  })
  await card.locator('.ibx-input').fill('yes, squash it')
  await card.locator('.ibx-btn', { hasText: 'Send' }).click()
  await expect
    .poll(() => peerMessages(env), { timeout: ANSWER_WAITS_FOR_THE_UNDO_MS })
    .toContain('«yes, squash it»')
  await expect(await doneStatus(page, 'finished and waits for you')).toContainText('Replied')

  await typeInto(page, tabId, '/answer Which branch?')
  await page.locator('.ibx-seg button[data-tab="needs-you"]').click()
  await expect(cardQuoting(page, /Answer to: Which branch\?/)).toBeVisible({ timeout: 15_000 })
  await typeInto(page, tabId, 'main')
  await expect(await doneStatus(page, 'finished and waits for you')).toContainText('It went on', {
    timeout: 15_000
  })
})
