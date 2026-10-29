import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  agySessionCalls,
  installAgy,
  installCodex,
  installMuse,
  museCalls,
  seedSettings,
  trustInMuse,
  type E2EEnv
} from './helpers/env'
import { startCodex } from './helpers/codex'
import {
  newSessionInWith,
  processAlive,
  startSessionIn,
  terminalText,
  waitBooted,
  waitConductorStarted,
  butlerSessionOnDisk,
  waitForCalls,
  wsRows,
  oneStillRunning
} from './helpers/p1'
import { startFakeDiscord, type FakeDiscord, type FakePost } from './helpers/fakeDiscord'

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
      channel: { guildId: '111', channelId: CHANNEL, name: 'koloft-all' }
    }
  })
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

function replyTo(fake: FakeDiscord, interactionId: string): string | undefined {
  return fake.callbacks.find((c) => c.interactionId === interactionId)?.data.content
}

function handedToTheButler(env: E2EEnv): string[] {
  const file = path.join(env.home, 'fake-claude-peer.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => (JSON.parse(l) as { message: { content: string } }).message.content)
    .filter((m) => m.includes('(From Koloft:) '))
}

async function butlerTab(page: Page): Promise<string> {
  return (await page.evaluate(() => window.api.sessions.list())).find((s) => s.butler)?.tabId ?? ''
}

async function butlerShownWorkingOnItsOpeningTurn(fake: FakeDiscord): Promise<void> {
  await expect.poll(() => fake.typing).toContain(CHANNEL)
}

async function connected(
  env: E2EEnv,
  fake: FakeDiscord
): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await waitBooted(page)
  await expect.poll(() => fake.identifies).toBe(1)
  await waitConductorStarted(env, CONDUCTOR_STARTS_AND_ANSWERS_MS)
  return { app, page }
}

test.describe('Discord slash commands: the owner runs /clear, /compact and any slash command in the butler, and the butler runs one in any session', () => {
  test('D-CMD-1: Koloft registers /run, /clear and /compact, none of them naming a session; /run types a command into the butler and posts what it printed in its channel; /compact compacts the butler and posts Compacted; someone else is refused privately', async ({
    env
  }) => {
    seedConductor(env)
    const fake = await startFakeDiscord(env)
    const { app } = await connected(env, fake)
    try {
      await expect
        .poll(() => fake.commands.map((c) => c.name).sort())
        .toEqual(['clear', 'compact', 'run'])
      expect(
        Object.fromEntries(fake.commands.map((c) => [c.name, (c.options ?? []).map((o) => o.name)]))
      ).toEqual({ run: ['command'], clear: [], compact: ['focus'] })

      await butlerShownWorkingOnItsOpeningTurn(fake)
      const asked = fake.interact(OWNER, 'run', { command: '/context' })
      await expect
        .poll(() => replyTo(fake, asked))
        .toBe(
          'Koloft will type /context into Alfred once its turn ends, and post what it prints in Discord.'
        )
      await expect
        .poll(() => ran(fake), { timeout: 30_000 })
        .toEqual([
          expect.stringMatching(
            /^⌨️ \*\*Alfred\*\* ran \/context:\n## Context Usage\n\n\*\*Tokens:\*\* 28\.5k/
          )
        ])
      expect(ranPosts(fake)[0].channelId).toBe(CHANNEL)

      fake.interact(OWNER, 'compact', {})
      await expect
        .poll(() => ran(fake).at(-1), { timeout: 30_000 })
        .toMatch(/\*\*Alfred\*\* ran \/compact:\nCompacted \(ctrl\+o to see full summary\)$/)
      expect(ranPosts(fake).at(-1)?.channelId).toBe(CHANNEL)

      const refused = fake.interact(STRANGER, 'clear', {})
      await expect
        .poll(() => fake.callbacks.find((c) => c.interactionId === refused)?.data.flags)
        .toBe(ONLY_THE_SENDER_SEES_IT)
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  // AGY§8
  test('a slash command that is the first thing an Antigravity butler opened on connect gets is typed into it, which gives it its conversation in the same process', async ({
    env
  }) => {
    installAgy(env)
    seedConductor(env)
    seedSettings(env, { assist: { on: true, backend: 'agy' } })
    const fake = await startFakeDiscord(env)
    const app = await launchApp(env)
    try {
      await waitBooted(await app.firstWindow())
      await expect.poll(() => fake.identifies).toBe(1)
      await expect
        .poll(() => agySessionCalls(env).length, { timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS })
        .toBe(1)
      fake.interact(OWNER, 'run', { command: '/model' })
      await expect
        .poll(() => butlerSessionOnDisk(env)?.sessionIds.length ?? 0, {
          timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS
        })
        .toBe(1)
      expect(agySessionCalls(env)).toHaveLength(1)
      expect(processAlive(agySessionCalls(env)[0].pid)).toBe(true)
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
        .poll(() => said(fake).join('\n'), { timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS })
        .toContain('[Discord] hello')
      const before = butlerSessionOnDisk(env)?.lastSessionKey
      expect(before).toBeTruthy()

      fake.say(OWNER, '/clear')
      await expect
        .poll(() => ran(fake), { timeout: 30_000 })
        .toEqual([
          expect.stringMatching(/\*\*Alfred\*\* ran \/clear:\nIt is a new conversation now/)
        ])
      expect(ranPosts(fake)[0].channelId).toBe(CHANNEL)
      await expect.poll(() => butlerSessionOnDisk(env)?.lastSessionKey).not.toBe(before)
      expect(said(fake).join('\n')).not.toContain('[Discord] /clear')
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('D-CMD-3: the butler’s koloft session command in a Codex session runs /compact as the compaction turn and /clear as a new conversation, and hands the butler what each printed', async ({
    env
  }) => {
    installCodex(env)
    seedConductor(env)
    const fake = await startFakeDiscord(env)
    const { app, page } = await connected(env, fake)
    try {
      const { sessionId: child } = await startCodex(page, env)

      fake.say(OWNER, `/koloft session command ${child} /compact`)
      await expect
        .poll(() => handedToTheButler(env), { timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS })
        .toContainEqual(expect.stringMatching(/⌨️ \*\*[^*]+\*\* ran \/compact:\nDone\./))
      const wire = fs.readFileSync(path.join(env.home, 'fake-codex-wire.jsonl'), 'utf8')
      expect(wire).toContain('"method":"thread/compact/start"')

      fake.say(OWNER, `/koloft session command ${child} /clear`)
      await expect
        .poll(() => handedToTheButler(env), { timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS })
        .toContainEqual(expect.stringMatching(/ran \/clear:\nIt is a new conversation now/))
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  // MUSE§11 MUSE§19
  test('D-CMD-6: in a Muse session, the butler’s koloft session command types the command once its input box is empty and hands the butler its screen, since Muse draws a command’s output only there', async ({
    env
  }) => {
    installMuse(env)
    trustInMuse(env, env.workspaces.a)
    seedConductor(env)
    const fake = await startFakeDiscord(env)
    const { app, page } = await connected(env, fake)
    try {
      await newSessionInWith(page, 'ws-a', 'Muse')
      await expect(wsRows(page, 'ws-a')).toHaveClass(/st-waiting|st-idle/, { timeout: 60_000 })
      const museId = museCalls(env)[0].sessionId

      fake.say(OWNER, `/koloft session command ${museId} /usage`)
      await expect
        .poll(() => handedToTheButler(env), { timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS })
        .toContainEqual(
          expect.stringMatching(
            /ran \/usage:\nIt printed nothing Koloft can read, so here is its screen:[\s\S]*Session usage/
          )
        )
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  // CC§8
  test('D-CMD-5: the butler’s koloft session command is typed into a session at once when its turn is over, though background work it left running still shows ↻ on its row', async ({
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
      await expect(oneStillRunning(wsRows(page, 'ws-a'))).toBeVisible()

      fake.say(OWNER, `/koloft session command ${child} /context`)
      await expect
        .poll(() => handedToTheButler(env), { timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS })
        .toContainEqual(expect.stringMatching(/ran \/context:\n## Context Usage/))
      expect(await terminalText(page, await butlerTab(page))).toContain('Typing /context into')
      expect(await terminalText(page, tab)).not.toContain('bg-reported finished')
      await expect(oneStillRunning(wsRows(page, 'ws-a'))).toBeVisible()
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('D-CMD-5 in Codex: the butler’s koloft session command is typed into a Codex session at once when its turn is over, though a child agent it left running still shows ↻ on its row', async ({
    env
  }) => {
    installCodex(env)
    fs.writeFileSync(
      path.join(env.home, 'fake-codex-child-ms'),
      String(BACKGROUND_OUTLASTS_THE_CASE_MS)
    )
    seedConductor(env)
    const fake = await startFakeDiscord(env)
    const { app, page } = await connected(env, fake)
    try {
      const { sessionId: child } = await startCodex(page, env)
      const tab = (await wsRows(page, 'ws-a').getAttribute('data-tab-id'))!
      await page.evaluate((id) => window.api.terminal.write(id, 'spawn child\r'), tab)
      const row = wsRows(page, 'ws-a')
      await expect(row).toHaveClass(/\bst-bg-run\b/, { timeout: 30_000 })
      await expect(row).toHaveClass(/\bst-waiting\b/)
      await expect(oneStillRunning(row)).toBeVisible()

      fake.say(OWNER, `/koloft session command ${child} /compact`)
      await expect
        .poll(async () => terminalText(page, await butlerTab(page)), {
          timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS
        })
        .toContain('Typing /compact into')
      await expect
        .poll(() => handedToTheButler(env), { timeout: 30_000 })
        .toContainEqual(expect.stringMatching(/ran \/compact:\nDone\./))
      await expect(oneStillRunning(wsRows(page, 'ws-a'))).toBeVisible()
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('D-CMD-4 in Codex: the butler runs koloft session command in a Codex session and is handed what it printed, as a message from Koloft, and koloft session screen shows that session’s terminal', async ({
    env
  }) => {
    installCodex(env)
    seedConductor(env)
    const fake = await startFakeDiscord(env)
    const { app, page } = await connected(env, fake)
    try {
      const { sessionId: child } = await startCodex(page, env)

      fake.say(OWNER, `/koloft session command ${child} /compact`)
      await expect
        .poll(() => handedToTheButler(env), { timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS })
        .toContainEqual(
          expect.stringMatching(/\(From Koloft:\) ⌨️ \*\*[^*]+\*\* ran \/compact:\nDone\./)
        )
      const wire = fs.readFileSync(path.join(env.home, 'fake-codex-wire.jsonl'), 'utf8')
      expect(wire).toContain('"method":"thread/compact/start"')

      fake.say(OWNER, `/koloft session screen ${child}`)
      const conductorTab = await butlerTab(page)
      await expect
        .poll(() => terminalText(page, conductorTab), { timeout: 30_000 })
        .toContain('The screen of')
      expect(await terminalText(page, conductorTab)).toContain(`Codex fixture ready ${child}`)
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('D-CMD-4: the butler runs koloft session command in a session and is handed what it printed, as a message from Koloft, and koloft session screen shows that session’s terminal', async ({
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
        .poll(() => handedToTheButler(env), { timeout: CONDUCTOR_STARTS_AND_ANSWERS_MS })
        .toContainEqual(
          expect.stringMatching(
            /\(From Koloft:\) ⌨️ \*\*[^*]+\*\* ran \/context:\n## Context Usage/
          )
        )

      fake.say(OWNER, `/koloft session screen ${child}`)
      const conductorTab = await butlerTab(page)
      await expect
        .poll(() => terminalText(page, conductorTab), { timeout: 30_000 })
        .toContain('The screen of')
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })
})
