import fs from 'fs'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { seedSettings, type E2EEnv } from './helpers/env'
import { settingsOnDisk, waitBooted } from './helpers/p1'
import { openSettings } from './helpers/extensions'
import {
  FAKE_APPLICATION_ID,
  FAKE_BOT,
  FAKE_GUILD,
  MESSAGE_CONTENT_LIMITED,
  startFakeDiscord,
  type FakeDiscord
} from './helpers/fakeDiscord'
import type { DiscordSettings } from '../../src/shared/types'

test.setTimeout(120_000)

const OWNER = { id: '555', username: 'letian' }
const STRANGER = { id: '556', username: 'someone' }
const TOKEN = 'typed-token'
const LOCK_RETRY_PLUS_ROOM_MS = 45_000
const MANAGE_CHANNELS = 1 << 4
const CATEGORY = 4
const INVITE_PERMISSIONS_WITH_MANAGE_CHANNELS = 326417615936 + MANAGE_CHANNELS

async function discordPane(page: Page): Promise<Locator> {
  await openSettings(page)
  await page.locator('.set-ni', { hasText: 'Discord' }).click()
  return page.locator('.set-main')
}

function externalOpens(env: E2EEnv): string {
  return fs.existsSync(env.externalOpens) ? fs.readFileSync(env.externalOpens, 'utf8') : ''
}

function discordOnDisk(env: E2EEnv): DiscordSettings {
  return settingsOnDisk(env).discord as DiscordSettings
}

async function launched(
  env: E2EEnv,
  opts: { token?: string; closeOnIdentify?: number; setUp?: (fake: FakeDiscord) => void } = {}
): Promise<{
  app: ElectronApplication
  page: Page
  fake: FakeDiscord
  close: () => Promise<void>
}> {
  seedSettings(env, { hintsOff: true })
  const fake = await startFakeDiscord(env, opts.token)
  fake.closeOnIdentify = opts.closeOnIdentify ?? null
  opts.setUp?.(fake)
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await waitBooted(page)
  return {
    app,
    page,
    fake,
    close: async () => {
      await quitAndClose(app)
      await fake.close()
    }
  }
}

test.describe('Discord setup by hand: one Settings screen saves the token, invites the bot, learns who you are, and binds a channel', () => {
  test('a token typed into Settings connects; Invite the bot opens the invite with Manage Channels; a team app pairs on the first message only after This is me; a listed channel binds', async ({
    env
  }) => {
    const { page, fake, close } = await launched(env, { token: '' })
    try {
      const pane = await discordPane(page)
      await expect(pane.getByRole('button', { name: 'Invite the bot' })).toBeDisabled()
      await pane.getByLabel('Bot token').fill(TOKEN)
      await pane.getByRole('button', { name: 'Save', exact: true }).click()
      await expect(pane.locator('.set-row', { hasText: 'Status' })).toContainText(
        `✓ Connected as ${FAKE_BOT}`
      )
      expect(fs.readFileSync(env.keychainFile, 'utf8')).toContain(TOKEN)
      expect(fake.identifies).toBe(1)
      await expect(page.locator('body')).not.toContainText(TOKEN)
      await expect(
        pane.locator('.set-row', { has: page.locator('b', { hasText: /^Server$/ }) })
      ).toContainText(FAKE_GUILD.name)
      await pane.getByRole('button', { name: 'Invite the bot' }).click()
      await expect
        .poll(() => externalOpens(env))
        .toContain(
          `https://discord.com/oauth2/authorize?client_id=${FAKE_APPLICATION_ID}&permissions=${INVITE_PERMISSIONS_WITH_MANAGE_CHANNELS}&scope=bot`
        )

      fake.say({ id: '901', username: 'another-bot', bot: true }, 'beep')
      fake.say(STRANGER, 'not me')
      const candidate = pane.locator('.acct-row', { hasText: 'This is me' })
      await expect(candidate.locator('.acct-name')).toHaveText(STRANGER.username)
      await candidate.getByRole('button', { name: 'Not me' }).click()
      await expect(candidate).toHaveCount(0)
      fake.say(OWNER, 'hi')
      await expect(candidate.locator('.acct-note')).toContainText('“hi”')
      await candidate.getByRole('button', { name: 'This is me' }).click()
      await expect(pane.locator('.set-row', { hasText: 'Your Discord account' })).toContainText(
        `You are ${OWNER.username}`
      )
      expect(discordOnDisk(env)).toMatchObject({ userId: OWNER.id, userName: OWNER.username })

      await pane.getByRole('button', { name: 'Bind a channel…' }).click()
      const dlg = page.getByRole('dialog', { name: 'Bind a Discord channel' })
      await dlg.locator('.cb-row', { hasText: '#koloft-all' }).click()
      await dlg.locator('.modal-foot .btn-primary').click()
      await expect(dlg).toHaveCount(0)
      expect(discordOnDisk(env).bindings).toMatchObject([
        { scope: 'global', channel: { guildId: '111', channelId: '222', name: 'koloft-all' } }
      ])
    } finally {
      await close()
    }
  })

  test('a personal app: Koloft knows its owner without pairing, even over an older pairing, and switches Message Content on through the API', async ({
    env
  }) => {
    seedSettings(env, {
      hintsOff: true,
      discord: { userId: STRANGER.id, userName: STRANGER.username, bindings: [] }
    })
    const fake = await startFakeDiscord(env)
    fake.appOwner = OWNER
    fake.appFlags = 0
    const app = await launchApp(env)
    const page = await app.firstWindow()
    try {
      await waitBooted(page)
      const pane = await discordPane(page)
      await expect(pane.locator('.set-row', { hasText: 'Status' })).toContainText(
        `✓ Connected as ${FAKE_BOT}`
      )
      expect(fake.appFlags & MESSAGE_CONTENT_LIMITED).toBeTruthy()
      const account = pane.locator('.set-row', { hasText: 'Your Discord account' })
      await expect(account).toContainText(`You are ${OWNER.username} · owner of the bot’s app`)
      await expect(account.getByRole('button', { name: 'Change' })).toHaveCount(0)
      expect(discordOnDisk(env)).toMatchObject({ userId: OWNER.id, userName: OWNER.username })
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('when Koloft cannot switch Message Content on, Discord closes with 4014 and Settings tells the owner how to switch it on by hand', async ({
    env
  }) => {
    const { page, close } = await launched(env, {
      setUp: (f) => {
        f.appFlags = 0
        f.refuseAppEdit = true
      }
    })
    try {
      const pane = await discordPane(page)
      const status = pane.locator('.set-row', { hasText: 'Status' })
      await expect(status).toContainText('Message Content is off')
      await expect(status).toContainText('Koloft could not turn on Message Content')
      await status.getByRole('button', { name: 'Open Developer Portal' }).click()
      await expect
        .poll(() => externalOpens(env))
        .toContain('https://discord.com/developers/applications')
    } finally {
      await close()
    }
  })

  test('a second Koloft on the same data folder leaves the bot to the first and says so, quitting the first closes its connection cleanly, and the second then takes the bot over', async ({
    env
  }) => {
    const first = await launched(env)
    let second: ElectronApplication | undefined
    try {
      await expect.poll(() => first.fake.identifies).toBe(1)
      second = await launchApp(env)
      const page = await second.firstWindow()
      await waitBooted(page)
      const pane = await discordPane(page)
      const status = pane.locator('.set-row', { hasText: 'Status' })
      await expect(status).toContainText('Another Koloft is connected')
      expect(first.fake.identifies).toBe(1)

      await quitAndClose(first.app)
      await expect.poll(() => first.fake.closeCodes).toEqual([1000])
      await expect(status).toContainText(`✓ Connected as ${FAKE_BOT}`, {
        timeout: LOCK_RETRY_PLUS_ROOM_MS
      })
      expect(first.fake.identifies).toBe(2)
    } finally {
      if (second) await quitAndClose(second)
      await quitAndClose(first.app)
      await first.fake.close()
    }
  })

  test('Bind keeps New channel picked and makes it: one category named after the bot, #global, a workspace channel named after its folder with -2 on a clash, its path in the topic, through a 429', async ({
    env
  }) => {
    seedSettings(env, {
      hintsOff: true,
      discord: { userId: OWNER.id, userName: OWNER.username, bindings: [] }
    })
    const fake = await startFakeDiscord(env)
    fake.made.push({ id: '600', name: 'ws-a', type: 0 })
    fake.rateLimitChannelPosts = 1
    const app = await launchApp(env)
    const page = await app.firstWindow()
    try {
      await waitBooted(page)
      const pane = await discordPane(page)
      await pane.getByRole('button', { name: 'Bind a channel…' }).click()
      const dlg = page.getByRole('dialog', { name: 'Bind a Discord channel' })
      await expect(dlg.locator('.cb-row.hot', { hasText: 'New channel' })).toHaveText(
        /New channel #global/
      )
      await dlg.locator('.modal-foot .btn-primary').click()
      await expect(dlg).toHaveCount(0)
      expect(fake.rateLimited).toBe(1)
      const category = fake.made.find((c) => c.type === CATEGORY)
      expect(category?.name).toBe(FAKE_BOT)
      const global = fake.made.find((c) => c.name === 'global')
      expect(global).toMatchObject({ type: 0, parent_id: category?.id })
      expect(discordOnDisk(env)).toMatchObject({
        bindings: [{ scope: 'global', channel: { channelId: global?.id, name: 'global' } }],
        category: { channelId: category?.id }
      })

      await pane.getByRole('button', { name: 'Bind a channel…' }).click()
      await dlg.locator('.wt-list').first().locator('.cb-row', { hasText: /^ws-a/ }).click()
      await expect(dlg.locator('.cb-row.hot', { hasText: 'New channel' })).toContainText(
        'New channel #ws-a-2'
      )
      await dlg.locator('.modal-foot .btn-primary').click()
      await expect(dlg).toHaveCount(0)
      const wsA = fake.made.find((c) => c.name === 'ws-a-2')
      expect(wsA).toMatchObject({ parent_id: category?.id, topic: env.workspaces.a })
      expect(fake.made.filter((c) => c.type === CATEGORY)).toHaveLength(1)
      expect(discordOnDisk(env).bindings.map((b) => b.channel.channelId)).toEqual([
        global?.id,
        wsA?.id
      ])
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('a bot invited before it could make channels: a new channel asks for a fresh invite, while picking a channel it already has still binds', async ({
    env
  }) => {
    seedSettings(env, {
      hintsOff: true,
      discord: { userId: OWNER.id, userName: OWNER.username, bindings: [] }
    })
    const fake = await startFakeDiscord(env)
    fake.refuseChannels = true
    const app = await launchApp(env)
    const page = await app.firstWindow()
    try {
      await waitBooted(page)
      const pane = await discordPane(page)
      await pane.getByRole('button', { name: 'Bind a channel…' }).click()
      const dlg = page.getByRole('dialog', { name: 'Bind a Discord channel' })
      await dlg.locator('.modal-foot .btn-primary').click()
      const hint = dlg.locator('.field-hint.bad')
      await expect(hint).toContainText('The bot is not allowed to make channels yet')
      await hint.getByRole('button', { name: 'Invite the bot again' }).click()
      await expect
        .poll(() => externalOpens(env))
        .toContain(`permissions=${INVITE_PERMISSIONS_WITH_MANAGE_CHANNELS}&scope=bot`)

      await dlg.locator('.cb-row', { hasText: '#koloft-all' }).click()
      await dlg.locator('.modal-foot .btn-primary').click()
      await expect(dlg).toHaveCount(0)
      expect(discordOnDisk(env).bindings).toMatchObject([
        { scope: 'global', channel: { channelId: '222', name: 'koloft-all' } }
      ])
      expect(fake.made).toEqual([])
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('once a token and an owner are set, an error shows only on the status line and the bindings stay in view', async ({
    env
  }) => {
    seedSettings(env, {
      hintsOff: true,
      discord: { userId: OWNER.id, userName: OWNER.username, bindings: [] }
    })
    const { page, close } = await launched(env, { closeOnIdentify: 4014 })
    try {
      const pane = await discordPane(page)
      await expect(pane.locator('.set-row', { hasText: 'Status' })).toContainText(
        'Message Content is off'
      )
      await expect(pane.getByRole('button', { name: 'Bind a channel…' })).toBeVisible()
      await expect(pane.locator('.set-row', { hasText: 'Your Discord account' })).toContainText(
        `You are ${OWNER.username}`
      )
    } finally {
      await close()
    }
  })
})
