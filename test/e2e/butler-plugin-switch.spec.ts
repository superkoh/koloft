import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { installAgy, installCodex, installMuse, seedSettings, type E2EEnv } from './helpers/env'
import {
  butlerHelperRows,
  butlerRow,
  butlerSessionOnDisk,
  centerTerm,
  landsOnTheButler,
  readAllCalls,
  runIn,
  sendShortcut,
  terminalText,
  waitBooted
} from './helpers/p1'
import { agentPluginSays } from './helpers/koloftSkills'
import { openPluginPage, switchPlugin } from './helpers/extensions'
import { startFakeDiscord } from './helpers/fakeDiscord'
import { GUIDE_MOVED_NEWS } from '../../src/plugins/butler/api'
import { SESSION_BACKENDS } from '../../src/shared/sessionBackend'
import type { BackendId } from '../../src/shared/types'

const INSTALL: Record<BackendId, (env: E2EEnv) => void> = {
  claude: () => {},
  codex: installCodex,
  muse: installMuse,
  agy: installAgy
}

const TOLD_TODO_IS_OFF = 'TheownerchangedSettings▸Pluginsafterthisconversationbegan:Todoisnowoff.'
const TOLD_DISCORD_IS_ON = 'afterthisconversationbegan:Discordisnowon.'
const TOLD_GITHUB_SENTENCE =
  'Yourinstructionsnowalsosay:Yourfolderholdsnorepository,sogivekoloftgh--repo'
const TOLD_DISCORD_SENTENCE = "Koloftaddedtoyourinstructions:Theowner'sDiscordmessagesreachyou"
const OWNER = { id: '555', username: 'owner' }
const BUTLER_WOULD_HAVE_HEARD_WITHIN_MS = 4000
const KNOWN_BY_NEWER_KOLOFT = GUIDE_MOVED_NEWS.knownBy
const HEARD_ENOUGH_OF_IT_CHARS = 120
const TOLD_ITS_OWN_LINES = GUIDE_MOVED_NEWS.text()
  .replace(/\s+/g, '')
  .slice(0, HEARD_ENOUGH_OF_IT_CHARS)

function butlerCalls(env: E2EEnv): ReturnType<typeof readAllCalls> {
  return readAllCalls(env).filter(
    (c) => c.cwd === fs.realpathSync(path.join(env.userData, 'conductors', 'global'))
  )
}

function fileText(env: E2EEnv, name: string): string {
  const file = path.join(env.home, name)
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
}

async function heardBy(page: Page, env: E2EEnv, tab: string): Promise<string> {
  return (
    (await terminalText(page, tab)) +
    fileText(env, 'fake-claude-peer.jsonl') +
    fileText(env, 'fake-codex-wire.jsonl')
  ).replace(/\s+/g, '')
}

test.describe('The butler while a plugin switch changes', () => {
  for (const backend of SESSION_BACKENDS)
    // CC§23 CODEX§17 MUSE§9 AGY§8
    test(`a ${backend} butler that is open is told, in its own tab, that the owner turned Todo off in Settings ▸ Plugins`, async ({
      env
    }) => {
      test.setTimeout(180_000)
      INSTALL[backend](env)
      seedSettings(env, { hintsOff: true, assist: { backend } })
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        await butlerRow(page).click()
        await landsOnTheButler(page)
        const tab = (await butlerRow(page).getAttribute('data-tab-id'))!
        // AGY§8
        if (backend === 'agy') await runIn(page, centerTerm(page), 'hello')
        await expect
          .poll(() => butlerSessionOnDisk(env)?.sessionIds.length ?? 0, { timeout: 60_000 })
          .toBe(1)
        await expect(butlerRow(page)).toHaveClass(/st-waiting/, { timeout: 60_000 })

        await switchPlugin(page, 'Todo', false)
        await expect
          .poll(() => heardBy(page, env, tab), { timeout: 60_000 })
          .toContain(TOLD_TODO_IS_OFF)
      } finally {
        await quitAndClose(app)
      }
    })

  for (const backend of SESSION_BACKENDS)
    // CC§23 CODEX§17 MUSE§9 AGY§8
    test(`a ${backend} butler resumed on a conversation from before koloft help stopped carrying the lines only for it is told them in its own tab`, async ({
      env
    }) => {
      test.setTimeout(240_000)
      INSTALL[backend](env)
      seedSettings(env, { hintsOff: true, assist: { backend } })
      const first = await launchApp(env)
      try {
        const page = await first.firstWindow()
        await waitBooted(page)
        await butlerRow(page).click()
        await landsOnTheButler(page)
        // AGY§8
        if (backend === 'agy') await runIn(page, centerTerm(page), 'hello')
        await expect
          .poll(() => butlerSessionOnDisk(env)?.[KNOWN_BY_NEWER_KOLOFT]?.length ?? 0, {
            timeout: 60_000
          })
          .toBe(1)
        await expect(butlerRow(page)).toHaveClass(/st-waiting/, { timeout: 60_000 })
      } finally {
        await quitAndClose(first)
      }
      seedSettings(env, {
        butlerSession: Object.fromEntries(
          Object.entries(butlerSessionOnDisk(env)!).filter(([key]) => key !== KNOWN_BY_NEWER_KOLOFT)
        )
      })

      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        await butlerRow(page).click()
        await landsOnTheButler(page)
        const tab = (await butlerRow(page).getAttribute('data-tab-id'))!
        await expect
          .poll(() => heardBy(page, env, tab), { timeout: 60_000 })
          .toContain(TOLD_ITS_OWN_LINES)
      } finally {
        await quitAndClose(app)
      }
    })

  for (const backend of SESSION_BACKENDS)
    // CC§23 CODEX§17 MUSE§9 AGY§8
    test(`a ${backend} butler that began while GitHub was off and Discord had no channel is told GitHub’s sentences for its prompt when GitHub is turned on, and Discord’s once a channel is bound`, async ({
      env
    }) => {
      test.setTimeout(240_000)
      INSTALL[backend](env)
      seedSettings(env, {
        hintsOff: true,
        assist: { backend },
        pluginsOn: { github: false, discord: true },
        discord: { userId: OWNER.id, userName: OWNER.username }
      })
      const fake = await startFakeDiscord(env)
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        await butlerRow(page).click()
        await landsOnTheButler(page)
        const tab = (await butlerRow(page).getAttribute('data-tab-id'))!
        // AGY§8
        if (backend === 'agy') await runIn(page, centerTerm(page), 'hello')
        await expect
          .poll(() => butlerSessionOnDisk(env)?.sessionIds.length ?? 0, { timeout: 60_000 })
          .toBe(1)
        await expect(butlerRow(page)).toHaveClass(/st-waiting/, { timeout: 60_000 })
        expect(await heardBy(page, env, tab)).not.toContain(TOLD_GITHUB_SENTENCE)

        await switchPlugin(page, 'GitHub', true)
        await expect
          .poll(() => heardBy(page, env, tab), { timeout: 60_000 })
          .toContain(TOLD_GITHUB_SENTENCE)
        expect(await heardBy(page, env, tab)).not.toContain(TOLD_DISCORD_SENTENCE)

        const pane = await openPluginPage(page, 'Discord')
        await pane.getByRole('button', { name: 'Bind a channel…' }).click()
        const dlg = page.getByRole('dialog', { name: 'Bind a Discord channel' })
        await dlg.locator('.cb-row', { hasText: '#koloft-all' }).click()
        await dlg.locator('.modal-foot .btn-primary').click()
        await expect(dlg).toHaveCount(0)
        await expect
          .poll(() => heardBy(page, env, tab), { timeout: 60_000 })
          .toContain(TOLD_DISCORD_SENTENCE)
      } finally {
        await quitAndClose(app)
        await fake.close()
      }
    })

  test('a Claude butler that is open while the owner clicks Set up with Alfred is told Discord’s sentences for its prompt once its helper binds the channel', async ({
    env
  }) => {
    test.setTimeout(180_000)
    seedSettings(env, {
      hintsOff: true,
      pluginsOn: { discord: false },
      discord: { userId: OWNER.id, userName: OWNER.username }
    })
    const fake = await startFakeDiscord(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await butlerRow(page).click()
      await landsOnTheButler(page)
      const tab = (await butlerRow(page).getAttribute('data-tab-id'))!
      await expect(butlerRow(page)).toHaveClass(/st-waiting/, { timeout: 60_000 })

      const pane = await openPluginPage(page, 'Discord')
      await pane.getByRole('button', { name: 'Set up with Alfred' }).click()
      await expect
        .poll(() => heardBy(page, env, tab), { timeout: 60_000 })
        .toContain(TOLD_DISCORD_IS_ON)
      expect(await heardBy(page, env, tab)).not.toContain(TOLD_DISCORD_SENTENCE)

      const helper = butlerHelperRows(page)
      await expect(helper).toHaveCount(1, { timeout: 60_000 })
      const helperTab = (await helper.getAttribute('data-tab-id'))!
      await expect
        .poll(async () => (await terminalText(page, helperTab)).replace(/\s+/g, ''), {
          timeout: 60_000
        })
        .toContain('runkoloftdiscordsetup')
      await page.evaluate(
        (id) => window.api.terminal.write(id, '/koloft discord bind --new-channel\r'),
        helperTab
      )
      await expect
        .poll(async () => (await terminalText(page, helperTab)).replace(/\s+/g, ''), {
          timeout: 60_000
        })
        .toContain('Boundtoanewchannel.')
      await expect
        .poll(() => heardBy(page, env, tab), { timeout: 60_000 })
        .toContain(TOLD_DISCORD_SENTENCE)
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  // CC§23
  test('a butler that is closed when Todo is switched off is not started for it, and is told once its conversation is resumed', async ({
    env
  }) => {
    test.setTimeout(180_000)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await butlerRow(page).click()
      await landsOnTheButler(page)
      await expect
        .poll(() => butlerSessionOnDisk(env)?.sessionIds.length ?? 0, { timeout: 60_000 })
        .toBe(1)
      await expect(butlerRow(page)).toHaveClass(/st-waiting/, { timeout: 60_000 })
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(butlerRow(page)).not.toHaveClass(/\bactive\b/)

      await switchPlugin(page, 'Todo', false)
      await expect
        .poll(() => agentPluginSays(env.userData, 'gather what waits on the owner'))
        .toBe(false)
      await page.waitForTimeout(BUTLER_WOULD_HAVE_HEARD_WITHIN_MS)
      expect(butlerCalls(env)).toHaveLength(1)
      await expect(butlerRow(page)).not.toHaveClass(/\bactive\b/)

      await butlerRow(page).click()
      await landsOnTheButler(page)
      await expect.poll(() => butlerCalls(env).length, { timeout: 60_000 }).toBe(2)
      expect(butlerCalls(env)[1].argv).toContain('--resume')
      const tab = (await butlerRow(page).getAttribute('data-tab-id'))!
      await expect
        .poll(() => heardBy(page, env, tab), { timeout: 60_000 })
        .toContain(TOLD_TODO_IS_OFF)
    } finally {
      await quitAndClose(app)
    }
  })
})
