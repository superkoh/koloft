import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { installCodex, seedSettings, type E2EEnv } from './helpers/env'
import {
  newSessionInWith,
  settingsOnDisk,
  startSessionIn,
  terminalText,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'
import {
  AUTOCOMPLETE,
  startFakeDiscord,
  type FakeDiscord,
  type FakePost
} from './helpers/fakeDiscord'
import type { ConductorBinding, DiscordSettings } from '../../src/shared/types'

test.setTimeout(120_000)

const OWNER = { id: '555', username: 'letian' }
const STRANGER = { id: '556', username: 'someone' }
const CHANNEL = '222'
const CONDUCTOR_STARTS_AND_ANSWERS_MS = 60_000
const ONLY_THE_SENDER_SEES_IT = 64
const BACKGROUND_OUTLASTS_THE_CASE_MS = 90_000

function seedConductor(env: E2EEnv): void {
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

function ranPosts(fake: FakeDiscord): FakePost[] {
  return fake.posted.filter((p) => p.content.startsWith('⌨️ '))
}

function ran(fake: FakeDiscord): string[] {
  return ranPosts(fake).map((p) => p.content)
}

function threadUnderChannel(fake: FakeDiscord, channelId: string): boolean {
  return fake.threads.some((t) => t.id === channelId && t.parentId === CHANNEL)
}

function replyTo(fake: FakeDiscord, interactionId: string): string | undefined {
  return fake.callbacks.find((c) => c.interactionId === interactionId)?.data.content
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

async function choices(
  fake: FakeDiscord,
  typed: string
): Promise<{ name: string; value: string }[]> {
  const id = fake.interact(
    OWNER,
    'run',
    { command: '', session: typed },
    {
      type: AUTOCOMPLETE,
      focused: 'session'
    }
  )
  await expect.poll(() => fake.callbacks.some((c) => c.interactionId === id)).toBe(true)
  return fake.callbacks.find((c) => c.interactionId === id)?.data.choices ?? []
}

test.describe('Discord slash commands: the owner runs /clear, /compact and any slash command in a session, or in the conductor', () => {
  test('D-CMD-1: Koloft registers /run, /clear and /compact; /run types a command into a Claude session picked from autocomplete and posts what it printed in that session’s thread; /compact sent in that thread with no session picked runs in it and posts Compacted; someone else is refused privately', async ({
    env
  }) => {
    seedConductor(env)
    const fake = await startFakeDiscord(env)
    const { app, page } = await connected(env, fake)
    try {
      await expect
        .poll(() => fake.commands.map((c) => c.name).sort())
        .toEqual(['clear', 'compact', 'run'])
      await startSessionIn(page, 'ws-a')
      const child = (await waitForCalls(env, 1))[0].sessionId
      await expect(wsRows(page, 'ws-a')).toHaveClass(/st-waiting/, { timeout: 30_000 })

      const listed = await choices(fake, '')
      expect(listed[0].value).toBe('me')
      expect(listed.map((c) => c.value)).toContain(child)

      const asked = fake.interact(OWNER, 'run', { command: '/context', session: child })
      await expect.poll(() => replyTo(fake, asked)).toMatch(/^Typing \/context into /)
      await expect
        .poll(() => ran(fake), { timeout: 30_000 })
        .toEqual([
          expect.stringMatching(/ran \/context:\n## Context Usage\n\n\*\*Tokens:\*\* 28\.5k/)
        ])
      const thread = ranPosts(fake)[0].channelId
      expect(threadUnderChannel(fake, thread)).toBe(true)

      fake.interact(OWNER, 'compact', {}, { channelId: thread })
      await expect
        .poll(() => ran(fake).at(-1), { timeout: 30_000 })
        .toMatch(/ran \/compact:\nCompacted \(ctrl\+o to see full summary\)$/)
      expect(ranPosts(fake).at(-1)?.channelId).toBe(thread)
      await expect(wsRows(page, 'ws-a')).toHaveClass(/st-waiting/, { timeout: 30_000 })

      const refused = fake.interact(STRANGER, 'clear', { session: child })
      await expect
        .poll(() => fake.callbacks.find((c) => c.interactionId === refused)?.data.flags)
        .toBe(ONLY_THE_SENDER_SEES_IT)
      expect(bindingOnDisk(env)?.touched).toContain(child)
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('D-CMD-2: a message that starts with a slash runs in the conductor itself; its /clear gives the conductor a new conversation that it keeps on the next start', async ({
    env
  }) => {
    seedConductor(env)
    const fake = await startFakeDiscord(env)
    const { app } = await connected(env, fake)
    try {
      fake.say(OWNER, 'hello')
      await expect
        .poll(() => said(fake), { timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS })
        .toContain('Answer to: [Discord] hello')
      const before = bindingOnDisk(env)?.lastSessionKey
      expect(before).toBeTruthy()

      fake.say(OWNER, '/clear')
      await expect
        .poll(() => ran(fake), { timeout: 30_000 })
        .toEqual([
          expect.stringMatching(/conductor\*\* ran \/clear:\nIt is a new conversation now/)
        ])
      expect(ranPosts(fake)[0].channelId).toBe(CHANNEL)
      await expect.poll(() => bindingOnDisk(env)?.lastSessionKey).not.toBe(before)
      expect(said(fake).join('\n')).not.toContain('[Discord] /clear')
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('D-CMD-3: in a Codex session, /compact runs the compaction turn and /clear starts a new conversation', async ({
    env
  }) => {
    installCodex(env)
    seedConductor(env)
    const fake = await startFakeDiscord(env)
    const { app, page } = await connected(env, fake)
    try {
      await newSessionInWith(page, 'ws-a', 'Codex')
      await expect(wsRows(page, 'ws-a')).toHaveClass(/st-waiting/, { timeout: 60_000 })
      const codex = (await choices(fake, 'Codex')).find((c) => c.value !== 'me')
      expect(codex).toBeTruthy()

      fake.interact(OWNER, 'compact', { session: codex!.value })
      await expect
        .poll(() => ran(fake), { timeout: 30_000 })
        .toEqual([expect.stringMatching(/ran \/compact:\nDone\.$/)])
      const wire = fs.readFileSync(path.join(env.home, 'fake-codex-wire.jsonl'), 'utf8')
      expect(wire).toContain('"method":"thread/compact/start"')

      fake.interact(OWNER, 'clear', { session: codex!.value })
      await expect
        .poll(() => ran(fake).at(-1), { timeout: 30_000 })
        .toMatch(/ran \/clear:\nIt is a new conversation now/)
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  // CC§8
  test('D-CMD-5: a slash command is typed into a session at once when its turn is over, though background work it left running still shows ↻ on its row', async ({
    env
  }) => {
    seedConductor(env)
    const fake = await startFakeDiscord(env)
    const { app, page } = await connected(env, fake)
    try {
      await startSessionIn(page, 'ws-a')
      const child = (await waitForCalls(env, 1))[0].sessionId
      await expect(wsRows(page, 'ws-a')).toHaveClass(/st-waiting/, { timeout: 30_000 })
      const tab = (await page.evaluate(() => window.api.sessions.list())).find(
        (s) => s.sessionId === child
      )!.tabId
      fs.writeFileSync(
        path.join(env.home, 'fake-claude-bg-ms'),
        String(BACKGROUND_OUTLASTS_THE_CASE_MS)
      )
      await page.evaluate((id) => window.api.terminal.write(id, '/bg-reported\r'), tab)
      await expect.poll(() => terminalText(page, tab)).toContain('bg-reported running')
      await expect(wsRows(page, 'ws-a').locator('.ws-tab-parked.bg-run')).toBeVisible()

      fake.interact(OWNER, 'run', { command: '/context', session: child })
      await expect
        .poll(() => ran(fake), { timeout: 30_000 })
        .toEqual([expect.stringMatching(/ran \/context:\n## Context Usage/)])
      expect(await terminalText(page, tab)).not.toContain('bg-reported finished')
      await expect(wsRows(page, 'ws-a').locator('.ws-tab-parked.bg-run')).toBeVisible()
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('D-CMD-4: the conductor runs koloft session command in a session it looks after, and koloft session screen shows that session’s terminal', async ({
    env
  }) => {
    seedConductor(env)
    const fake = await startFakeDiscord(env)
    const { app, page } = await connected(env, fake)
    try {
      await startSessionIn(page, 'ws-a')
      const child = (await waitForCalls(env, 1))[0].sessionId
      await expect(wsRows(page, 'ws-a')).toHaveClass(/st-waiting/, { timeout: 30_000 })

      fake.say(OWNER, `/koloft session command ${child} /context`)
      await expect
        .poll(() => ran(fake), { timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS })
        .toContainEqual(expect.stringMatching(/ran \/context:\n## Context Usage/))

      fake.say(OWNER, `/koloft session screen ${child}`)
      const conductorTab =
        (await page.evaluate(() => window.api.sessions.list())).find((s) => s.conductor)?.tabId ??
        ''
      await expect
        .poll(() => terminalText(page, conductorTab), { timeout: 30_000 })
        .toContain('The screen of')
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })
})
