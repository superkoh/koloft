import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect } from './helpers/app'
import type { E2EEnv } from './helpers/env'
import { centerTerm, clickAppMenuItem, focusOwner, gitInit, startSessionIn } from './helpers/p1'
import {
  BROWSER,
  BROWSER_MENU_IDS,
  downloadedFiles,
  globeIcon,
  guestByUrl,
  newWebTab,
  openBrowser,
  openViaAgent,
  typeInAddressBar,
  windowStates
} from './helpers/browser'
import { wbUnreadTabs } from './helpers/workbench'
import { startEchoServer } from './helpers/fixtureServer'

const DEVTOOLS_MAY_NEVER_APPEAR_MS = 3000
const AUDIO_SAMPLE_COUNT = 7
const AUDIO_SAMPLE_GAP_MS = 300

// PLATFORM§18
function windowFocusStates(
  app: ElectronApplication
): Promise<{ visible: boolean; focused: boolean }[]> {
  return app.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => ({ visible: w.isVisible(), focused: w.isFocused() }))
  )
}

async function browserSession(page: Page, env: E2EEnv): Promise<void> {
  gitInit(env.workspaces.a)
  await startSessionIn(page, 'ws-a')
  await expect(globeIcon(page)).toBeVisible({ timeout: 30_000 })
  await openBrowser(page)
  await newWebTab(page)
  await expect(page.locator(BROWSER.addressField).first()).toBeVisible({ timeout: 20_000 })
}

test.describe("Session Browser stays unnoticeable on the developer's own machine: no window shown, no focus taken, no sound, nothing in the real Downloads or clipboard", () => {
  test('BB-N01: an agent-opened page never steals window focus', async ({ app, page, env }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      gitInit(env.workspaces.a)
      await startSessionIn(page, 'ws-a')
      await centerTerm(page).click()
      expect(await focusOwner(page)).toBe('tui')

      await openViaAgent(page, server.url('/a'))

      await expect(wbUnreadTabs(page)).toHaveCount(1, { timeout: 30_000 })

      for (const w of await windowFocusStates(app)) {
        expect(w.visible).toBe(false)
        expect(w.focused).toBe(false)
      }
      expect(await focusOwner(page)).toBe('tui')
    } finally {
      await server.close()
    }
  })

  test('BB-N02: no Browser guest or devtools window is ever visible on screen in background test mode', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await browserSession(page, env)

      const url = server.url('/a')
      await typeInAddressBar(page, url)
      await guestByUrl(app, url)

      await clickAppMenuItem(app, page, BROWSER_MENU_IDS.devtools)
      await page.waitForTimeout(DEVTOOLS_MAY_NEVER_APPEAR_MS)

      const windows = await windowStates(app)
      expect(windows.length).toBeGreaterThan(0)
      for (const w of windows) expect(w.visible).toBe(false)
    } finally {
      await server.close()
    }
  })

  test('BB-N03: guests make no sound: autoplay without a user gesture is refused and every guest stays muted', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await browserSession(page, env)

      const url = server.url('/audio')
      await typeInAddressBar(page, url)
      const guest = await guestByUrl(app, url)
      await expect(guest.locator('#played')).toHaveText('blocked', { timeout: 20_000 })

      const unmuted: boolean[] = []
      const found: boolean[] = []
      // PLATFORM§13
      for (let i = 0; i < AUDIO_SAMPLE_COUNT; i++) {
        const muted = await app.evaluate(({ webContents }) =>
          webContents
            .getAllWebContents()
            .filter((w) => w.getType() === 'webview')
            .map((w) => w.isAudioMuted())
        )
        found.push(muted.length > 0)
        unmuted.push(muted.some((m) => !m))
        await page.waitForTimeout(AUDIO_SAMPLE_GAP_MS)
      }
      expect(found).not.toContain(false)
      expect(unmuted).not.toContain(true)
    } finally {
      await server.close()
    }
  })

  test('BB-N04: downloads never write into the real user Downloads directory', async ({
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await browserSession(page, env)

      const name = `koloft-e2e-n04-${Date.now()}.txt`
      const realDownloads = path.join(os.homedir(), 'Downloads', name)

      await typeInAddressBar(page, server.url(`/download?name=${name}`))

      await expect.poll(() => downloadedFiles(env), { timeout: 30_000 }).toContain(name)
      expect(fs.existsSync(realDownloads)).toBe(false)
    } finally {
      await server.close()
    }
  })

  test('BB-N05: no browser flow reads or overwrites the real clipboard', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      gitInit(env.workspaces.a)
      await startSessionIn(page, 'ws-a')

      await app.evaluate(({ clipboard }) => {
        const g = globalThis as unknown as { __koloftClipboardCalls?: string[] }
        g.__koloftClipboardCalls = []
        clipboard.readText = ((): string => {
          g.__koloftClipboardCalls?.push('readText')
          return 'koloft-e2e-known-clipboard'
        }) as typeof clipboard.readText
        clipboard.writeText = ((text: string): void => {
          g.__koloftClipboardCalls?.push(`writeText:${text}`)
        }) as typeof clipboard.writeText
      })

      await expect(globeIcon(page)).toBeVisible({ timeout: 30_000 })
      await openBrowser(page)
      await newWebTab(page)
      await expect(page.locator(BROWSER.addressField).first()).toBeVisible({ timeout: 20_000 })
      const first = server.url('/a')
      await typeInAddressBar(page, first)
      const guest = await guestByUrl(app, first)
      await guest.locator('#to-b').click()
      await guestByUrl(app, server.url('/b'))

      const calls = await app.evaluate(
        () =>
          (globalThis as unknown as { __koloftClipboardCalls?: string[] }).__koloftClipboardCalls ??
          []
      )
      expect(calls).toEqual([])
    } finally {
      await server.close()
    }
  })

  test('BB-N06: a detached devtools window does not take screen or focus in background mode', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(180_000)
    const server = await startEchoServer()
    try {
      await browserSession(page, env)

      const url = server.url('/a')
      await typeInAddressBar(page, url)
      await guestByUrl(app, url)

      await clickAppMenuItem(app, page, BROWSER_MENU_IDS.devtools)
      await page.waitForTimeout(DEVTOOLS_MAY_NEVER_APPEAR_MS)

      for (const w of await windowFocusStates(app)) {
        expect(w.visible).toBe(false)
        expect(w.focused).toBe(false)
      }
    } finally {
      await server.close()
    }
  })
})
