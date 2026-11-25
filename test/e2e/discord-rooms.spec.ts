import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, pendingAttention, quitAndClose } from './helpers/app'
import { installAgy, installCodex, seedSettings, trustInAgy, type E2EEnv } from './helpers/env'
import {
  centerTerm,
  newSessionInWith,
  runIn,
  startSessionIn,
  terminalText,
  waitBooted,
  waitConductorStarted,
  picksFor,
  type AgentName
} from './helpers/p1'
import { startFakeDiscord, type FakeDiscord, type FakeThread } from './helpers/fakeDiscord'
import {
  addRemoteWorkspace,
  installCodexOnFakeRemote,
  installFakeRemote,
  installRemoteAgy,
  killFakeRemote,
  machineHome,
  promptContextsOnTheMachine,
  REMOTE_HOST,
  REMOTE_WS_NAME
} from './helpers/remote'
import type { BackendId, SessionInfo } from '../../src/shared/types'
import { agentSessionId, identityOf } from '../../src/shared/sessionBackend'
import { CLOSED_IN_ROOM, STARTED_OVER_IN_ROOM } from '../../src/plugins/discord/main/rooms'
import { NOT_FROM_THE_RELAY, NOT_SENT_BY_KOLOFT } from '../../src/plugins/sessions/main/hooks'

test.setTimeout(180_000)

const OWNER = { id: '555', username: 'letian' }
const CHANNEL = '222'
const STARTS_AND_ANSWERS_MS = 90_000
const ONE_DAY_MINUTES = 1440
const AGENT_NAME: Record<BackendId, AgentName> = {
  claude: 'Claude',
  codex: 'Codex',
  agy: 'Antigravity'
}

function seedButler(env: E2EEnv): void {
  seedSettings(env, {
    hintsOff: true,
    assist: { backend: 'claude' },
    discord: {
      userId: OWNER.id,
      userName: OWNER.username,
      channel: { guildId: '111', channelId: CHANNEL, name: 'koloft-all' }
    }
  })
}

async function connected(
  env: E2EEnv,
  fake: FakeDiscord
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await waitBooted(page)
  await expect.poll(() => fake.identifies).toBe(1)
  await waitConductorStarted(env, STARTS_AND_ANSWERS_MS)
  return { app, page }
}

function inRoom(fake: FakeDiscord, threadId: string): string[] {
  return fake.posted.filter((p) => p.channelId === threadId).map((p) => p.content)
}

function inLobby(fake: FakeDiscord): string[] {
  return fake.posted.filter((p) => p.channelId === CHANNEL).map((p) => p.content)
}

async function theRoom(fake: FakeDiscord): Promise<FakeThread> {
  await expect
    .poll(() => fake.threads.filter((t) => t.parent_id === CHANNEL).length, {
      timeout: STARTS_AND_ANSWERS_MS
    })
    .toBe(1)
  return fake.threads.find((t) => t.parent_id === CHANNEL)!
}

async function sessionOf(page: Page, backend: BackendId): Promise<SessionInfo> {
  let found: SessionInfo | undefined
  await expect
    .poll(
      async () => {
        const all = await page.evaluate(() => window.api.sessions.list())
        found = all.find((s) => s.alive && !s.overseer && s.backendId === backend && s.sessionId)
        return !!found
      },
      { timeout: STARTS_AND_ANSWERS_MS }
    )
    .toBe(true)
  return found!
}

async function talkedToInItsRoom(
  page: Page,
  fake: FakeDiscord,
  backend: BackendId,
  workspace: string,
  onTheMachine?: (session: SessionInfo, messageId: string) => Promise<void>
): Promise<void> {
  fake.say(
    OWNER,
    `/koloft session new ${picksFor(backend)} --workspace ${workspace} --backend ${backend} -- warm up`
  )
  const room = await theRoom(fake)
  expect(room.auto_archive_duration).toBe(ONE_DAY_MINUTES)
  await expect
    .poll(() => fake.threadMembers)
    .toContainEqual({ threadId: room.id, userId: OWNER.id })
  const butler = (await page.evaluate(() => window.api.sessions.list())).find((s) => s.overseer)!
  await expect
    .poll(() => terminalText(page, butler.tabId), { timeout: STARTS_AND_ANSWERS_MS })
    .toContain(`<#${room.id}>`)
  await expect.poll(() => inRoom(fake, room.id).some((p) => p.includes('where it is'))).toBe(true)
  const session = await sessionOf(page, backend)
  const onTheMachineToo =
    session.remote?.host === REMOTE_HOST || identityOf(session.sessionId)?.sourceId === REMOTE_HOST
  expect(onTheMachineToo).toBe(workspace === REMOTE_WS_NAME)

  await expect
    .poll(async () => (await sessionOf(page, backend)).status, { timeout: STARTS_AND_ANSWERS_MS })
    .toBe('waiting')
  const asked = fake.say(OWNER, 'how is the room', { channelId: room.id })
  await expect
    .poll(() => inRoom(fake, room.id).some((p) => p.includes('how is the room')), {
      timeout: STARTS_AND_ANSWERS_MS
    })
    .toBe(true)
  await onTheMachine?.(session, asked)
  expect(inLobby(fake).some((p) => p.includes('how is the room'))).toBe(false)

  expect(fake.archived).not.toContain(room.id)
  await page.evaluate((id) => window.api.terminal.write(id, 'x'), session.tabId)
  await expect.poll(() => fake.archived).toContain(room.id)
}

async function withTheButler(
  env: E2EEnv,
  body: (page: Page, fake: FakeDiscord, app: ElectronApplication) => Promise<void>
): Promise<void> {
  seedButler(env)
  const fake = await startFakeDiscord(env)
  const { app, page } = await connected(env, fake)
  try {
    await body(page, fake, app)
  } finally {
    await quitAndClose(app)
    await fake.close()
  }
}

async function withTheButlerAndARemoteWorkspace(
  env: E2EEnv,
  body: (page: Page, fake: FakeDiscord, app: ElectronApplication) => Promise<void>
): Promise<void> {
  installFakeRemote(env)
  try {
    await withTheButler(env, async (page, fake, app) => {
      await addRemoteWorkspace(page, env)
      await body(page, fake, app)
    })
  } finally {
    killFakeRemote(env)
  }
}

const LOCAL: { backend: BackendId; install: (env: E2EEnv) => void }[] = [
  { backend: 'claude', install: () => {} },
  { backend: 'codex', install: installCodex },
  { backend: 'agy', install: installAgy }
]

const REMOTE: { backend: BackendId; install: (env: E2EEnv) => void }[] = [
  { backend: 'claude', install: () => {} },
  { backend: 'codex', install: installCodexOnFakeRemote },
  {
    backend: 'agy',
    install: (env) => {
      installAgy(env)
      installRemoteAgy(env)
    }
  }
]

test.describe('Discord rooms: a session the owner carries on the phone has a room of its own under the butler’s channel', () => {
  for (const { backend, install } of LOCAL)
    test(`a local ${backend} session the butler starts while answering the owner on Discord gets its room at once: a thread on a card in the butler’s channel that folds after a day, the owner added to it, its link in the butler’s answer and a card of where it is; what the owner writes there reaches that session alone and its reply comes back there; a key the owner presses in its terminal at the Mac puts the room down`, async ({
      env
    }) => {
      install(env)
      await withTheButler(env, (page, fake) => talkedToInItsRoom(page, fake, backend, 'ws-a'))
    })

  for (const { backend, install } of REMOTE)
    test(`a ${backend} session on another machine gets its room the same way, and what the owner writes there reaches it on that machine, a Claude or Codex one told it is the owner’s words and never that Koloft did not send it, and its reply comes back there`, async ({
      env
    }) => {
      test.setTimeout(300_000)
      install(env)
      await withTheButlerAndARemoteWorkspace(env, (page, fake) =>
        talkedToInItsRoom(page, fake, backend, REMOTE_WS_NAME, async (session, messageId) => {
          const marks = path.join(machineHome(env), '.koloft', 'hook-sessions', session.tabId)
          if (backend === 'claude')
            expect(fs.readFileSync(`${marks}.discord-ids`, 'utf8')).toContain(
              `koloft-discord-${messageId}`
            )
          if (backend !== 'agy') {
            const contexts = (): string[] =>
              promptContextsOnTheMachine(env, backend, agentSessionId(session.sessionId))
            await expect
              .poll(() => contexts().some((c) => c.includes('«how is the room»')))
              .toBe(true)
            expect(
              contexts().filter(
                (c) => c.includes(NOT_FROM_THE_RELAY) || c.includes(NOT_SENT_BY_KOLOFT)
              )
            ).toEqual([])
          }
        })
      )
    })

  test('a session started at the Mac keeps the same room each time the butler opens it, and the room stays carried through a restart and a /clear typed in the room; closing the session posts that it closed before the room is archived, and writing in the room of the closed session resumes it and hands it the words', async ({
    env
  }) => {
    await withTheButler(env, async (page, fake, app) => {
      await startSessionIn(page, 'ws-a')
      const first = await sessionOf(page, 'claude')
      fake.say(OWNER, `/koloft discord thread open ${first.sessionId}`)
      const room = await theRoom(fake)
      await expect
        .poll(() => inRoom(fake, room.id).filter((p) => p.includes('where it is')).length, {
          timeout: STARTS_AND_ANSWERS_MS
        })
        .toBe(1)
      fake.say(OWNER, `/koloft discord thread open ${first.sessionId}`)
      await expect
        .poll(() => inRoom(fake, room.id).filter((p) => p.includes('where it is')).length, {
          timeout: STARTS_AND_ANSWERS_MS
        })
        .toBe(2)
      expect(fake.threads).toHaveLength(1)

      await app.evaluate(({ Menu }) =>
        Menu.getApplicationMenu()?.getMenuItemById('restart-session')?.click()
      )
      await expect
        .poll(async () => (await sessionOf(page, 'claude')).tabId, {
          timeout: STARTS_AND_ANSWERS_MS
        })
        .not.toBe(first.tabId)
      const session = await sessionOf(page, 'claude')
      expect(session.sessionId).toBe(first.sessionId)
      fake.say(OWNER, 'after the restart', { channelId: room.id })
      await expect
        .poll(() => inRoom(fake, room.id).some((p) => p.includes('after the restart')), {
          timeout: STARTS_AND_ANSWERS_MS
        })
        .toBe(true)
      expect(inRoom(fake, room.id)).not.toContain(CLOSED_IN_ROOM)

      fake.say(OWNER, '/clear', { channelId: room.id })
      await expect
        .poll(() => inRoom(fake, room.id), { timeout: STARTS_AND_ANSWERS_MS })
        .toContain(STARTED_OVER_IN_ROOM)
      await expect
        .poll(async () => (await sessionOf(page, 'claude')).sessionId)
        .not.toBe(session.sessionId)
      const cleared = await sessionOf(page, 'claude')

      fake.say(OWNER, '/koloft session stop ' + cleared.sessionId)
      await expect
        .poll(() => inRoom(fake, room.id), { timeout: STARTS_AND_ANSWERS_MS })
        .toContain(CLOSED_IN_ROOM)
      await expect.poll(() => fake.archived).toContain(room.id)
      const closedAt = fake.posted.findIndex(
        (p) => p.channelId === room.id && p.content === CLOSED_IN_ROOM
      )
      expect(fake.postsBeforeArchive[fake.archived.indexOf(room.id)]).toBeGreaterThan(closedAt)

      fake.say(OWNER, 'back to work', { channelId: room.id })
      await expect
        .poll(() => inRoom(fake, room.id).some((p) => p.includes('back to work')), {
          timeout: STARTS_AND_ANSWERS_MS
        })
        .toBe(true)
      const resumed = await sessionOf(page, 'claude')
      expect(resumed.tabId).not.toBe(session.tabId)
    })
  })

  for (const { backend, install, remote } of [
    ...LOCAL.map((kind) => ({ ...kind, remote: false })),
    ...REMOTE.map((kind) => ({ ...kind, remote: true }))
  ]) {
    const startsOver = backend === 'codex' ? '/new' : '/clear'
    const where = remote ? 'on another machine' : 'at the Mac'
    const title = `a ${startsOver} in a ${backend} tab ${where} while Discord is turned off still carries the room, after a turn in the new conversation too: once Discord is on again and the session restarts, what the owner writes in the room reaches the new conversation, not the old one`
    const run = backend === 'codex' ? test.fixme : test
    run(
      backend === 'codex'
        ? `${title} (#2280: a Codex /new leaves the room behind even with Discord on)`
        : title,
      async ({ env }) => {
        install(env)
        if (!remote && backend === 'agy') trustInAgy(env, env.workspaces.a)
        const ws = remote ? REMOTE_WS_NAME : 'ws-a'
        await (remote ? withTheButlerAndARemoteWorkspace : withTheButler)(
          env,
          async (page, fake, app) => {
            if (backend === 'claude') await startSessionIn(page, ws, { remote })
            else await newSessionInWith(page, ws, AGENT_NAME[backend])
            if (backend === 'agy') await runIn(page, centerTerm(page), 'warm up')
            const first = await sessionOf(page, backend)
            await expect
              .poll(async () => (await sessionOf(page, backend)).status, {
                timeout: STARTS_AND_ANSWERS_MS
              })
              .toBe('waiting')
            fake.say(OWNER, `/koloft discord thread open ${first.sessionId}`)
            const room = await theRoom(fake)
            await expect
              .poll(() => inRoom(fake, room.id).some((p) => p.includes('where it is')), {
                timeout: STARTS_AND_ANSWERS_MS
              })
              .toBe(true)

            await page.evaluate(() => window.api.settings.set({ pluginsOn: { discord: false } }))
            await page.evaluate(({ id, line }) => window.api.terminal.write(id, `${line}\r`), {
              id: first.tabId,
              line: startsOver
            })
            const turnWhileOff = (): Promise<void> =>
              page.evaluate(
                (id) => window.api.terminal.write(id, 'while it was off\r'),
                first.tabId
              )
            const idComesWithTheFirstTurn = backend === 'agy'
            if (idComesWithTheFirstTurn) await turnWhileOff()
            await expect
              .poll(async () => (await sessionOf(page, backend)).sessionId, {
                timeout: STARTS_AND_ANSWERS_MS
              })
              .not.toBe(first.sessionId)
            const cleared = await sessionOf(page, backend)
            if (!idComesWithTheFirstTurn) await turnWhileOff()
            await expect
              .poll(
                async () =>
                  (await pendingAttention(page)).some((e) => e.sessionId === cleared.sessionId),
                { timeout: STARTS_AND_ANSWERS_MS }
              )
              .toBe(true)

            await page.evaluate(() => window.api.settings.set({ pluginsOn: { discord: true } }))
            await expect.poll(() => fake.identifies, { timeout: STARTS_AND_ANSWERS_MS }).toBe(2)
            await app.evaluate(({ Menu }) =>
              Menu.getApplicationMenu()?.getMenuItemById('restart-session')?.click()
            )
            await expect
              .poll(async () => (await sessionOf(page, backend)).tabId, {
                timeout: STARTS_AND_ANSWERS_MS
              })
              .not.toBe(first.tabId)
            const restarted = await sessionOf(page, backend)
            expect(restarted.sessionId).toBe(cleared.sessionId)

            fake.say(OWNER, 'after the switch', { channelId: room.id })
            await expect
              .poll(() => inRoom(fake, room.id).some((p) => p.includes('after the switch')), {
                timeout: STARTS_AND_ANSWERS_MS
              })
              .toBe(true)
            const live = (await page.evaluate(() => window.api.sessions.list())).filter(
              (s) => s.alive && !s.overseer
            )
            expect(live.map((s) => s.sessionId)).toEqual([cleared.sessionId])
            expect(fake.threads).toHaveLength(1)
          }
        )
      }
    )
  }

  test('the butler opens the room of a session started at the Mac with koloft discord thread open, and prints its link; a helper in its own folder gets none', async ({
    env
  }) => {
    await withTheButler(env, async (page, fake) => {
      await startSessionIn(page, 'ws-a')
      const session = await sessionOf(page, 'claude')
      await expect
        .poll(async () => (await sessionOf(page, 'claude')).status, {
          timeout: STARTS_AND_ANSWERS_MS
        })
        .toBe('waiting')
      fake.say(OWNER, `/koloft discord thread open ${session.sessionId}`)
      const room = await theRoom(fake)
      const butler = (await page.evaluate(() => window.api.sessions.list())).find(
        (s) => s.overseer
      )!
      const butlerSaid = async (): Promise<string> =>
        (await terminalText(page, butler.tabId)).replace(/\n/g, '')
      await expect
        .poll(butlerSaid, { timeout: STARTS_AND_ANSWERS_MS })
        .toContain(
          `Opened the room of Fake session: project notes: <#${room.id}>. Give the owner that link exactly as written; Discord shows it as a link to the room.`
        )
      await expect
        .poll(() => inRoom(fake, room.id), { timeout: STARTS_AND_ANSWERS_MS })
        .toContain(
          '📍 **Fake session: project notes**: where it is\n-# ws-a · Claude\n\nIt finished its turn.\n\nIt last said: “Creating NOTES.md.”'
        )
      await expect
        .poll(() => fake.threadMembers)
        .toContainEqual({ threadId: room.id, userId: OWNER.id })

      fake.say(OWNER, `/koloft session new ${picksFor('claude')} --name Tidy -- sort it`)
      await expect
        .poll(
          async () =>
            (await page.evaluate(() => window.api.sessions.list())).some(
              (s) => s.alive && s.title === 'Tidy' && s.sessionId
            ),
          { timeout: STARTS_AND_ANSWERS_MS }
        )
        .toBe(true)
      fake.say(OWNER, '/koloft discord thread open Tidy')
      await expect
        .poll(butlerSaid, { timeout: STARTS_AND_ANSWERS_MS })
        .toContain(
          'koloft discord thread open: a helper in your own folder gets no room; its questions already come to your channel.'
        )
      expect(fake.threads).toHaveLength(1)
    })
  })

  test('the owner’s words in the butler’s channel go to the butler alone, never to a session whose room is open', async ({
    env
  }) => {
    await withTheButler(env, async (page, fake) => {
      fake.say(OWNER, `/koloft session new ${picksFor('claude')} --workspace ws-a -- warm up`)
      const room = await theRoom(fake)
      await sessionOf(page, 'claude')
      fake.say(OWNER, 'only for the butler')
      await expect
        .poll(() => inLobby(fake).some((p) => p.includes('only for the butler')), {
          timeout: STARTS_AND_ANSWERS_MS
        })
        .toBe(true)
      expect(inRoom(fake, room.id).some((p) => p.includes('only for the butler'))).toBe(false)
      const sessionHeard = fs.readFileSync(path.join(env.home, 'fake-claude-peer.jsonl'), 'utf8')
      expect(
        sessionHeard.split('\n').filter((l) => l.includes('only for the butler'))
      ).toHaveLength(1)
    })
  })
})
