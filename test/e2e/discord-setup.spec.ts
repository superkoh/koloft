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
  startFakeDiscord,
  type FakeDiscord
} from './helpers/fakeDiscord'
import type { DiscordSettings } from '../../src/shared/types'

test.setTimeout(120_000)

const OWNER = { id: '555', username: 'letian' }
const STRANGER = { id: '556', username: 'someone' }
const TOKEN = 'typed-token'
const LOCK_RETRY_PLUS_ROOM_MS = 45_000

function wizard(page: Page): Locator {
  return page.getByRole('dialog', { name: 'Set up Discord' })
}

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
  opts: { token?: string; closeOnIdentify?: number } = {}
): Promise<{
  app: ElectronApplication
  page: Page
  fake: FakeDiscord
  close: () => Promise<void>
}> {
  seedSettings(env, { hintsOff: true })
  const fake = await startFakeDiscord(env, opts.token)
  fake.closeOnIdentify = opts.closeOnIdentify ?? null
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

async function next(page: Page, step: number): Promise<void> {
  await wizard(page).getByRole('button', { name: 'Next' }).click()
  await expect(wizard(page).locator('.flabel')).toHaveText(`Step ${step} of 7`)
}

test.describe('Discord setup: the 7-step guide checks the bot for real, learns who you are, and binds a channel picked from the server', () => {
  test('a token typed into step 3 connects; the guide opens the portal and the invite in the default browser, ticks Message Content and the server, pairs on the first message only after This is me, and binds a listed channel', async ({
    env
  }) => {
    const { page, fake, close } = await launched(env, { token: '' })
    try {
      const pane = await discordPane(page)
      await expect(
        pane.locator('.set-row', { hasText: 'Discord is not set up yet.' })
      ).toContainText('Step 1 of 7 next: create the app')
      await pane.getByRole('button', { name: 'Set up Discord…' }).click()
      await expect(wizard(page).locator('.flabel')).toHaveText('Step 1 of 7')
      await wizard(page).getByRole('button', { name: 'Open Developer Portal' }).click()
      await expect
        .poll(() => externalOpens(env))
        .toContain('https://discord.com/developers/applications')

      await next(page, 2)
      await next(page, 3)
      await wizard(page).getByLabel('Bot token').fill(TOKEN)
      await wizard(page).getByRole('button', { name: 'Save', exact: true }).click()
      await expect(wizard(page).locator('.acct-login-state.ok')).toHaveText(
        `✓ Connected as ${FAKE_BOT}`
      )
      expect(fs.readFileSync(env.keychainFile, 'utf8')).toContain(TOKEN)
      expect(fake.identifies).toBe(1)
      await expect(page.locator('body')).not.toContainText(TOKEN)

      await wizard(page).getByRole('button', { name: 'Back' }).click()
      await expect(wizard(page).locator('.acct-login-state.ok')).toHaveText(
        '✓ Message Content is on'
      )
      await next(page, 3)
      await next(page, 4)
      await next(page, 5)
      await expect(wizard(page).locator('.acct-login-state.ok')).toHaveText(
        `✓ The bot is in your server ${FAKE_GUILD.name}`
      )
      await wizard(page).getByRole('button', { name: 'Invite the bot' }).click()
      await expect
        .poll(() => externalOpens(env))
        .toContain(
          `https://discord.com/oauth2/authorize?client_id=${FAKE_APPLICATION_ID}&permissions=309237746752&scope=bot`
        )

      await next(page, 6)
      await expect(wizard(page).getByRole('button', { name: 'Next' })).toBeDisabled()
      await expect(wizard(page).locator('.acct-empty')).toHaveText(
        'Waiting for a message in your server…'
      )
      fake.say({ id: '901', username: 'another-bot', bot: true }, 'beep')
      fake.say(STRANGER, 'not me')
      const candidate = wizard(page).locator('.acct-row')
      await expect(candidate.locator('.acct-name')).toHaveText(STRANGER.username)
      await candidate.getByRole('button', { name: 'Not me' }).click()
      await expect(wizard(page).locator('.acct-empty')).toBeVisible()
      fake.say(OWNER, 'hi')
      await expect(candidate.locator('.acct-note')).toContainText('“hi”')
      await candidate.getByRole('button', { name: 'This is me' }).click()
      await expect(wizard(page).locator('.acct-login-state.ok')).toContainText(
        `✓ You are ${OWNER.username}`
      )
      expect(discordOnDisk(env)).toMatchObject({ userId: OWNER.id, userName: OWNER.username })

      await next(page, 7)
      await wizard(page).getByRole('button', { name: 'Bind a channel…' }).click()
      await expect(wizard(page)).toHaveCount(0)
      const dlg = page.getByRole('dialog', { name: 'Bind a Discord channel' })
      await expect(dlg.locator('.wt-name', { hasText: /^#/ })).toHaveText([
        '#koloft-all',
        '#koloft'
      ])
      await dlg.locator('.cb-row', { hasText: '#koloft-all' }).click()
      await dlg.locator('.modal-foot .btn-primary').click()
      await expect(dlg).toHaveCount(0)
      expect(discordOnDisk(env).bindings).toMatchObject([
        { scope: 'global', channel: { guildId: '111', channelId: '222', name: 'koloft-all' } }
      ])

      await expect(pane.locator('.acct-login-state.ok').first()).toHaveText('✓ All 7 steps done')
      await expect(pane.locator('.set-row', { hasText: 'Your Discord account' })).toContainText(
        `You are ${OWNER.username}`
      )
      await expect(pane.locator('.set-row', { hasText: 'Status' })).toContainText(
        `✓ Connected as ${FAKE_BOT}`
      )
    } finally {
      await close()
    }
  })

  test('a bot whose Message Content is off is closed with 4014, and the guide points at step 2', async ({
    env
  }) => {
    const { page, close } = await launched(env, { closeOnIdentify: 4014 })
    try {
      const pane = await discordPane(page)
      await expect(pane.locator('.set-row', { hasText: 'Status' })).toContainText(
        'Message Content is off'
      )
      await expect(
        pane.locator('.set-row', { hasText: 'Discord is not set up yet.' })
      ).toContainText('Step 2 of 7 next: let the bot read messages')
      await pane.getByRole('button', { name: 'Set up Discord…' }).click()
      await expect(wizard(page).locator('.flabel')).toHaveText('Step 2 of 7')
      await expect(wizard(page).locator('.acct-login-state.bad')).toContainText(
        'Message Content is off'
      )
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
      await expect(pane.getByText('Discord is not set up yet.')).toHaveCount(0)
    } finally {
      await close()
    }
  })
})
