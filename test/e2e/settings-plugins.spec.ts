import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { seedNoClaudeAccountButStillSetUp, seedSettings, type E2EEnv } from './helpers/env'
import { openPluginPage, openSettings, settingsNavItems } from './helpers/extensions'
import {
  butlerHelperRows,
  butlerRow,
  openMenu,
  sendShortcut,
  settingsOnDisk,
  waitBooted
} from './helpers/p1'

const DISCORD_SET_UP = {
  userId: '555555555555555555',
  userName: 'owner',
  channel: { guildId: '111111111111111111', channelId: '222222222222222222', name: 'koloft' }
}

async function launched(
  env: E2EEnv,
  seed: Record<string, unknown> = {}
): Promise<{ app: ElectronApplication; page: Page }> {
  seedSettings(env, { hintsOff: true, ...seed })
  const app = await launchApp(env)
  const page = await app.firstWindow()
  await waitBooted(page)
  return { app, page }
}

async function openPluginsPane(page: Page): Promise<Locator> {
  await openSettings(page)
  await page.locator('.set-ni', { hasText: 'Plugins' }).click()
  const main = page.locator('.set-main')
  await expect(main.locator('.set-ph h3')).toHaveText('Plugins')
  return main
}

const row = (main: Locator, name: string): Locator =>
  main.locator('.set-row', {
    has: main.page().locator('.set-lab b', { hasText: new RegExp(`^${name}$`) })
  })

const pluginsOn = (env: E2EEnv): unknown => settingsOnDisk(env).pluginsOn

test.describe('Settings ▸ Plugins: one row per plugin, a switch for each optional one, and a page for each', () => {
  test('after an upgrade by someone who never set up Discord: Plugins replaces Discord in the list of pages, the master gate is on top, the six mandatory plugins say Always on, every optional plugin is on but Discord, which offers Set up with Alfred, and Extensions keeps no switch of Koloft’s', async ({
    env
  }) => {
    const { app, page } = await launched(env)
    try {
      const main = await openPluginsPane(page)
      const nav = await settingsNavItems(page)
      expect(nav).not.toContain('Discord')
      expect(nav.indexOf('Plugins')).toBe(nav.indexOf('Assist') + 1)

      await expect(main.locator('.set-row').first()).toContainText('Let agents use Koloft')
      await expect(main.locator('.set-grp')).toHaveText(['Always on', 'Optional'])
      for (const name of [
        'Sessions core',
        'Workbench',
        'Browser control',
        'Butler',
        'Inbox',
        'Scheduled tasks'
      ]) {
        await expect(row(main, name).locator('.acct-note')).toHaveText('Always on')
        await expect(row(main, name).getByRole('switch')).toHaveCount(0)
      }
      await expect(row(main, 'Browser control')).toContainText('Needs Workbench.')
      await expect(row(main, 'Todo')).toContainText('Needs Sessions core, Butler and GitHub.')
      await expect(row(main, 'Discord')).toContainText('Talk to Alfred from your phone')

      for (const name of ['GitHub', 'Todo', 'Passwords and sign-in', 'Docs writing']) {
        await expect(main.getByRole('switch', { name, exact: true })).toBeChecked()
        await expect(row(main, name).getByRole('button', { name: /Set up/ })).toHaveCount(0)
      }
      await expect(main.getByRole('switch', { name: 'Discord', exact: true })).not.toBeChecked()
      await expect(
        row(main, 'Discord').getByRole('button', { name: 'Set up with Alfred' })
      ).toBeVisible()
      expect(pluginsOn(env) ?? {}).toEqual({})

      await page.locator('.set-ni', { hasText: 'Extensions' }).click()
      await expect(main.locator('.set-ph h3')).toHaveText('Extensions')
      await expect(main.getByRole('switch')).toHaveCount(0)
      await expect(main).not.toContainText('Let agents')
    } finally {
      await quitAndClose(app)
    }
  })

  test('turning GitHub off turns Todo off with it: Todo’s switch is disabled with the reason, its row says GitHub is off, only GitHub’s choice is saved, it survives a restart, and turning GitHub on gives Todo back its own choice', async ({
    env
  }) => {
    let { app, page } = await launched(env)
    try {
      let main = await openPluginsPane(page)
      await main.getByRole('switch', { name: 'GitHub', exact: true }).uncheck()
      const todo = main.getByRole('switch', { name: 'Todo', exact: true })
      await expect(todo).not.toBeChecked()
      await expect(todo).toBeDisabled()
      await expect(todo).toHaveAttribute('title', 'Turn on GitHub before turning Todo on')
      await expect(row(main, 'Todo')).toContainText(
        'Needs Sessions core, Butler and GitHub. GitHub is off.'
      )
      await expect.poll(() => pluginsOn(env)).toEqual({ github: false })

      await quitAndClose(app)
      ;({ app, page } = await launched(env))
      main = await openPluginsPane(page)
      await expect(main.getByRole('switch', { name: 'GitHub', exact: true })).not.toBeChecked()
      await expect(main.getByRole('switch', { name: 'Todo', exact: true })).toBeDisabled()

      await main.getByRole('switch', { name: 'GitHub', exact: true }).check()
      await expect(main.getByRole('switch', { name: 'Todo', exact: true })).toBeChecked()
      await expect(main.getByRole('switch', { name: 'Todo', exact: true })).toBeEnabled()
      await expect(row(main, 'Todo')).not.toContainText('is off.')
      await expect.poll(() => pluginsOn(env)).toEqual({ github: true })
    } finally {
      await quitAndClose(app)
    }
  })

  test('with Let agents use Koloft off nothing below is dimmed or blocked: a plugin can still be switched and opened', async ({
    env
  }) => {
    const { app, page } = await launched(env, { agentTools: false })
    try {
      const main = await openPluginsPane(page)
      const gate = main
        .locator('.set-row', { hasText: 'Let agents use Koloft' })
        .getByRole('switch')
      await expect(gate).not.toBeChecked()
      await expect(main.locator('.set-row.off')).toHaveCount(0)
      await main.getByRole('switch', { name: 'Docs writing', exact: true }).uncheck()
      await expect.poll(() => pluginsOn(env)).toEqual({ 'docs-writing': false })
      await gate.check()
      await expect.poll(() => settingsOnDisk(env).agentTools).toBe(true)
      await main.getByRole('button', { name: 'Open Docs writing', exact: true }).click()
      await expect(main.locator('.set-ph h3')).toHaveText('Docs writing')
    } finally {
      await quitAndClose(app)
    }
  })

  test('every row opens its plugin’s own page with ‹ Plugins back and the same switch on top: Discord never set up shows only its switch and Set up with Alfred; a mandatory one says Always on, with its small jobs and its own settings', async ({
    env
  }) => {
    const { app, page } = await launched(env)
    try {
      let main = await openPluginPage(page, 'Discord')
      await expect(page.locator('.set-ni.on')).toHaveText('Plugins')
      const discordSwitch = main.getByRole('switch', { name: 'Turn on Discord' })
      await expect(discordSwitch).not.toBeChecked()
      await expect(
        main.locator('.set-row', { has: page.getByRole('switch', { name: 'Turn on Discord' }) })
      ).toContainText('Needs Butler.')
      await expect(main.getByRole('button', { name: 'Set up with Alfred' })).toBeVisible()
      await expect(main.locator('.set-grp')).toHaveCount(0)
      await discordSwitch.check()
      await expect.poll(() => pluginsOn(env)).toEqual({ discord: true })
      await main.getByRole('button', { name: 'Plugins', exact: true }).click()
      await expect(main.getByRole('switch', { name: 'Discord', exact: true })).toBeChecked()
      await expect(
        row(main, 'Discord').getByRole('button', { name: 'Set up with Alfred' })
      ).toBeVisible()

      const page_ = async (name: string): Promise<Locator> => {
        await main.getByRole('button', { name: `Open ${name}`, exact: true }).click()
        await expect(main.locator('.set-ph h3')).toHaveText(name)
        return main
      }
      const back = (): Promise<void> =>
        main.getByRole('button', { name: 'Plugins', exact: true }).click()
      const jobs = (): Promise<string[]> =>
        main.locator('.set-row:not(.child) .set-lab b').allTextContents()

      main = await page_('Sessions core')
      await expect(main.locator('.set-row').first()).toContainText(
        'Other parts of Koloft are built on it, so it has no switch.'
      )
      await expect(main.getByRole('switch')).toHaveCount(0)
      await expect(main.locator('.set-grp')).toHaveText(['Small jobs'])
      expect(await jobs()).toEqual([
        'Always on',
        'Name a new session',
        'Translate a handover',
        'After each turn'
      ])
      await back()

      main = await page_('Workbench')
      expect(await jobs()).toEqual(['Always on', 'Pick the documents to show'])
      await back()

      main = await page_('Inbox')
      expect(await jobs()).toEqual(['Always on'])
      await expect(main).toContainText('Needs Sessions core.')
      await back()

      main = await page_('Butler')
      await expect(main.locator('.set-grp')).toHaveText(['Small jobs', 'Butler'])
      expect(await jobs()).toEqual(['Always on', 'Route what you type in ⌘P', 'Alfred', 'Name'])
      await expect(main.getByLabel('Butler name')).toHaveValue('Alfred')
      await back()

      main = await page_('Browser control')
      const drive = main
        .locator('.set-row', { hasText: 'Let agents drive this Browser' })
        .getByRole('switch')
      await expect(drive).toBeChecked()
      await drive.uncheck()
      await expect.poll(() => settingsOnDisk(env).browserControl).toBe(false)
      await back()

      main = await page_('Docs writing')
      await expect(main.getByRole('switch', { name: 'Turn on Docs writing' })).toBeChecked()
      expect(await jobs()).toEqual(['Turn on Docs writing'])
    } finally {
      await quitAndClose(app)
    }
  })

  test('Discord already set up starts on with no Set up button; its page shows the bot and the channel, and once turned off its status reads Off while the bot and channel stay, with no way to change the channel until it is on again', async ({
    env
  }) => {
    const { app, page } = await launched(env, { discord: DISCORD_SET_UP })
    try {
      const main = await openPluginsPane(page)
      await expect(main.getByRole('switch', { name: 'Discord', exact: true })).toBeChecked()
      await expect(row(main, 'Discord').getByRole('button', { name: /Set up/ })).toHaveCount(0)

      await main.getByRole('button', { name: 'Open Discord', exact: true }).click()
      await expect(main.locator('.set-ph h3')).toHaveText('Discord')
      const status = main.locator('.set-row', { hasText: 'Status' }).locator('.acct-login-state')
      await expect(status).toHaveText('Not connected')
      await expect(main).toContainText('You are owner')
      await expect(main.getByRole('button', { name: 'Change channel…' })).toBeVisible()

      await main.getByRole('switch', { name: 'Turn on Discord' }).uncheck()
      await expect(status).toHaveText('Off')
      await expect(main).toContainText('You are owner')
      await expect(main).toContainText('#koloft')
      await expect(main.getByRole('button', { name: 'Change channel…' })).toHaveCount(0)
      await expect(main.getByRole('button', { name: 'Unbind' })).toHaveCount(0)
      await expect.poll(() => pluginsOn(env)).toEqual({ discord: false })
      await main.getByRole('switch', { name: 'Turn on Discord' }).check()
      await expect(main.getByRole('button', { name: 'Change channel…' })).toBeVisible()
    } finally {
      await quitAndClose(app)
    }
  })

  test('while Discord is on, Settings ▸ Assist, the butler’s row there and its rename dialog say the owner reaches the butler from Discord too; once Discord is turned off none of them names it', async ({
    env
  }) => {
    const { app, page } = await launched(env, { discord: DISCORD_SET_UP })
    try {
      const assistLines = async (): Promise<Locator> => {
        await page.locator('.set-ni', { hasText: 'Assist' }).click()
        const main = page.locator('.set-main')
        await expect(main.locator('.set-ph h3')).toHaveText('Assist')
        return main
      }
      const renameHint = async (): Promise<Locator> => {
        await openMenu(page, butlerRow(page))
        await page.locator('.menu .mi', { hasText: 'Rename…' }).click()
        return page.locator('.modal', { hasText: 'Rename your butler' }).locator('.field-hint')
      }

      await openSettings(page)
      let main = await assistLines()
      await expect(main.locator('.set-ph p')).toContainText(
        'whom you talk to from the top of the sidebar or from Discord.'
      )
      await expect(main).toContainText(
        'Your butler, whom you talk to from the top of the sidebar or from Discord.'
      )
      await page.keyboard.press('Escape')
      await expect(await renameHint()).toContainText(
        'Shown as “Alfred · Butler” in the sidebar and in Discord.'
      )
      await page.keyboard.press('Escape')

      main = await openPluginsPane(page)
      await main.getByRole('switch', { name: 'Discord', exact: true }).uncheck()
      await expect.poll(() => pluginsOn(env)).toEqual({ discord: false })
      main = await assistLines()
      await expect(main.locator('.set-ph p')).toContainText(
        'whom you talk to from the top of the sidebar.'
      )
      await expect(main).toContainText('Your butler, whom you talk to from the top of the sidebar.')
      await expect(main).not.toContainText('Discord')
      await page.keyboard.press('Escape')
      await expect(await renameHint()).toHaveText(
        'Shown as “Alfred · Butler” in the sidebar. Other sessions reach it by this name.'
      )
    } finally {
      await quitAndClose(app)
    }
  })

  test('Set up with Alfred on Discord’s row starts the butler’s helper and turns Discord on', async ({
    env
  }) => {
    const { app, page } = await launched(env)
    try {
      const main = await openPluginsPane(page)
      await row(main, 'Discord').getByRole('button', { name: 'Set up with Alfred' }).click()
      await expect(butlerHelperRows(page)).toHaveCount(1, { timeout: 60_000 })
      await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0)
      await expect.poll(() => pluginsOn(env)).toEqual({ discord: true })
    } finally {
      await quitAndClose(app)
    }
  })

  test('when the butler cannot start, Set up with Alfred on Discord’s row says why under the row and leaves Discord off', async ({
    env
  }) => {
    seedNoClaudeAccountButStillSetUp(env)
    const { app, page } = await launched(env)
    try {
      const main = await openPluginsPane(page)
      await row(main, 'Discord').getByRole('button', { name: 'Set up with Alfred' }).click()
      await expect(main.locator('.acct-login-state.bad')).toBeVisible()
      await expect(main.getByRole('switch', { name: 'Discord', exact: true })).not.toBeChecked()
      expect(pluginsOn(env) ?? {}).toEqual({})
    } finally {
      await quitAndClose(app)
    }
  })

  test('⌘P finds Discord as Settings ▸ Plugins ▸ Discord and opens its page inside Plugins', async ({
    env
  }) => {
    const { app, page } = await launched(env)
    try {
      await sendShortcut(app, 'shortcut:command-palette')
      const palette = page.locator('.modal.palette')
      await expect(palette.getByRole('textbox', { name: 'Ask or jump' })).toBeFocused()
      await page.keyboard.type('discord')
      await page.keyboard.press('ArrowDown')
      await expect(palette.locator('.cb-row.hot')).toHaveText('Settings ▸ Plugins ▸ Discord')
      await page.keyboard.press('Enter')
      const settings = page.getByRole('dialog', { name: 'Settings' })
      await expect(settings.getByRole('tab', { selected: true })).toHaveText('Plugins')
      await expect(settings.locator('.set-ph h3')).toHaveText('Discord')
      await expect(settings.getByRole('switch', { name: 'Turn on Discord' })).toBeVisible()
    } finally {
      await quitAndClose(app)
    }
  })
})
