import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  installAgy,
  installCodex,
  installMuse,
  seedSettings,
  trustInAgy,
  trustInMuse,
  type E2EEnv
} from './helpers/env'
import {
  closeActiveTab,
  picksFor,
  startSessionIn,
  terminalText,
  waitBooted,
  waitConductorStarted
} from './helpers/p1'
import {
  OTHER_AGENTS_ON_THE_MACHINE,
  REMOTE_WS_NAME,
  addRemoteWorkspace,
  killFakeRemote,
  launchWithRemote
} from './helpers/remote'
import {
  agentProposes,
  askDialog,
  butlerVersions,
  ownerWrites,
  startIn,
  versionsOnDisk
} from './helpers/instructions'
import { startFakeDiscord, type FakeDiscord, type FakePost } from './helpers/fakeDiscord'
import type { BackendId, SessionInfo } from '../../src/shared/types'
import {
  CHANGED,
  CHANGED_MEANWHILE,
  CHANGED_ON_THE_COMPUTER,
  NOT_CHANGED,
  STOPPED_WAITING
} from '../../src/plugins/discord/main/instructionCards'
import { SESSION_CLOSED } from '../../src/plugins/discord/main/buttons'
import { INSTRUCTIONS_CHANGED_MEANWHILE } from '../../src/plugins/sessions/shared/instructionAsks'

test.setTimeout(240_000)
test.afterEach(({ env }) => killFakeRemote(env))

const OWNER = { id: '555', username: 'letian' }
const CHANNEL = '222'
const STARTS_AND_ANSWERS_MS = 90_000
const A_CARD_WOULD_HAVE_LANDED_MS = 3000
const WRITTEN = 'Answer in Chinese.'

function seedBinding(env: E2EEnv, more: Parameters<typeof seedSettings>[1] = {}): void {
  seedSettings(env, {
    hintsOff: true,
    assist: { backend: 'claude' },
    discord: {
      userId: OWNER.id,
      userName: OWNER.username,
      channel: { guildId: '111', channelId: CHANNEL, name: 'koloft-all' }
    },
    ...more
  })
}

async function connected(
  env: E2EEnv,
  fake: FakeDiscord,
  launch: () => Promise<{ app: ElectronApplication; page: Page }>
): Promise<{ app: ElectronApplication; page: Page }> {
  const { app, page } = await launch()
  await waitBooted(page)
  await expect.poll(() => fake.identifies).toBe(1)
  await waitConductorStarted(env, STARTS_AND_ANSWERS_MS)
  return { app, page }
}

const onThisMac = (env: E2EEnv) => async () => {
  const app = await launchApp(env)
  return { app, page: await app.firstWindow() }
}

const cardsFor = (fake: FakeDiscord, line: string, channelId: string): FakePost[] =>
  fake.posted.filter((p) => p.channelId === channelId && p.content.includes(`+ ${line}`))

async function cardFor(fake: FakeDiscord, line: string, channelId = CHANNEL): Promise<FakePost> {
  await expect
    .poll(() => cardsFor(fake, line, channelId).length, { timeout: STARTS_AND_ANSWERS_MS })
    .toBe(1)
  return cardsFor(fake, line, channelId)[0]
}

const endOf = (fake: FakeDiscord, card: FakePost): string =>
  fake.edits
    .filter((e) => e.id === card.id)
    .map((e) => e.content)
    .join('\n')

async function endsAs(fake: FakeDiscord, card: FakePost, footer: string): Promise<void> {
  await expect.poll(() => endOf(fake, card)).toContain(`-# ${footer}`)
  expect(fake.edits.filter((e) => e.id === card.id).at(-1)?.buttons ?? []).toEqual([])
}

async function liveSession(page: Page, wanted: (s: SessionInfo) => boolean): Promise<SessionInfo> {
  let found: SessionInfo | undefined
  await expect
    .poll(
      async () => {
        const all = await page.evaluate(() => window.api.sessions.list())
        found = all.find((s) => s.alive && !s.overseer && !!s.sessionId && wanted(s))
        return !!found
      },
      { timeout: STARTS_AND_ANSWERS_MS }
    )
    .toBe(true)
  return found!
}

function typeIn(page: Page, tabId: string, line: string): Promise<void> {
  return page.evaluate(([id, l]) => window.api.terminal.write(id, l + '\r'), [tabId, line])
}

function press(fake: FakeDiscord, card: FakePost, label: string): void {
  fake.press(
    OWNER,
    card.buttons!.find((b) => b.label === label)!,
    card.channelId
  )
}

async function phoneDeclinesThenAgrees(
  page: Page,
  env: E2EEnv,
  fake: FakeDiscord,
  wsName: string,
  backend: BackendId
): Promise<void> {
  const before = versionsOnDisk(env)
  const declined = `${backend} asked first: lint before pushing.`
  await agentProposes(page, declined)
  const first = await cardFor(fake, declined)
  expect(first.content).toMatch(/^❓ \*\*.+ · .+\*\* is waiting for you\./)
  expect(first.content.split('\n')[0]).toContain(wsName)
  press(fake, first, "Don't change")
  await expect(askDialog(page)).toHaveCount(0)
  await endsAs(fake, first, NOT_CHANGED)
  expect(versionsOnDisk(env)).toEqual(before)

  const agreed = `${backend} says: run npm test first.`
  await agentProposes(page, agreed)
  const second = await cardFor(fake, agreed)
  press(fake, second, 'Change them')
  await expect(askDialog(page)).toHaveCount(0)
  await expect
    .poll(() => versionsOnDisk(env).at(-1)?.text)
    .toBe(`${before.at(-1)?.text ?? ''}\n${agreed}`)
  await endsAs(fake, second, CHANGED)
}

async function withOneSession(
  env: E2EEnv,
  body: (page: Page, fake: FakeDiscord, app: ElectronApplication) => Promise<void>
): Promise<void> {
  const fake = await startFakeDiscord(env)
  const { app, page } = await connected(env, fake, onThisMac(env))
  try {
    await ownerWrites(page, 'ws-a', WRITTEN)
    await startSessionIn(page, 'ws-a')
    await body(page, fake, app)
  } finally {
    await quitAndClose(app)
    await fake.close()
  }
}

test.describe('Discord: the owner agrees on the phone to an agent’s proposed change to the Instructions', () => {
  test('on this Mac, a Claude Code, Codex, Muse and Antigravity session with no room each post their change to the butler’s channel, naming the session and its workspace; Don’t change writes nothing, Change them writes the line, and the box at the Mac goes either way', async ({
    env
  }) => {
    seedBinding(env)
    installCodex(env)
    installMuse(env)
    installAgy(env)
    trustInMuse(env, env.workspaces.a)
    trustInAgy(env, env.workspaces.a)
    const fake = await startFakeDiscord(env)
    const { app, page } = await connected(env, fake, onThisMac(env))
    try {
      await ownerWrites(page, 'ws-a', WRITTEN)
      for (const backend of ['claude', 'codex', 'muse', 'agy'] as const) {
        await startIn(page, 'ws-a', backend)
        await phoneDeclinesThenAgrees(page, env, fake, 'ws-a', backend)
      }
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('on a remote workspace, a Claude Code, Codex, Muse and Antigravity session each post their change the same way, and Change them writes that workspace’s own instructions', async ({
    env
  }) => {
    seedBinding(env)
    for (const agent of OTHER_AGENTS_ON_THE_MACHINE) agent.install(env)
    const fake = await startFakeDiscord(env)
    const { app, page } = await connected(env, fake, () => launchWithRemote(env))
    try {
      await addRemoteWorkspace(page, env)
      await ownerWrites(page, REMOTE_WS_NAME, WRITTEN)
      for (const backend of ['claude', 'codex', 'muse', 'agy'] as const) {
        await startIn(page, REMOTE_WS_NAME, backend)
        await phoneDeclinesThenAgrees(page, env, fake, REMOTE_WS_NAME, backend)
      }
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('the butler’s own change, asked from Discord, comes as a card in its channel under its name, and Change them there writes its instructions', async ({
    env
  }) => {
    seedBinding(env)
    const fake = await startFakeDiscord(env)
    const { app } = await connected(env, fake, onThisMac(env))
    try {
      const line = 'Ask me before any session merges a pull request.'
      fake.say(OWNER, `/koloft instructions add -- ${line}`)
      const card = await cardFor(fake, line)
      expect(card.content).toMatch(/^❓ \*\*Alfred\*\* is waiting for you\./)
      expect(card.content).toContain("Alfred wants to change Alfred's instructions: 1 line added.")
      expect(butlerVersions(env)).toEqual([])
      press(fake, card, 'Change them')
      await expect
        .poll(() => butlerVersions(env).at(-1))
        .toMatchObject({ text: line, by: 'Alfred' })
      await endsAs(fake, card, CHANGED)
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('a helper the butler started proposes a line for the butler’s instructions: its card in the butler’s channel names it as the butler’s helper', async ({
    env
  }) => {
    seedBinding(env)
    const fake = await startFakeDiscord(env)
    const { app, page } = await connected(env, fake, onThisMac(env))
    try {
      const line = 'Keep helpers short.'
      fake.say(OWNER, `/koloft session new ${picksFor('claude')} --name Tidy -- sort it`)
      const helper = await liveSession(page, (s) => s.title === 'Tidy')
      await typeIn(page, helper.tabId, `/koloft instructions add -- ${line}`)
      const card = await cardFor(fake, line)
      expect(card.content).toMatch(/^❓ \*\*Tidy \(Alfred's helper\)\*\* is waiting for you\./)
      press(fake, card, 'Change them')
      await expect.poll(() => butlerVersions(env).at(-1)).toMatchObject({ text: line, by: 'Tidy' })
      await endsAs(fake, card, CHANGED)
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('a session with a room of its own posts its change in that room, under its own name, and not in the butler’s channel', async ({
    env
  }) => {
    seedBinding(env)
    const fake = await startFakeDiscord(env)
    const { app, page } = await connected(env, fake, onThisMac(env))
    try {
      const line = 'Rooms ask here.'
      await startSessionIn(page, 'ws-a')
      const session = await liveSession(page, (s) => !!s.sessionId)
      await typeIn(page, session.tabId, `/later /koloft instructions add -- ${line}`)
      fake.say(OWNER, `/koloft discord thread open ${session.sessionId}`)
      await expect
        .poll(() => fake.threads.filter((t) => t.parent_id === CHANNEL).length, {
          timeout: STARTS_AND_ANSWERS_MS
        })
        .toBe(1)
      const room = fake.threads.find((t) => t.parent_id === CHANNEL)!
      fs.writeFileSync(path.join(env.home, 'go-later'), '')
      const card = await cardFor(fake, line, room.id)
      expect(card.content).toMatch(/^❓ \*\*[^·*]+\*\* is waiting for you\./)
      expect(cardsFor(fake, line, CHANNEL)).toEqual([])
      press(fake, card, 'Change them')
      await expect.poll(() => versionsOnDisk(env).at(-1)?.text).toBe(line)
      await endsAs(fake, card, CHANGED)
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('answered at the Mac first, the card loses its buttons and says what was answered there', async ({
    env
  }) => {
    seedBinding(env)
    await withOneSession(env, async (page, fake) => {
      const line = 'Answered at the Mac.'
      await agentProposes(page, line)
      const card = await cardFor(fake, line)
      await askDialog(page).getByRole('button', { name: 'Change them' }).click()
      await endsAs(fake, card, CHANGED_ON_THE_COMPUTER)
      expect(versionsOnDisk(env).at(-1)?.text).toBe(`${WRITTEN}\n${line}`)
      press(fake, card, 'Change them')
      await expect
        .poll(() => fake.callbacks.map((c) => c.data.content))
        .toContain('Koloft is no longer waiting for this.')
    })
  })

  test('when nobody answers in time, the card says Koloft stopped waiting and nothing changed, and the agent is told', async ({
    env
  }) => {
    seedBinding(env)
    env.launchEnv.KOLOFT_INSTRUCTIONS_ASK_MS = '8000'
    await withOneSession(env, async (page, fake) => {
      const line = 'Nobody answers this.'
      await agentProposes(page, line)
      const card = await cardFor(fake, line)
      await endsAs(fake, card, STOPPED_WAITING)
      await expect(askDialog(page)).toHaveCount(0)
      expect(versionsOnDisk(env).at(-1)?.text).toBe(WRITTEN)
    })
  })

  test('closing the session ends its card with The session closed', async ({ env }) => {
    seedBinding(env)
    await withOneSession(env, async (page, fake, app) => {
      const line = 'Closed before an answer.'
      await agentProposes(page, line)
      const card = await cardFor(fake, line)
      await closeActiveTab(app, page)
      await endsAs(fake, card, SESSION_CLOSED)
      expect(versionsOnDisk(env).at(-1)?.text).toBe(WRITTEN)
    })
  })

  test('agreed on the phone after the owner rewrote the text at the Mac: nothing is written, the card says the instructions changed meanwhile, and the Mac shows it too', async ({
    env
  }) => {
    seedBinding(env)
    await withOneSession(env, async (page, fake) => {
      const line = 'Lost to a rewrite.'
      await agentProposes(page, line)
      const card = await cardFor(fake, line)
      await ownerWrites(page, 'ws-a', 'The owner rewrote it.')
      press(fake, card, 'Change them')
      await expect(page.locator('.toast-msg')).toContainText(INSTRUCTIONS_CHANGED_MEANWHILE)
      await endsAs(fake, card, CHANGED_MEANWHILE)
      expect(versionsOnDisk(env).at(-1)?.text).toBe('The owner rewrote it.')
    })
  })

  test('while the owner is at the Mac the ask shows only there; once the owner is away, its card follows', async ({
    env
  }) => {
    seedBinding(env)
    const presence = path.join(env.home, 'presence.txt')
    fs.writeFileSync(presence, 'active')
    env.launchEnv.KOLOFT_TEST_PRESENCE_FILE = presence
    await withOneSession(env, async (page, fake) => {
      const line = 'Asked while at the Mac.'
      await agentProposes(page, line)
      await page.waitForTimeout(A_CARD_WOULD_HAVE_LANDED_MS)
      expect(cardsFor(fake, line, CHANNEL)).toEqual([])
      fs.writeFileSync(presence, 'idle')
      const card = await cardFor(fake, line)
      press(fake, card, "Don't change")
      await endsAs(fake, card, NOT_CHANGED)
      await expect(askDialog(page)).toHaveCount(0)
    })
  })

  test('with Discord turned off in Settings ▸ Plugins, no card is posted and the box at the Mac works as before', async ({
    env
  }) => {
    seedBinding(env, { pluginsOn: { discord: false } })
    const fake = await startFakeDiscord(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await ownerWrites(page, 'ws-a', WRITTEN)
      await startSessionIn(page, 'ws-a')
      const tab = (await page.evaluate(() => window.api.sessions.list())).find(
        (s) => s.alive && !s.overseer
      )!.tabId
      const line = 'Discord is off.'
      await agentProposes(page, line)
      await askDialog(page).getByRole('button', { name: 'Change them' }).click()
      await expect
        .poll(() => terminalText(page, tab), { timeout: STARTS_AND_ANSWERS_MS })
        .toContain('The owner agreed')
      expect(versionsOnDisk(env).at(-1)?.text).toBe(`${WRITTEN}\n${line}`)
      expect(fake.posted.filter((p) => p.content.includes(line))).toEqual([])
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })
})
