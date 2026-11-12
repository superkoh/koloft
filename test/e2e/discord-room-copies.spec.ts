import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { seedSettings, type E2EEnv } from './helpers/env'
import { terminalText, waitBooted, waitConductorStarted } from './helpers/p1'
import {
  OPEN_A_FORM,
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

const PNG_HEIGHT_AT = 20
const PLAN_PAGE_HEIGHT_PX = 2000

const isPng = (data: Buffer): boolean =>
  data.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)

const pngHeight = (data: Buffer): number => data.readUInt32BE(PNG_HEIGHT_AT)

const unwrapped = (s: string): string => s.replace(/\s/g, '')

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

async function roomOfANewSession(
  page: Page,
  fake: FakeDiscord,
  workspace: string
): Promise<{ room: FakeThread; session: SessionInfo }> {
  fake.say(
    OWNER,
    `/koloft session new --model sonnet --effort low --workspace ${workspace} -- warm up`
  )
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
  return async (args: string, reply: string): Promise<FakePost> => {
    const before = fake.posted.filter((p) => p.files.length).length
    fake.say(OWNER, `/koloft ${args}`, { channelId: room.id })
    await expect
      .poll(async () => unwrapped(await terminalText(page, session.tabId)), {
        timeout: STARTS_AND_ANSWERS_MS
      })
      .toContain(unwrapped(reply))
    const uploads = fake.posted.filter((p) => p.files.length)
    expect(uploads).toHaveLength(before + 1)
    expect(uploads[before].channelId).toBe(room.id)
    return uploads[before]
  }
}

function fixtureFiles(dir: string): void {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'plan.html'),
    `<!doctype html><title>plan</title><h1 style="height:${PLAN_PAGE_HEIGHT_PX}px">The plan</h1>`
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
  test('in a local session’s room, koloft open sends an HTML file as a picture, Markdown as text with the file and a line for each diagram, any other file as itself, and koloft diff a picture of the changes, none of it in the butler’s channel; its sudo password card goes to the room too, and the password typed there reaches sudo', async ({
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
      expect(isPng(picture.files[0].data)).toBe(true)

      const doc = await show(`open ${path.join(dir, 'plan.md')}`, `Sent it to ${where} as text`)
      expect(doc.content).toContain('**ship**\n> who: me')
      expect(doc.content).toContain('see it on the Mac')
      expect(doc.files.map((f) => f.name)).toEqual(['plan.md'])

      const file = await show(`open ${path.join(dir, 'notes.bin')}`, `Sent the file to ${where}.`)
      expect(file.files).toEqual([
        expect.objectContaining({ name: 'notes.bin', text: 'some bytes' })
      ])

      const diff = await show(
        `diff ${path.join(dir, 'app.ts')}`,
        `Sent a picture of its changes to ${where}.`
      )
      expect(isPng(diff.files[0].data)).toBe(true)
      expect(fake.posted.some((p) => p.channelId === CHANNEL && p.files.length)).toBe(false)

      fake.say(
        OWNER,
        `/sh "$(dirname "$(command -v koloft)")/koloft-askpass" 'Password:' && echo got-it`,
        { channelId: room.id }
      )
      const sudoCard = (): FakePost | undefined =>
        fake.posted.find((p) => /asks for your sudo password/.test(p.content))
      await expect.poll(sudoCard, { timeout: STARTS_AND_ANSWERS_MS }).toBeTruthy()
      const card = sudoCard()!
      expect(card.channelId).toBe(room.id)
      fake.press(OWNER, card.buttons![0], room.id)
      await expect
        .poll(() => fake.callbacks.find((c) => c.type === OPEN_A_FORM)?.data.custom_id)
        .toBe(card.buttons![0].id)
      fake.submit(OWNER, card.buttons![0].id, 'hunter2-room', room.id)
      await expect
        .poll(() => terminalText(page, session.tabId), { timeout: STARTS_AND_ANSWERS_MS })
        .toContain('hunter2-room\ngot-it')
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('a picture a session shows while the owner is at the Mac, in the turn that asks them, reaches its room once, just before the question card that goes out after the owner left', async ({
    env
  }) => {
    seedButler(env)
    const presence = path.join(env.home, 'presence.txt')
    env.launchEnv.KOLOFT_TEST_PRESENCE_FILE = presence
    const dir = path.join(env.home, 'shown')
    fixtureFiles(dir)
    const fake = await startFakeDiscord(env)
    const { app, page } = await connected(env, fake)
    try {
      const { room, session } = await roomOfANewSession(page, fake, 'ws-a')
      const said = (): Promise<string> => terminalText(page, session.tabId)
      fake.say(OWNER, '/later /ask Ship it?|Yes|No', { channelId: room.id })
      await expect.poll(said, { timeout: STARTS_AND_ANSWERS_MS }).toContain('armed /ask')
      fake.say(OWNER, 'hello there', { channelId: room.id })
      await expect
        .poll(
          () =>
            fake.posted.some((p) => p.channelId === room.id && p.content.includes('hello there')),
          { timeout: STARTS_AND_ANSWERS_MS }
        )
        .toBe(true)

      fs.writeFileSync(presence, 'active')
      fs.writeFileSync(
        path.join(env.home, 'fake-claude-open-before-ask'),
        path.join(dir, 'plan.html')
      )
      fs.writeFileSync(path.join(env.home, 'go-later'), '')
      await expect
        .poll(said, { timeout: STARTS_AND_ANSWERS_MS })
        .toContain('asking: AskUserQuestion')
      expect(unwrapped(await said())).toContain(unwrapped("in this session's Workbench."))
      expect(await said()).not.toContain('Sent')

      fs.writeFileSync(presence, 'idle')
      const inRoom = (): FakePost[] => fake.posted.filter((p) => p.channelId === room.id)
      const cardAt = (): number => inRoom().findIndex((p) => /is waiting for you/.test(p.content))
      await expect.poll(cardAt, { timeout: STARTS_AND_ANSWERS_MS }).toBeGreaterThan(-1)
      const uploads = inRoom().filter((p) => p.files.length)
      expect(uploads).toHaveLength(1)
      expect(isPng(uploads[0].files[0].data)).toBe(true)
      expect(inRoom().indexOf(uploads[0])).toBeLessThan(cardAt())
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('in the room of a session on another machine, its files are pulled from there and sent, and an HTML file there goes as a picture of the whole page, as from a session on this Mac', async ({
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
      expect(doc.content).toContain('**ship**\n> who: me')
      expect(doc.files.map((f) => f.name)).toEqual(['plan.md'])

      const picture = await show(
        `open ${path.join(dir, 'plan.html')}`,
        `Sent a picture of the page to ${where}.`
      )
      expect(isPng(picture.files[0].data)).toBe(true)
      expect(pngHeight(picture.files[0].data)).toBeGreaterThanOrEqual(PLAN_PAGE_HEIGHT_PX)

      const diff = await show(
        `diff ${path.join(dir, 'app.ts')}`,
        `Sent a picture of its changes to ${where}.`
      )
      expect(isPng(diff.files[0].data)).toBe(true)
    } finally {
      await quitAndClose(app)
      await fake.close()
      killFakeRemote(env)
    }
  })
})
