import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  centerTerm,
  newSessionInWith,
  runIn,
  startSessionIn,
  terminalText,
  transcriptFile,
  waitForCalls,
  wsRows,
  type AgentName,
  type ClaudeCall
} from './helpers/p1'
import {
  installAgy,
  installCodex,
  installMuse,
  museCalls,
  museSaid,
  seedSettings,
  trustInAgy,
  trustInMuse,
  type E2EEnv
} from './helpers/env'
import {
  agyReady,
  killFakeRemote,
  launchWithRemote,
  machineHome,
  machineMuseCalls,
  remoteDir
} from './helpers/remote'
import { installOnTheMachine, startRemoteTab } from './helpers/remoteTab'
import { BACKEND_LABEL } from '../../src/shared/sessionBackend'
import type { BackendId } from '../../src/shared/types'
import { OWNER_ASLEEP_ANSWER, OWNER_ASLEEP_PUSH } from '../../src/plugins/butler/main/ownerAsleep'
import { OWNER_ASLEEP_FILE } from '../../src/plugins/sessions/main/hooks'

const KOLOFT_ANSWERS_AND_THE_TURN_ENDS_MS = 20_000
const THE_BUTLER_STARTS_AND_READS_IT_MS = 60_000
const A_REMOTE_ANSWER_AND_ITS_TURN_END_MS = 45_000

function transcriptText(env: E2EEnv, call: ClaudeCall): string {
  const file = transcriptFile(env.home, call.cwd, call.sessionId)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

function peerMessages(env: E2EEnv): string {
  const file = path.join(env.home, 'fake-claude-peer.jsonl')
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

function fileText(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

async function tabOf(page: Page, sessionId: string): Promise<string> {
  const all = await page.evaluate(() => window.api.sessions.list())
  return all.find((s) => s.sessionId === sessionId)!.tabId
}

const asJson = (text: string): string => JSON.stringify(text).slice(1, -1)

interface AnsweredForTheOwner {
  gave?: string
  failed?: string
}

function answeredForTheOwner(env: E2EEnv): AnsweredForTheOwner[] {
  try {
    return JSON.parse(fileText(path.join(env.userData, 'owner-asleep-answers.json'))).answered
  } catch {
    return []
  }
}

type OtherBackend = Exclude<BackendId, 'claude'>

interface TabKind {
  backend: BackendId
  remote: boolean
  question: string
  command: string
  saidAfterTheQuestion: string
  ranTheCommand: string
}

const LOCAL_TRUST: Record<OtherBackend, (env: E2EEnv) => void> = {
  codex: (env) => installCodex(env),
  muse: (env) => {
    installMuse(env)
    trustInMuse(env, env.workspaces.a)
  },
  agy: (env) => {
    installAgy(env)
    trustInAgy(env, env.workspaces.a)
  }
}

const THE_FAKE_TAKES_ANY_TYPED_WORDS_AS_ITS_FIRST_OPTION = 'Picked: '

const ASKS: Record<BackendId, Omit<TabKind, 'backend' | 'remote'>> = {
  claude: {
    question: '/ask Which colour?|Red|Green',
    command: '/bash npm publish',
    saidAfterTheQuestion: `Picked: ${asJson(OWNER_ASLEEP_ANSWER)}`,
    ranTheCommand: 'Ran: npm publish'
  },
  codex: {
    question: 'please ask me',
    command: 'please approve',
    saidAfterTheQuestion: JSON.stringify({
      answers: {
        colour: { answers: ['None of the above', `user_note: ${OWNER_ASLEEP_ANSWER}`] }
      }
    }),
    ranTheCommand: '"decision":"accept"'
  },
  muse: {
    question: '/ask',
    command: '/approve',
    saidAfterTheQuestion: THE_FAKE_TAKES_ANY_TYPED_WORDS_AS_ITS_FIRST_OPTION,
    ranTheCommand: 'Ran: ls -la'
  },
  agy: {
    question: '/ask Which colour?|Red|Green',
    command: '/bash echo asleep-ran',
    saidAfterTheQuestion: asJson(OWNER_ASLEEP_ANSWER),
    ranTheCommand: 'Ran: echo asleep-ran'
  }
}

const TAB_KINDS: TabKind[] = [
  { backend: 'claude' as const, remote: true, ...ASKS.claude },
  ...(['codex', 'muse', 'agy'] as const).flatMap((backend) =>
    [false, true].map((remote) => ({ backend, remote, ...ASKS[backend] }))
  )
].map((kind) =>
  kind.backend === 'agy' && kind.remote
    ? { ...kind, saidAfterTheQuestion: THE_FAKE_TAKES_ANY_TYPED_WORDS_AS_ITS_FIRST_OPTION }
    : kind
)

const kindName = (k: TabKind): string => `${k.remote ? 'remote ' : ''}${BACKEND_LABEL[k.backend]}`

async function startTab(page: Page, env: E2EEnv, kind: TabKind): Promise<string> {
  if (kind.remote) return startRemoteTab(page, env, kind.backend)
  const row = wsRows(page, 'ws-a').first()
  await newSessionInWith(page, 'ws-a', BACKEND_LABEL[kind.backend] as AgentName)
  if (kind.backend === 'agy') {
    await agyReady(page)
    await runIn(page, centerTerm(page), 'first words')
  }
  await expect(row).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
  return (await row.getAttribute('data-tab-id'))!
}

async function launchFor(env: E2EEnv, kind: TabKind) {
  if (kind.remote) {
    installOnTheMachine(env, kind.backend)
    return launchWithRemote(env)
  }
  LOCAL_TRUST[kind.backend as OtherBackend](env)
  const app = await launchApp(env)
  return { app, page: await app.firstWindow() }
}

function agentHome(env: E2EEnv, kind: TabKind): string {
  return kind.remote ? machineHome(env) : env.home
}

const STOP_SAID = 'Stop said: '

interface CodexItemFrame {
  direction: string
  frame: { method?: string; params?: { item?: { type?: string; text?: string } } }
}

function codexReplies(home: string): string[] {
  return fileText(path.join(home, 'fake-codex-wire.jsonl'))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CodexItemFrame)
    .filter((w) => w.direction === 'server' && w.frame.method === 'item/completed')
    .flatMap((w) =>
      w.frame.params?.item?.type === 'agentMessage' ? [w.frame.params.item.text!] : []
    )
}

function mostPushesInARow(replies: string[]): number {
  let most = 0
  let run = 0
  for (const reply of replies) {
    run = reply.startsWith(`${STOP_SAID}${OWNER_ASLEEP_PUSH}`) ? run + 1 : 0
    most = Math.max(most, run)
  }
  return most
}

function linesFrom(file: string): string[] {
  return fileText(file).split('\n').filter(Boolean)
}

async function whatItSaid(
  env: E2EEnv,
  page: Page,
  tab: string,
  kind: TabKind
): Promise<{ text: string; pushes: number }> {
  const home = agentHome(env, kind)
  switch (kind.backend) {
    case 'claude': {
      const call = (await waitForCalls(env, 1))[0]
      const text = fileText(transcriptFile(home, remoteDir(env), call.sessionId))
      return { text, pushes: text.split(`${STOP_SAID}${asJson(OWNER_ASLEEP_PUSH)}`).length - 1 }
    }
    case 'codex': {
      const replies = codexReplies(home)
      return {
        text: [fileText(path.join(home, 'fake-codex-wire.jsonl')), ...replies].join('\n'),
        pushes: mostPushesInARow(replies)
      }
    }
    case 'muse': {
      const calls = kind.remote ? machineMuseCalls(env) : museCalls(env)
      const said = museSaid(env, calls[0].sessionId, home)
      return {
        text: said.map((s) => JSON.stringify(s)).join('\n'),
        pushes: mostPushesInARow(said)
      }
    }
    case 'agy': {
      const stops = linesFrom(path.join(home, 'fake-agy-injected.jsonl'))
        .map((line) => JSON.parse(line) as { event: string; reason?: string })
        .filter((e) => e.event === 'stop-blocked')
      const ownLines = (await terminalText(page, tab))
        .split('\n')
        .filter((line) => /^(Picked|Ran): /.test(line))
      return {
        text: [
          fileText(path.join(home, 'fake-agy-api.jsonl')),
          ...stops.map((e) => JSON.stringify(e)),
          ...ownLines
        ].join('\n'),
        pushes: stops.filter((e) => e.reason?.includes(OWNER_ASLEEP_PUSH)).length
      }
    }
  }
}

const ownerAsleepButton = (page: Page) => page.locator('.tb-ico[aria-label="Owner asleep"]')

test.describe('owner asleep', () => {
  test('the sidebar switch puts the owner to sleep: a session’s question is answered for them with "choose your own recommendation", its approval is allowed, its turn is pushed once to go on by itself, and the owner pressing Enter in a terminal wakes them, takes the mark away and hands the butler what happened', async ({
    env,
    page
  }) => {
    await startSessionIn(page, 'ws-a')
    const call = (await waitForCalls(env, 1))[0]
    const tab = await tabOf(page, call.sessionId)
    const type = (line: string): Promise<void> =>
      page.evaluate(([id, l]) => window.api.terminal.write(id, l + '\r'), [tab, line])
    const marker = path.join(env.userData, 'hook-sessions', OWNER_ASLEEP_FILE)
    const transcript = (): string => transcriptText(env, call)

    await type('/later /ask Which colour?|Red|Green')
    const asleep = ownerAsleepButton(page)
    await expect(asleep).toHaveAttribute(
      'title',
      'Going to sleep — sessions keep going without you'
    )
    await asleep.click()
    await expect(asleep).toHaveClass(/\bon\b/)
    await expect(asleep).toHaveAttribute(
      'title',
      "Asleep — sessions keep going on their own. Click when you're back"
    )
    await expect.poll(() => fs.existsSync(marker)).toBe(true)

    fs.writeFileSync(path.join(env.home, 'go-later'), '')
    await expect
      .poll(transcript, { timeout: KOLOFT_ANSWERS_AND_THE_TURN_ENDS_MS })
      .toContain(`Picked: ${asJson(OWNER_ASLEEP_ANSWER)}`)
    await expect
      .poll(transcript, { timeout: KOLOFT_ANSWERS_AND_THE_TURN_ENDS_MS })
      .toContain(`Stop said: ${asJson(OWNER_ASLEEP_PUSH)}`)

    await type('')
    await expect(asleep).not.toHaveClass(/\bon\b/)
    await expect.poll(() => fs.existsSync(marker)).toBe(false)
    await expect
      .poll(() => peerMessages(env), { timeout: THE_BUTLER_STARTS_AND_READS_IT_MS })
      .toContain('The owner was asleep for')
    expect(peerMessages(env)).toContain('Koloft told it to choose its own recommendation and go on')
  })

  test('a command a session asks to run while the owner is asleep is allowed for them, and it runs', async ({
    env,
    page
  }) => {
    await startSessionIn(page, 'ws-a')
    const call = (await waitForCalls(env, 1))[0]
    const tab = await tabOf(page, call.sessionId)
    await page.evaluate((id) => window.api.terminal.write(id, '/later /bash npm publish\r'), tab)
    const asleep = ownerAsleepButton(page)
    await asleep.click()
    await expect(asleep).toHaveClass(/\bon\b/)

    fs.writeFileSync(path.join(env.home, 'go-later'), '')
    await expect
      .poll(() => transcriptText(env, call), { timeout: KOLOFT_ANSWERS_AND_THE_TURN_ENDS_MS })
      .toContain('Ran: npm publish')
  })

  test.describe('every other kind of tab', () => {
    test.afterEach(({ env }) => killFakeRemote(env))

    for (const kind of TAB_KINDS) {
      const name = kindName(kind)

      test(`a question a ${name} session shows when the owner falls asleep is answered for them with "choose your own recommendation", and the turn that ends after it is pushed once to go on by itself`, async ({
        env
      }) => {
        test.setTimeout(180_000)
        const { app, page } = await launchFor(env, kind)
        try {
          const tab = await startTab(page, env, kind)
          await page.evaluate(
            ([id, l]) => window.api.terminal.write(id, l + '\r'),
            [tab, kind.question]
          )
          await expect(page.locator(`.ws-tab[data-tab-id="${tab}"]`)).toHaveClass(
            /\bst-approval\b/,
            { timeout: 30_000 }
          )

          await ownerAsleepButton(page).click()
          await expect
            .poll(() => answeredForTheOwner(env), { timeout: A_REMOTE_ANSWER_AND_ITS_TURN_END_MS })
            .toEqual([expect.objectContaining({ gave: OWNER_ASLEEP_ANSWER })])
          expect(answeredForTheOwner(env)[0].failed).toBeUndefined()
          await expect
            .poll(async () => (await whatItSaid(env, page, tab, kind)).text, {
              timeout: A_REMOTE_ANSWER_AND_ITS_TURN_END_MS
            })
            .toContain(kind.saidAfterTheQuestion)
          await expect
            .poll(async () => (await whatItSaid(env, page, tab, kind)).pushes, {
              timeout: A_REMOTE_ANSWER_AND_ITS_TURN_END_MS
            })
            .toBe(1)
        } finally {
          await quitAndClose(app)
        }
      })

      test(`a command a ${name} session asks to run when the owner falls asleep is allowed for them, and it runs`, async ({
        env
      }) => {
        test.setTimeout(180_000)
        if (kind.backend === 'agy') seedSettings(env, { skipPermissions: false })
        const { app, page } = await launchFor(env, kind)
        try {
          const tab = await startTab(page, env, kind)
          await page.evaluate(
            ([id, l]) => window.api.terminal.write(id, l + '\r'),
            [tab, kind.command]
          )
          await expect(page.locator(`.ws-tab[data-tab-id="${tab}"]`)).toHaveClass(
            /\bst-approval\b/,
            { timeout: 30_000 }
          )

          await ownerAsleepButton(page).click()
          await expect
            .poll(() => answeredForTheOwner(env), { timeout: A_REMOTE_ANSWER_AND_ITS_TURN_END_MS })
            .toEqual([expect.objectContaining({ gave: 'yes' })])
          expect(answeredForTheOwner(env)[0].failed).toBeUndefined()
          await expect
            .poll(async () => (await whatItSaid(env, page, tab, kind)).text, {
              timeout: A_REMOTE_ANSWER_AND_ITS_TURN_END_MS
            })
            .toContain(kind.ranTheCommand)
        } finally {
          await quitAndClose(app)
        }
      })
    }
  })
})
