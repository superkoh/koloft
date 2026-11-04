import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { seedSettings, type E2EEnv } from './helpers/env'
import { terminalText, waitBooted, waitConductorStarted } from './helpers/p1'
import {
  startFakeDiscord,
  type FakeDiscord,
  type FakePost,
  type FakeThread
} from './helpers/fakeDiscord'
import {
  addRemoteWorkspace,
  installFakeRemote,
  killFakeRemote,
  remoteDir,
  REMOTE_WS_NAME
} from './helpers/remote'
import { runGit } from './helpers/gitFixture'
import type { SessionInfo } from '../../src/shared/types'

test.setTimeout(240_000)

const OWNER = { id: '555', username: 'letian' }
const CHANNEL = '222'
const STARTS_AND_ANSWERS_MS = 90_000
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const isPng = (data: Buffer): boolean =>
  data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)

const unwrapped = (s: string): string => s.replace(/\s/g, '')

function seedButler(env: E2EEnv): void {
  seedSettings(env, {
    hintsOff: true,
    assist: { on: true, backend: 'claude' },
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

async function roomOfANewSession(
  page: Page,
  fake: FakeDiscord,
  workspace: string
): Promise<{ room: FakeThread; session: SessionInfo }> {
  fake.say(OWNER, `/koloft session new --workspace ${workspace} -- warm up`)
  await expect
    .poll(() => fake.threads.filter((t) => t.parent_id === CHANNEL).length, {
      timeout: STARTS_AND_ANSWERS_MS
    })
    .toBe(1)
  const room = fake.threads.find((t) => t.parent_id === CHANNEL)!
  let session: SessionInfo | undefined
  await expect
    .poll(
      async () => {
        const all = await page.evaluate(() => window.api.sessions.list())
        session = all.find((s) => s.alive && !s.butler && s.sessionId)
        return !!session
      },
      { timeout: STARTS_AND_ANSWERS_MS }
    )
    .toBe(true)
  await expect
    .poll(() =>
      fake.posted.some((p) => p.channelId === room.id && p.content.includes('where it is'))
    )
    .toBe(true)
  return { room, session: session! }
}

function shows(page: Page, fake: FakeDiscord, room: FakeThread, session: SessionInfo) {
  return async (args: string, reply: string, sends = true): Promise<FakePost | undefined> => {
    const before = fake.posted.filter((p) => p.files.length).length
    fake.say(OWNER, `/koloft ${args}`, { channelId: room.id })
    await expect
      .poll(async () => unwrapped(await terminalText(page, session.tabId)), {
        timeout: STARTS_AND_ANSWERS_MS
      })
      .toContain(unwrapped(reply))
    const uploads = fake.posted.filter((p) => p.files.length)
    expect(uploads).toHaveLength(sends ? before + 1 : before)
    if (!sends) return undefined
    expect(uploads[before].channelId).toBe(room.id)
    return uploads[before]
  }
}

function fixtureFiles(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'plan.html'),
    '<!doctype html><title>plan</title><h1>The plan</h1>'
  )
  fs.writeFileSync(
    path.join(dir, 'plan.md'),
    '# Plan\n\n| step | who |\n|---|---|\n| ship | me |\n\n```mermaid\ngraph TD; A-->B\n```\n'
  )
  fs.writeFileSync(path.join(dir, 'notes.bin'), 'some bytes')
  fs.writeFileSync(path.join(dir, 'app.ts'), 'const a = 1\n')
  if (!fs.existsSync(path.join(dir, '.git'))) runGit(dir, 'init', '-q')
  runGit(dir, 'add', 'app.ts')
  runGit(dir, 'commit', '-q', '-m', 'app')
  fs.writeFileSync(path.join(dir, 'app.ts'), 'const a = 2\n')
}

test.describe('Discord rooms: what a session shows the owner at the Mac also reaches its room on the phone', () => {
  test('in a local session’s room, koloft open sends an HTML file as a picture, Markdown as text with the file and a line for each diagram, any other file as itself, koloft diff a picture of the changes, and a secret card comes to the room, not the butler’s channel', async ({
    env
  }) => {
    seedButler(env)
    const dir = path.join(env.home, 'shown')
    fixtureFiles(dir)
    const fake = await startFakeDiscord(env)
    const { app, page } = await connected(env, fake)
    try {
      const { room, session } = await roomOfANewSession(page, fake, 'ws-a')
      const show = shows(page, fake, room, session)
      const where = "this session's room on the owner's Discord"

      const picture = await show(
        `open ${path.join(dir, 'plan.html')}`,
        `Sent a picture of the page to ${where}.`
      )
      expect(isPng(picture!.files[0].data)).toBe(true)

      const doc = await show(`open ${path.join(dir, 'plan.md')}`, `Sent it to ${where} as text`)
      expect(doc!.content).toContain('**ship**\n> who: me')
      expect(doc!.content).toContain('see it on the Mac')
      expect(doc!.files.map((f) => f.name)).toEqual(['plan.md'])

      const file = await show(`open ${path.join(dir, 'notes.bin')}`, `Sent the file to ${where}.`)
      expect(file!.files).toEqual([
        expect.objectContaining({ name: 'notes.bin', text: 'some bytes' })
      ])

      const diff = await show(
        `diff ${path.join(dir, 'app.ts')}`,
        `Sent a picture of its changes to ${where}.`
      )
      expect(isPng(diff!.files[0].data)).toBe(true)

      fake.say(OWNER, '/koloft secret url "https://auth.example.test/authorize?client=r"', {
        channelId: room.id
      })
      await expect
        .poll(
          () =>
            fake.posted.some(
              (p) => p.channelId === room.id && p.content.includes('auth.example.test')
            ),
          {
            timeout: STARTS_AND_ANSWERS_MS
          }
        )
        .toBe(true)
      expect(
        fake.posted.some((p) => p.channelId === CHANNEL && p.content.includes('auth.example.test'))
      ).toBe(false)
      expect(fake.posted.some((p) => p.channelId === CHANNEL && p.files.length)).toBe(false)
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('in the room of a session on another machine, its files are pulled from there and sent, its page is not pictured and the session is told to say it in words', async ({
    env
  }) => {
    test.setTimeout(300_000)
    seedButler(env)
    installFakeRemote(env)
    const dir = remoteDir(env)
    fixtureFiles(dir)
    const fake = await startFakeDiscord(env)
    const { app, page } = await connected(env, fake)
    try {
      await addRemoteWorkspace(page, env)
      const { room, session } = await roomOfANewSession(page, fake, REMOTE_WS_NAME)
      const show = shows(page, fake, room, session)
      const where = "this session's room on the owner's Discord"

      const doc = await show(`open ${path.join(dir, 'plan.md')}`, `Sent it to ${where} as text`)
      expect(doc!.content).toContain('**ship**\n> who: me')
      expect(doc!.files.map((f) => f.name)).toEqual(['plan.md'])

      await show(
        `open ${path.join(dir, 'plan.html')}`,
        'Koloft takes no picture of a page on another machine',
        false
      )

      const diff = await show(
        `diff ${path.join(dir, 'app.ts')}`,
        `Sent a picture of its changes to ${where}.`
      )
      expect(isPng(diff!.files[0].data)).toBe(true)
    } finally {
      await quitAndClose(app)
      await fake.close()
      killFakeRemote(env)
    }
  })
})
