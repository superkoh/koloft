import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { installCodex, seedSettings, type E2EEnv } from './helpers/env'
import {
  newSessionInWith,
  readCalls,
  settingsOnDisk,
  startSessionIn,
  terminalText,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'
import {
  callbackText,
  startFakeDiscord,
  type FakeDiscord,
  type FakePost
} from './helpers/fakeDiscord'
import { openSettings } from './helpers/extensions'
import type { ConductorBinding, DiscordSettings } from '../../src/shared/types'

test.setTimeout(120_000)

const OWNER = { id: '555', username: 'letian' }
const STRANGER = { id: '556', username: 'someone' }
const CHANNEL = '222'
const OFFLINE_REPLY = 'Koloft was offline, this message was not delivered.'
const CONDUCTOR_STARTS_AND_ANSWERS_MS = 60_000
const DISCORD_MESSAGE_LIMIT = 2000
const RESUMED_SESSION_BINDS_AFTER_MS = 12_000

function seedConductor(
  env: E2EEnv,
  backend: 'claude' | 'codex',
  extra: Partial<ConductorBinding> = {}
): void {
  seedSettings(env, {
    hintsOff: true,
    discord: {
      userId: OWNER.id,
      userName: OWNER.username,
      bindings: [
        {
          id: 'b1',
          scope: env.workspaces.a,
          backend,
          channel: { guildId: '111', channelId: CHANNEL, name: 'koloft-all' },
          sessionIds: [],
          touched: [],
          ...extra
        }
      ]
    }
  })
}

function bindingOnDisk(env: E2EEnv): ConductorBinding | undefined {
  return (settingsOnDisk(env).discord as DiscordSettings | undefined)?.bindings[0]
}

function said(fake: FakeDiscord): string[] {
  return fake.posted.filter((p) => p.channelId === CHANNEL).map((p) => p.content)
}

function threadPosts(fake: FakeDiscord): FakePost[] {
  const ids = fake.threads.filter((t) => t.parentId === CHANNEL).map((t) => t.id)
  return fake.posted.filter((p) => ids.includes(p.channelId))
}

function inThreads(fake: FakeDiscord): string[] {
  return threadPosts(fake).map((p) => p.content)
}

function notices(fake: FakeDiscord): string[] {
  return inThreads(fake)
    .map((p) => p.split('\n')[0])
    .filter((l) => /^(🔔|❓|⏹)/.test(l))
}

function transcriptText(env: E2EEnv, sessionId: string): string {
  const root = path.join(env.home, '.claude', 'projects')
  for (const dir of fs.readdirSync(root)) {
    const file = path.join(root, dir, `${sessionId}.jsonl`)
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8')
  }
  return ''
}

function codexWire(env: E2EEnv): { direction: string; frame: Record<string, unknown> }[] {
  return fs
    .readFileSync(path.join(env.home, 'fake-codex-wire.jsonl'), 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l) as { direction: string; frame: Record<string, unknown> })
}

async function tabOf(page: Page, sessionId: string): Promise<string> {
  const all = await page.evaluate(() => window.api.sessions.list())
  return all.find((s) => s.sessionId === sessionId)!.tabId
}

async function connected(
  env: E2EEnv,
  fake: FakeDiscord
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await waitBooted(page)
  await expect.poll(() => fake.identifies).toBe(1)
  return { app, page }
}

test.describe('Discord flow: the owner talks to a conductor in its channel, and hears about the sessions it looks after', () => {
  test('an owner message opens the Claude conductor and is typed into it as [Discord] text; the reply comes back whole, a long one split in order; a stranger is ignored; an attachment arrives as a file path', async ({
    env
  }) => {
    seedConductor(env, 'claude')
    const fake = await startFakeDiscord(env)
    const { app } = await connected(env, fake)
    try {
      fake.say(STRANGER, 'not the owner')
      const hello = fake.say(OWNER, 'hello there')
      await expect
        .poll(() => said(fake), { timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS })
        .toContain('Answer to: [Discord] hello there')
      expect(said(fake).join('\n')).not.toContain('not the owner')
      await expect
        .poll(() => fake.reactions)
        .toContainEqual({ messageId: hello, emoji: '✅', on: true })
      expect(readCalls(env)).toHaveLength(1)
      expect(readCalls(env)[0].cwd).toBe(env.workspaces.a)

      fake.say(OWNER, '/long 600')
      const lines = Array.from({ length: 600 }, (_, i) => `line ${i + 1}`).join('\n')
      const longParts = (): string[] => said(fake).filter((p) => p.startsWith('line '))
      await expect.poll(() => longParts().join('\n')).toBe(lines)
      expect(longParts().length).toBeGreaterThan(1)
      for (const p of longParts()) expect(p.length).toBeLessThanOrEqual(DISCORD_MESSAGE_LIMIT)

      fake.say(OWNER, 'look at this', {
        attachments: [{ filename: 'note.txt', body: 'attached body' }]
      })
      const withFile = (): string | undefined => said(fake).find((p) => p.includes('look at this'))
      await expect.poll(withFile).toBeTruthy()
      const file = /\(attached file: "([^"]+)"\)/.exec(withFile()!)?.[1] ?? ''
      expect(file.startsWith(path.join(env.userData, 'discord-attachments'))).toBe(true)
      expect(fs.readFileSync(file, 'utf8')).toBe('attached body')
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('a managed session gets its own thread under the conductor’s channel, opened from a card there with the owner added: its dialog, its finished turn with the reply (only once the conductor touched it or it has a thread) and its closing go in the thread, which is then put away; koloft discord send uploads a file', async ({
    env
  }) => {
    seedConductor(env, 'claude')
    const fake = await startFakeDiscord(env)
    fs.writeFileSync(path.join(env.workspaces.a, 'shot.png'), 'png bytes')
    const { app, page } = await connected(env, fake)
    try {
      await startSessionIn(page, 'ws-a')
      const managed = (await waitForCalls(env, 1))[0].sessionId
      const managedTab = (await page.evaluate(() => window.api.sessions.list())).find(
        (s) => s.sessionId === managed
      )!.tabId
      const type = (line: string): Promise<void> =>
        page.evaluate(([id, l]) => window.api.terminal.write(id, l + '\r'), [managedTab, line])

      await type('/answer before any touch')
      await type('/need-approval')
      await expect
        .poll(() => notices(fake))
        .toEqual([expect.stringMatching(/^❓ .+ is waiting for you\.$/)])
      expect(said(fake)).toEqual([expect.stringMatching(/^🧵 \*\*.+\*\*\n-# ws-a · Claude$/)])
      expect(fake.threads).toEqual([
        expect.objectContaining({ parentId: CHANNEL, members: [OWNER.id], archived: false })
      ])
      expect(bindingOnDisk(env)?.threads).toEqual([
        expect.objectContaining({ threadId: fake.threads[0].id, keys: [managed] })
      ])

      fake.say(OWNER, `/koloft session read ${managed}`)
      await expect
        .poll(() => bindingOnDisk(env)?.touched, { timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS })
        .toEqual([managed])
      await type('/answer after the touch')
      await expect
        .poll(() => notices(fake))
        .toEqual([expect.stringMatching(/^❓ /), expect.stringMatching(/^🔔 .+ finished\.$/)])
      expect(inThreads(fake).at(-1)).toMatch(/finished\.\nAnswer to: after the touch$/)

      fake.say(OWNER, '/koloft discord send shot.png -- here it is')
      await expect
        .poll(() => fake.posted.filter((p) => p.files.length))
        .toEqual([
          expect.objectContaining({
            channelId: CHANNEL,
            content: 'here it is',
            files: [{ name: 'shot.png', text: 'png bytes' }]
          })
        ])

      await type('/exit')
      await expect
        .poll(() => notices(fake))
        .toEqual([
          expect.stringMatching(/^❓ /),
          expect.stringMatching(/^🔔 /),
          expect.stringMatching(/^⏹ .+ closed\.$/)
        ])
      await expect.poll(() => fake.threads[0].archived).toBe(true)
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('the conductor’s own question is asked in the channel as a card with its options and a button each; a button press answers it and the card then says what was picked, and a number sent back answers the next', async ({
    env
  }) => {
    seedConductor(env, 'claude')
    const fake = await startFakeDiscord(env)
    const { app } = await connected(env, fake)
    try {
      const question =
        '❓ **The conductor** is waiting for you.\nWhich colour?\n1. Red — The Red one\n2. Green — The Green one'
      const asked = `${question}\n-# Reply with a number or your own answer.`
      const card = (): FakePost | undefined =>
        fake.posted.filter((p) => p.channelId === CHANNEL && p.content === asked).at(-1)
      fake.say(OWNER, '/ask Which colour?|Red|Green')
      await expect.poll(card, { timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS }).toBeTruthy()
      expect(card()!.buttons?.map((b) => b.label)).toEqual(['1. Red', '2. Green'])
      fake.press(OWNER, card()!.buttons![1], CHANNEL)
      await expect.poll(() => said(fake)).toContain('Picked: Green')
      expect(fake.callbacks.map((c) => [c.type, callbackText(c)])).toEqual([
        [7, `${question}\n-# ✅ 2. Green`]
      ])

      fake.say(OWNER, '/ask Which size?|Small|Large')
      await expect.poll(() => said(fake).join('\n')).toContain('Which size?')
      const answer = fake.say(OWNER, '2')
      await expect.poll(() => said(fake)).toContain('Picked: Large')
      await expect
        .poll(() => fake.reactions)
        .toContainEqual({ messageId: answer, emoji: '✅', on: true })
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('owner messages sent while Koloft was away each get one "not delivered" reply on connect and reach no conductor', async ({
    env
  }) => {
    seedConductor(env, 'claude', { lastMessageId: '100' })
    const fake = await startFakeDiscord(env)
    fake.history[CHANNEL] = [
      { id: '99', content: 'already handled', author: OWNER },
      { id: '101', content: 'while you were away', author: OWNER },
      { id: '102', content: 'not mine', author: STRANGER },
      { id: '103', content: 'one more', author: OWNER }
    ]
    const { app } = await connected(env, fake)
    try {
      await expect
        .poll(() => fake.posted.filter((p) => p.content === OFFLINE_REPLY).map((p) => p.replyTo))
        .toEqual(['101', '103'])
      await expect.poll(() => bindingOnDisk(env)?.lastMessageId).toBe('103')
      expect(readCalls(env)).toEqual([])
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('the conductor sends to a local Claude session through its message socket as the owner’s words, stops it, and resumes it with a first message; the session is touched', async ({
    env
  }) => {
    seedConductor(env, 'claude')
    const fake = await startFakeDiscord(env)
    const { app, page } = await connected(env, fake)
    try {
      await startSessionIn(page, 'ws-a')
      const managed = (await waitForCalls(env, 1))[0].sessionId
      const peerLog = path.join(env.home, 'fake-claude-peer.jsonl')
      const peerLines = (): string[] =>
        fs.existsSync(peerLog) ? fs.readFileSync(peerLog, 'utf8').split('\n').filter(Boolean) : []
      const sent = (text: string): string =>
        JSON.stringify({
          type: 'user',
          message: {
            role: 'user',
            content: `<cross-session-message from-mode="prompting">\n(Your owner, via the Koloft conductor:) ${text}\n</cross-session-message>`
          }
        })

      fake.say(OWNER, `/koloft session send ${managed} fix the tests`)
      await expect
        .poll(peerLines, { timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS })
        .toEqual([sent('fix the tests')])
      await expect.poll(() => bindingOnDisk(env)?.touched).toEqual([managed])
      await expect.poll(() => notices(fake)).toEqual([expect.stringMatching(/^🔔 .+ finished\.$/)])

      fake.say(OWNER, `/koloft session stop ${managed}`)
      await expect
        .poll(() => notices(fake))
        .toEqual([expect.stringMatching(/^🔔 /), expect.stringMatching(/^⏹ .+ closed\.$/)])
      await expect(wsRows(page, 'ws-a')).toHaveClass(/cold/)

      fake.say(OWNER, `/koloft session resume ${managed} -- carry on`)
      await expect
        .poll(peerLines, { timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS })
        .toEqual([sent('fix the tests'), sent('carry on')])
      expect(
        readCalls(env).filter((c) => c.argv[c.argv.indexOf('--resume') + 1] === managed)
      ).toHaveLength(1)
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('the conductor queues a message on a Codex session with a conductor message id, and a session it starts with --backend codex is announced and touched, and its thread takes the session’s sidebar title once it has one; once the conductor closes it for good, a message in its thread is refused by that name', async ({
    env
  }) => {
    installCodex(env)
    seedConductor(env, 'claude')
    const fake = await startFakeDiscord(env)
    const { app, page } = await connected(env, fake)
    try {
      await newSessionInWith(page, 'ws-a', 'Codex')
      await expect(wsRows(page, 'ws-a')).toHaveClass(/st-waiting/, { timeout: 60_000 })
      const codexCalls = (): { sessionId: string }[] =>
        fs
          .readFileSync(path.join(env.home, 'fake-codex-calls.jsonl'), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l) as { sessionId: string })
      const codexId = codexCalls()[0].sessionId

      fake.say(OWNER, `/koloft session send ${codexId} check the docs`)
      const queued = (): unknown[] =>
        fs
          .readFileSync(path.join(env.home, 'fake-codex-wire.jsonl'), 'utf8')
          .trim()
          .split('\n')
          .map(
            (l) =>
              JSON.parse(l) as {
                direction: string
                frame: {
                  method?: string
                  params?: { clientUserMessageId?: string; input?: { text: string }[] }
                }
              }
          )
          .filter((w) => w.direction === 'client' && w.frame.method === 'thread/queue/add')
          .map((w) => [w.frame.params?.clientUserMessageId, w.frame.params?.input?.[0].text])
      await expect
        .poll(queued, { timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS })
        .toEqual([['koloft-conductor-1', '(Your owner, via the Koloft conductor:) check the docs']])

      fake.say(OWNER, '/koloft session new --backend codex -- list the files')
      await expect
        .poll(() => said(fake).join('\n'))
        .toContain('▶ Started **a Codex session**\n-# ws-a · Codex')
      await expect.poll(() => bindingOnDisk(env)?.touched.length).toBe(2)
      const opener = fake.posted.find((p) => p.content.startsWith('▶ Started **a Codex session**'))!
      const thread = (): string | undefined => fake.threads.find((t) => t.id === opener.id)?.name
      await expect
        .poll(
          async () => {
            const titles = (await page.evaluate(() => window.api.sessions.list())).map(
              (s) => s.title
            )
            return thread() !== 'a Codex session' && titles.includes(thread() ?? '')
          },
          { timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS }
        )
        .toBe(true)
      expect(bindingOnDisk(env)?.threads?.find((t) => t.threadId === opener.id)?.name).toBe(
        thread()
      )

      const started = (await page.evaluate(() => window.api.sessions.list())).find(
        (s) => s.title === thread()
      )!
      fake.say(OWNER, `/koloft session close ${started.sessionId}`)
      await expect
        .poll(async () =>
          (await page.evaluate(() => window.api.sessions.list())).some(
            (s) => s.sessionId === started.sessionId
          )
        )
        .toBe(false)
      const late = fake.say(OWNER, 'are you still there?', { channelId: opener.id })
      await expect
        .poll(() => fake.posted.find((p) => p.replyTo === late)?.content)
        .toBe(
          `${thread()} is no longer in the session list (it was closed for good), so it cannot be woken. This message was not delivered.`
        )
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('a channel Koloft cannot post to is reported in another bound channel, as a toast, and next to its binding in Settings ▸ Discord', async ({
    env
  }) => {
    seedSettings(env, {
      hintsOff: true,
      discord: {
        userId: OWNER.id,
        userName: OWNER.username,
        bindings: [
          {
            id: 'b1',
            scope: env.workspaces.a,
            backend: 'claude',
            channel: { guildId: '111', channelId: CHANNEL, name: 'koloft-all' },
            sessionIds: [],
            touched: []
          },
          {
            id: 'b2',
            scope: env.workspaces.b,
            backend: 'claude',
            channel: { guildId: '111', channelId: '333', name: 'koloft' },
            sessionIds: [],
            touched: []
          }
        ]
      }
    })
    const fake = await startFakeDiscord(env)
    fake.refusePostsIn.push('333')
    const { app, page } = await connected(env, fake)
    try {
      await startSessionIn(page, 'ws-b')
      const managed = (await waitForCalls(env, 1))[0].sessionId
      const tab = (await page.evaluate(() => window.api.sessions.list())).find(
        (s) => s.sessionId === managed
      )!.tabId
      await page.evaluate((id) => window.api.terminal.write(id, '/need-approval\r'), tab)
      const report = /^Koloft could not post to #koloft in Discord: Discord answered 403/
      await expect(page.locator('.toast')).toHaveText(report)
      await expect.poll(() => said(fake)).toContainEqual(expect.stringMatching(report))
      await openSettings(page)
      await page.locator('.set-ni', { hasText: 'Discord' }).click()
      await expect(page.locator('.set-main .acct-login-state.bad')).toHaveText(
        /^Cannot post here: Discord answered 403/
      )
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('a Codex conductor gets the owner message queued with a Discord message id, its reply comes back, its own approval is answered by a yes from the channel, and its own question reaches the channel with its options and is answered by an option name', async ({
    env
  }) => {
    installCodex(env)
    seedConductor(env, 'codex')
    const fake = await startFakeDiscord(env)
    const { app } = await connected(env, fake)
    try {
      const hi = fake.say(OWNER, 'hi codex')
      await expect
        .poll(() => said(fake), { timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS })
        .toContain('Codex fixture answered: [Discord] hi codex')
      const queued = fs
        .readFileSync(path.join(env.home, 'fake-codex-wire.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map(
          (l) =>
            JSON.parse(l) as {
              direction: string
              frame: { method?: string; params?: { clientUserMessageId?: string } }
            }
        )
        .filter((w) => w.direction === 'client' && w.frame.method === 'thread/queue/add')
      expect(queued.map((w) => w.frame.params?.clientUserMessageId)).toEqual([
        `koloft-discord-${hi}`
      ])

      fake.say(OWNER, 'please approve this')
      await expect
        .poll(() => said(fake))
        .toContain(
          '❓ **The conductor** is waiting for you.\nCodex asks to run: echo approved\n-# Reply yes or no.'
        )
      fake.say(OWNER, 'yes')
      await expect
        .poll(() => said(fake))
        .toContain('Codex fixture answered: [Discord] please approve this')

      fake.say(OWNER, 'please ask me')
      await expect
        .poll(() => said(fake))
        .toContain(
          '❓ **The conductor** is waiting for you.\nWhich colour do you prefer?\n1. Red — Choose red.\n2. Green — Choose green.\n-# Reply with the number or the name of one option.'
        )
      fake.say(OWNER, 'Green')
      await expect
        .poll(() => said(fake))
        .toContain('Codex fixture answered: [Discord] please ask me')
      expect(
        codexWire(env)
          .filter((w) => w.direction === 'client')
          .map((w) => w.frame.result as { answers?: unknown } | undefined)
          .filter((r) => r?.answers)
      ).toEqual([{ answers: { colour: { answers: ['Green'] } } }])
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('a managed Claude session’s question reaches its thread whole and the conductor answers it with koloft session answer; in the thread its command approval is allowed by the Yes button and refused by the owner’s words, and the owner’s message is typed into it and its reply comes back there', async ({
    env
  }) => {
    seedConductor(env, 'claude')
    const fake = await startFakeDiscord(env)
    const { app, page } = await connected(env, fake)
    try {
      await startSessionIn(page, 'ws-a')
      const managed = (await waitForCalls(env, 1))[0].sessionId
      const managedTab = await tabOf(page, managed)
      const type = (line: string): Promise<void> =>
        page.evaluate(([id, l]) => window.api.terminal.write(id, l + '\r'), [managedTab, line])
      const waiting = async (detail: string): Promise<FakePost> => {
        const card = (): FakePost | undefined =>
          threadPosts(fake).find((p) =>
            new RegExp(
              `^❓ .+ is waiting for you\\.\\n${detail.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n`
            ).test(p.content)
          )
        await expect.poll(card).toBeTruthy()
        return card()!
      }

      await type('/ask Which colour?|Red|Green')
      const question = await waiting(
        'Which colour?\n1. Red — The Red one\n2. Green — The Green one'
      )
      expect(question.buttons?.map((b) => b.label)).toEqual(['1. Red', '2. Green'])
      fake.say(OWNER, `/koloft session answer ${managed} 2`)
      await expect
        .poll(() => transcriptText(env, managed), { timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS })
        .toContain('Picked: Green')
      expect(bindingOnDisk(env)?.touched).toEqual([managed])
      const thread = question.channelId

      await type('/bash touch made.txt')
      const approval = await waiting('Bash asks to run:\ntouch made.txt')
      fake.press(
        OWNER,
        approval.buttons!.find((b) => b.label === 'Yes')!,
        thread
      )
      await expect.poll(() => transcriptText(env, managed)).toContain('Ran: touch made.txt')

      await type('/bash rm -rf build')
      await waiting('Bash asks to run:\nrm -rf build')
      const refusal = fake.say(OWNER, 'no, keep it', { channelId: thread })
      await expect.poll(() => transcriptText(env, managed)).toContain('Denied: no, keep it')
      await expect
        .poll(() => fake.reactions)
        .toContainEqual({ messageId: refusal, emoji: '✅', on: true })

      fake.say(OWNER, '[Discord] straight from the thread', { channelId: thread })
      await expect
        .poll(() => inThreads(fake).join('\n'), { timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS })
        .toContain('finished.\nAnswer to: [Discord] straight from the thread')
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('a managed Codex session’s approval reaches its thread with its command and is answered by the Yes button there, and its one-question list with its options is answered by the conductor; each presses its key', async ({
    env
  }) => {
    installCodex(env)
    seedConductor(env, 'claude')
    const fake = await startFakeDiscord(env)
    const { app, page } = await connected(env, fake)
    try {
      await newSessionInWith(page, 'ws-a', 'Codex')
      await expect(wsRows(page, 'ws-a')).toHaveClass(/st-waiting/, { timeout: 60_000 })
      const codexId = (
        JSON.parse(
          fs.readFileSync(path.join(env.home, 'fake-codex-calls.jsonl'), 'utf8').split('\n')[0]
        ) as { sessionId: string }
      ).sessionId
      const codexTab = (await page.evaluate(() => window.api.sessions.list())).find(
        (s) => s.backendId === 'codex'
      )!.tabId
      await page.evaluate((id) => window.api.terminal.write(id, 'please approve\r'), codexTab)
      const approval = (): FakePost | undefined =>
        threadPosts(fake).find((p) =>
          /^❓ .+ is waiting for you\.\necho approved\n/.test(p.content)
        )
      await expect.poll(approval).toBeTruthy()
      expect(approval()!.buttons?.map((b) => b.label)).toEqual(['Yes', 'No'])

      fake.press(OWNER, approval()!.buttons![0], approval()!.channelId)
      await expect
        .poll(
          () =>
            codexWire(env).filter(
              (w) =>
                w.direction === 'client' &&
                (w.frame.result as { decision?: string } | undefined)?.decision
            ),
          { timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS }
        )
        .toEqual([
          expect.objectContaining({
            frame: expect.objectContaining({ result: { decision: 'accept' } })
          })
        ])

      await expect(wsRows(page, 'ws-a')).toHaveClass(/st-waiting/)
      await page.evaluate((id) => window.api.terminal.write(id, 'please ask me\r'), codexTab)
      await expect
        .poll(() => inThreads(fake).join('\n\n'))
        .toMatch(
          /(^|\n)❓ .+ is waiting for you\.\nWhich colour do you prefer\?\n1\. Red — Choose red\.\n2\. Green — Choose green\.\n/
        )
      fake.say(OWNER, `/koloft session answer ${codexId} Green`)
      await expect
        .poll(
          () =>
            codexWire(env).filter(
              (w) =>
                w.direction === 'client' &&
                (w.frame.result as { answers?: unknown } | undefined)?.answers
            ),
          { timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS }
        )
        .toEqual([
          expect.objectContaining({
            frame: expect.objectContaining({
              result: { answers: { colour: { answers: ['Green'] } } }
            })
          })
        ])
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('a send to a closed session answers the conductor at once and is delivered once the session is ready, even past the 8 s the koloft command waits', async ({
    env
  }) => {
    seedConductor(env, 'claude')
    const fake = await startFakeDiscord(env)
    const { app, page } = await connected(env, fake)
    try {
      await startSessionIn(page, 'ws-a')
      const managed = (await waitForCalls(env, 1))[0].sessionId
      fake.say(OWNER, `/koloft session stop ${managed}`)
      await expect(wsRows(page, 'ws-a')).toHaveClass(/cold/, {
        timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS
      })
      const conductorTab = await tabOf(page, bindingOnDisk(env)!.sessionIds[0])
      fs.writeFileSync(
        path.join(env.home, 'fake-claude-delay'),
        String(RESUMED_SESSION_BINDS_AFTER_MS)
      )
      const peerLog = path.join(env.home, 'fake-claude-peer.jsonl')

      fake.say(OWNER, `/koloft session send ${managed} after the wait`)
      await expect
        .poll(() => terminalText(page, conductorTab))
        .toMatch(/Will deliver when .+ is ready\./)
      expect(fs.existsSync(peerLog)).toBe(false)
      await expect
        .poll(() => (fs.existsSync(peerLog) ? fs.readFileSync(peerLog, 'utf8') : ''), {
          timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS
        })
        .toContain('(Your owner, via the Koloft conductor:) after the wait')
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })
})
