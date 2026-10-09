import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { installCodex, seedSettings, type E2EEnv } from './helpers/env'
import {
  REMOTE_HOST,
  REMOTE_WS_NAME,
  installFakeRemote,
  killFakeRemote,
  remoteDir,
  seedRemoteWorkspace,
  sshCommands
} from './helpers/remote'
import {
  newSessionInWith,
  resumedId,
  seedJsonl,
  sendShortcut,
  setNextSessionTitle,
  startSessionIn,
  waitBooted,
  waitForCalls,
  wsRows
} from './helpers/p1'

test.afterEach(({ env }) => killFakeRemote(env))

const palette = (page: Page) => page.locator('.modal.palette')
const paletteRows = (page: Page) => palette(page).locator('.cb-row')
const hotRow = (page: Page) => palette(page).locator('.cb-row.hot')
const SIDEBAR_BUTTON = '.aux-ico.sb-toggle'

async function openPalette(app: ElectronApplication, page: Page): Promise<void> {
  await sendShortcut(app, 'shortcut:command-palette')
  await expect(palette(page)).toBeVisible()
  await expect(palette(page).getByRole('textbox', { name: 'Jump to' })).toBeFocused()
}

function codexCalls(env: E2EEnv): { argv: string[]; sessionId: string }[] {
  const file = path.join(env.home, 'fake-codex-calls.jsonl')
  if (!fs.existsSync(file)) return []
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as { argv: string[]; sessionId: string }]
      } catch {
        return []
      }
    })
}

test.describe('the command palette (⌘P) jumps to any session, workspace or action', () => {
  test('⌘P, a few letters and ⏎ switch to a live session in another workspace', async ({ env }) => {
    test.setTimeout(120_000)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      setNextSessionTitle(env, 'Alpha palette target')
      await startSessionIn(page, 'ws-a')
      await expect(wsRows(page, 'ws-a')).toContainText('Alpha palette target')
      await startSessionIn(page, 'ws-b')
      await expect(wsRows(page, 'ws-b')).toHaveClass(/\bactive\b/)

      await openPalette(app, page)
      await page.keyboard.type('alpha palette')
      await expect(paletteRows(page)).toHaveCount(1)
      await expect(hotRow(page)).toContainText('Alpha palette target')
      await expect(hotRow(page).locator('.note')).toHaveText('ws-a · main')
      await page.keyboard.press('Enter')

      await expect(palette(page)).toHaveCount(0)
      await expect(wsRows(page, 'ws-a')).toHaveClass(/\bactive\b/)
      await expect(wsRows(page, 'ws-b')).not.toHaveClass(/\bactive\b/)
    } finally {
      await quitAndClose(app)
    }
  })

  test('Esc closes it, a word that matches nothing says so, an action row closes the palette before it opens its own dialog, and ⌘P over another dialog does nothing', async ({
    env
  }) => {
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)

      await openPalette(app, page)
      await page.keyboard.type('zzq')
      await expect(palette(page).locator('.empty')).toContainText('No session, workspace or action')
      await expect(palette(page).locator('.empty')).toContainText('zzq')
      await expect(paletteRows(page)).toHaveCount(0)
      await page.keyboard.press('Escape')
      await expect(palette(page)).toHaveCount(0)

      await openPalette(app, page)
      await page.keyboard.type('settings')
      await expect(hotRow(page)).toHaveText(/^Settings…⌘,$/)
      await page.keyboard.press('Enter')
      await expect(palette(page)).toHaveCount(0)
      await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible()

      await expect(page.locator(SIDEBAR_BUTTON)).toHaveAttribute('aria-pressed', 'true')
      await sendShortcut(app, 'shortcut:command-palette')
      await sendShortcut(app, 'shortcut:toggle-sidebar')
      await expect(page.locator(SIDEBAR_BUTTON)).toHaveAttribute('aria-pressed', 'false')
      await expect(palette(page)).toHaveCount(0)
    } finally {
      await quitAndClose(app)
    }
  })

  test('⏎ on a cold remote row resumes it on its machine, the same as a click on the row', async ({
    env
  }) => {
    test.setTimeout(240_000)
    installFakeRemote(env)
    seedRemoteWorkspace(env)
    const seeded = seedJsonl(env, remoteDir(env), {
      root: path.join(env.userData, 'remote', REMOTE_HOST, 'projects'),
      cwd: remoteDir(env),
      summary: 'Yesterday on the build machine'
    })

    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const row = wsRows(page, REMOTE_WS_NAME).first()
      await expect(row).toHaveClass(/\bcold\b/, { timeout: 30_000 })

      await openPalette(app, page)
      await page.keyboard.type(`${REMOTE_HOST} yesterday`)
      await expect(paletteRows(page)).toHaveCount(1)
      await expect(hotRow(page)).toHaveClass(/\bcold\b/)
      await expect(hotRow(page).locator('.note')).toContainText(
        `${REMOTE_HOST}:${REMOTE_WS_NAME} · `
      )
      await page.keyboard.press('Enter')

      await expect(page.locator('.modal')).toHaveCount(0)
      const calls = await waitForCalls(env, 1, 90_000)
      const last = calls[calls.length - 1]
      expect(resumedId(last)).toBe(seeded)
      expect(last.cwd).toBe(remoteDir(env))
      expect(sshCommands(env).some((c) => /tabs\/[^"]+\.sh"?\s+start/.test(c))).toBe(true)
      await expect(row).not.toHaveClass(/\bcold\b/, { timeout: 60_000 })
    } finally {
      await quitAndClose(app)
    }
  })

  test('a Codex row carries the Codex mark when methods mix, and ⏎ on it resumes it in Codex', async ({
    env
  }) => {
    test.setTimeout(120_000)
    installCodex(env)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      fs.writeFileSync(path.join(env.home, 'fake-codex-next-title'), 'Codex palette target')
      await newSessionInWith(page, 'ws-a', 'Codex')
      await expect.poll(() => codexCalls(env).length).toBe(1)
      const codexRow = wsRows(page, 'ws-a').filter({ hasText: 'Codex palette target' })
      await expect(codexRow).toHaveClass(/st-waiting/, { timeout: 30_000 })
      const started = codexCalls(env)[0].sessionId
      await sendShortcut(app, 'shortcut:close-tab')
      await expect(codexRow).toHaveClass(/\bcold\b/)
      await startSessionIn(page, 'ws-b', { method: 'Claude' })

      await openPalette(app, page)
      await page.keyboard.type('codex palette')
      await expect(paletteRows(page)).toHaveCount(1)
      await expect(hotRow(page).getByRole('img', { name: 'Codex', exact: true })).toBeVisible()
      await expect(hotRow(page)).toHaveClass(/\bcold\b/)
      await page.keyboard.press('Enter')

      await expect(palette(page)).toHaveCount(0)
      await expect.poll(() => codexCalls(env).length).toBe(2)
      const resumed = codexCalls(env)[1]
      expect(resumed.argv).toContain('resume')
      expect(resumed.sessionId).toBe(started)
      await expect(codexRow).not.toHaveClass(/\bcold\b/, { timeout: 30_000 })
    } finally {
      await quitAndClose(app)
    }
  })
})
