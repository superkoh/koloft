import fs from 'fs'
import path from 'path'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { installCodex, type E2EEnv } from './helpers/env'
import { codexCalls } from './helpers/codex'
import {
  menuItemTexts,
  newSessionInWith,
  openMenu,
  sendShortcut,
  snap,
  startSessionIn,
  termIds,
  terminalText,
  waitBooted,
  wsRows
} from './helpers/p1'

test.setTimeout(120_000)

const exitLog = (env: E2EEnv): string => path.join(env.userData, 'agent-exits.log')

const loggedExits = (env: E2EEnv): string[] =>
  fs.existsSync(exitLog(env))
    ? fs
        .readFileSync(exitLog(env), 'utf8')
        .split('\n')
        .filter((l) => / tab \S+ (exited with code|was killed by signal) /.test(l))
    : []

test.describe('an agent that exits on its own keeps its tab: the row says so, the last screen stays, ⌘R starts it again', () => {
  test('a Codex that dies before its session starts keeps its row and last screen, logs that screen, and ⌘R starts it again in the same tab', async ({
    env
  }) => {
    installCodex(env)
    const failOnStart = path.join(env.home, 'fake-codex-exit')
    fs.writeFileSync(failOnStart, '3')
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await newSessionInWith(page, 'ws-a', 'Codex')
      await expect(page.locator('.toast-msg')).toHaveText(
        'Codex closed before the session started (exit code 3)',
        { timeout: 20_000 }
      )

      const row = wsRows(page, 'ws-a')
      await expect(row).toHaveCount(1)
      await expect(row).toHaveClass(/\bcold\b/)
      await expect(row).toHaveClass(/\bactive\b/)
      await expect(row.locator('.ws-tab-sub')).toHaveText('main · exited (code 3)')
      const [tabId] = await termIds(page)
      await expect
        .poll(() => terminalText(page, tabId))
        .toContain('[Koloft] Codex closed before the session started (exit code 3)')
      expect(await terminalText(page, tabId)).toContain('Codex fixture startup failure')
      await expect.poll(() => loggedExits(env)).toHaveLength(1)
      expect(loggedExits(env)[0]).toContain(`codex tab ${tabId} exited with code 3`)
      expect(fs.readFileSync(exitLog(env), 'utf8')).toContain('  | Codex fixture startup failure')
      await snap(page, 'agent-exit-kept-row')

      fs.rmSync(failOnStart)
      await sendShortcut(app, 'shortcut:restart-session')
      await expect.poll(() => codexCalls(env).length, { timeout: 30_000 }).toBe(1)
      await expect(row).toHaveCount(1)
      await expect(row).toHaveClass(/st-waiting/, { timeout: 30_000 })
      await expect(row).toHaveClass(/\bactive\b/)
      await expect(row.locator('.ws-tab-sub')).not.toContainText('exited')
      expect(await termIds(page)).toHaveLength(1)
    } finally {
      await quitAndClose(app)
    }
  })

  test('a Claude that dies before it starts keeps a row whose Close ends it for good; a tab the user closes logs nothing', async ({
    env
  }) => {
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      fs.writeFileSync(env.claudeExitFile, '1')
      await openMenu(page, page.locator('.ws-head', { hasText: 'ws-b' }))
      await page.locator('.menu .mi', { hasText: /^New session/ }).click()
      await expect(page.locator('.toast-msg')).toHaveText(
        'Claude closed before the session started (exit code 1)',
        { timeout: 20_000 }
      )
      const kept = wsRows(page, 'ws-b')
      await expect(kept).toHaveCount(1)
      await expect(kept.locator('.ws-tab-sub')).toHaveText('main · exited (code 1)')
      await expect.poll(() => loggedExits(env)).toHaveLength(1)
      expect(loggedExits(env)[0]).toMatch(/ claude tab \S+ exited with code 1 /)

      await openMenu(page, kept)
      expect(await menuItemTexts(page)).toEqual(['Start again⌘R', 'Close⌘W'])
      await page.locator('.menu .mi', { hasText: /^Close/ }).click()
      await expect(kept).toHaveCount(0, { timeout: 20_000 })
      await expect.poll(() => termIds(page)).toHaveLength(0)

      fs.rmSync(env.claudeExitFile)
      await startSessionIn(page, 'ws-a')
      const closed = wsRows(page, 'ws-a')
      await expect(closed).toHaveClass(/st-waiting/, { timeout: 30_000 })
      await openMenu(page, closed)
      await page.locator('.menu .mi', { hasText: /^Close$/ }).click()
      await expect(closed).toHaveClass(/\bcold\b/, { timeout: 20_000 })
      await expect(closed.locator('.ws-tab-sub')).toHaveText('main')
      expect(loggedExits(env)).toHaveLength(1)
    } finally {
      await quitAndClose(app)
    }
  })
})
