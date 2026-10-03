import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { installCodex, seedSettings, type E2EEnv } from './helpers/env'
import { readCalls, settingsOnDisk, startSessionIn, waitBooted, waitForCalls } from './helpers/p1'
import { startFakeDiscord, type FakeDiscord } from './helpers/fakeDiscord'
import type { ConductorBinding, DiscordSettings } from '../../src/shared/types'

test.setTimeout(120_000)

const OWNER = { id: '555', username: 'letian' }
const STRANGER = { id: '556', username: 'someone' }
const CHANNEL = '222'
const OFFLINE_REPLY = 'Koloft was offline, this message was not delivered.'
const CONDUCTOR_STARTS_AND_ANSWERS_MS = 60_000
const DISCORD_MESSAGE_LIMIT = 2000

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
      conductorsFolded: true,
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

function notices(fake: FakeDiscord): string[] {
  return said(fake)
    .flatMap((p) => p.split('\n'))
    .filter((l) => /^(🔔|❓|⏹)/.test(l))
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

  test('a managed session’s dialog and its closing reach the channel of the conductor whose scope holds it, its finished turn only once the conductor touched it; koloft discord send uploads a file', async ({
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

      fake.say(OWNER, `/koloft session read ${managed}`)
      await expect
        .poll(() => bindingOnDisk(env)?.touched, { timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS })
        .toEqual([managed])
      await type('/answer after the touch')
      await expect
        .poll(() => notices(fake))
        .toEqual([expect.stringMatching(/^❓ /), expect.stringMatching(/^🔔 .+ finished\.$/)])

      fake.say(OWNER, '/koloft discord send shot.png -- here it is')
      await expect
        .poll(() => fake.posted.filter((p) => p.files.length))
        .toEqual([
          {
            channelId: CHANNEL,
            content: 'here it is',
            files: [{ name: 'shot.png', text: 'png bytes' }]
          }
        ])

      await type('/exit')
      await expect
        .poll(() => notices(fake))
        .toEqual([
          expect.stringMatching(/^❓ /),
          expect.stringMatching(/^🔔 /),
          expect.stringMatching(/^⏹ .+ closed\.$/)
        ])
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('the conductor’s own question is asked in the channel with its options, and a number sent back answers it', async ({
    env
  }) => {
    seedConductor(env, 'claude')
    const fake = await startFakeDiscord(env)
    const { app } = await connected(env, fake)
    try {
      fake.say(OWNER, '/ask Which colour?|Red|Green')
      await expect
        .poll(() => said(fake), { timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS })
        .toContain(
          '❓ Which colour?\n1. Red — The Red one\n2. Green — The Green one\n\nReply with a number or your own answer.'
        )
      const answer = fake.say(OWNER, '2')
      await expect.poll(() => said(fake)).toContain('Picked: Green')
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

  test('a Codex conductor gets the owner message queued with a Discord message id, its reply comes back, and its own approval is answered by a yes from the channel', async ({
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
        .toContain('❓ Codex asks to run: echo approved\nReply yes or no.')
      fake.say(OWNER, 'yes')
      await expect
        .poll(() => said(fake))
        .toContain('Codex fixture answered: [Discord] please approve this')
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })
})
