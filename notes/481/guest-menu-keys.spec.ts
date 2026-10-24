import fs from 'fs'
import type { ElectronApplication, Page } from '@playwright/test'
import { test as e2eTest, expect, launchApp, quitAndClose } from '../e2e/helpers/app'
import { seedSettings } from '../e2e/helpers/env'
import { startSessionIn, waitBooted, centerTerm, focusOwner } from '../e2e/helpers/p1'
import { guestByUrl, openViaAgent } from '../e2e/helpers/browser'
import { startEchoServer } from '../e2e/helpers/fixtureServer'
import {
  COMMAND_FLAG,
  accessibilityTrusted,
  realClick,
  realKey,
  screenPointOf,
  screenshot
} from './helpers/macInput'

const ALT_FLAG = 0x80000
const KEYS = [
  { name: 'Cmd+J', code: 38, flags: COMMAND_FLAG, id: 'next-waiting-session' },
  { name: 'Cmd+B', code: 11, flags: COMMAND_FLAG, id: 'toggle-sidebar' },
  { name: 'Alt+Cmd+N', code: 45, flags: COMMAND_FLAG | ALT_FLAG, id: 'focus-notes' },
  { name: 'Cmd+P', code: 35, flags: COMMAND_FLAG, id: 'command-palette' }
]
const TIME_FOR_A_MENU_KEY_TO_LAND_MS = 1_500
const recordingPage = (block: boolean): string => `<body style="height:100vh"><p>probe</p><script>
window.__keys = [];
addEventListener('keydown', (e) => { window.__keys.push((e.metaKey ? 'Cmd+' : '') + (e.altKey ? 'Alt+' : '') + e.code); if (${block}) e.preventDefault(); });
</script></body>`

const test = e2eTest.extend<{ shown: { app: ElectronApplication; page: Page } }>({
  shown: async ({ env }, use) => {
    seedSettings(env, { hintsOff: true })
    env.launchEnv.KOLOFT_TEST_REAL_WINDOW = '1'
    const app = await launchApp(env)
    const page = await app.firstWindow()
    await waitBooted(page)
    await use({ app, page })
    await quitAndClose(app)
  }
})

test.skip(process.env.KOLOFT_REAL_WINDOW !== '1', 'real-window only')

const focusedType = (app: ElectronApplication): Promise<string | undefined> =>
  app.evaluate(({ webContents }) => webContents.getFocusedWebContents()?.getType())

const menuHits = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => [...((globalThis as { __menuHits?: string[] }).__menuHits ?? [])])

const guestInputs = (app: ElectronApplication): Promise<string[]> =>
  app.evaluate(() => [...((globalThis as { __guestInputs?: string[] }).__guestInputs ?? [])])

for (const block of [false, true])
  test(`probe: which menu keys reach the app menu while a Workbench web page has focus, page preventDefault=${block}`, async ({
    shown: { app, page }
  }, testInfo) => {
    expect(accessibilityTrusted()).toBe(true)
    const server = await startEchoServer()
    try {
      await startSessionIn(page, 'ws-a')
      const url = server.page('/probe', recordingPage(block))
      await openViaAgent(page, url)
      const guest = await guestByUrl(app, '/probe', { timeout: 40_000 })
      await app.evaluate(
        ({ Menu, webContents }, { ids, match }) => {
          const g = globalThis as { __menuHits?: string[]; __guestInputs?: string[] }
          g.__menuHits = []
          g.__guestInputs = []
          for (const id of ids) {
            const item = Menu.getApplicationMenu()?.getMenuItemById(id)
            if (!item) continue
            const original = item.click
            item.click = (...args: unknown[]) => {
              g.__menuHits?.push(id)
              return original.apply(item, args)
            }
          }
          const contents = webContents.getAllWebContents().find((w) => w.getURL().includes(match))
          contents?.on('before-input-event', (_e, input) => {
            if (input.type === 'keyDown')
              g.__guestInputs?.push(
                `${input.meta ? 'Cmd+' : ''}${input.alt ? 'Alt+' : ''}${input.code}`
              )
          })
        },
        { ids: KEYS.map((k) => k.id), match: '/probe' }
      )
      const webview = page.locator('webview >> visible=true').first()
      const results: Record<string, unknown>[] = []
      for (const key of KEYS) {
        const point = await screenPointOf(app, webview)
        realClick(point)
        await page.waitForTimeout(300)
        realClick(point)
        await expect.poll(() => focusedType(app)).toBe('webview')
        const hitsBefore = (await menuHits(app)).length
        const pageBefore = (
          (await guest.evaluate(() => (window as { __keys?: string[] }).__keys)) ?? []
        ).length
        const inputsBefore = (await guestInputs(app)).length
        realKey(key.code, key.flags)
        await page.waitForTimeout(TIME_FOR_A_MENU_KEY_TO_LAND_MS)
        results.push({
          key: key.name,
          focusedBefore: 'webview',
          menuItemFired: (await menuHits(app)).slice(hitsBefore),
          pageSawKeydown: (
            (await guest.evaluate(() => (window as { __keys?: string[] }).__keys)) ?? []
          ).slice(pageBefore),
          guestBeforeInputEvent: (await guestInputs(app)).slice(inputsBefore),
          focusedAfter: await focusedType(app),
          focusOwnerAfter: await focusOwner(page).catch(() => 'unknown')
        })
        screenshot(testInfo.outputPath(`after-${key.name}.png`))
        await page.keyboard.press('Escape').catch(() => {})
      }
      const termPoint = await screenPointOf(app, centerTerm(page))
      realClick(termPoint)
      await page.waitForTimeout(300)
      realClick(termPoint)
      const controlBefore = (await menuHits(app)).length
      realKey(11, COMMAND_FLAG)
      await page.waitForTimeout(TIME_FOR_A_MENU_KEY_TO_LAND_MS)
      const control = {
        key: 'Cmd+B with the terminal focused (control)',
        focusedBefore: 'terminal',
        menuItemFired: (await menuHits(app)).slice(controlBefore)
      }
      const electron = await app.evaluate(() => process.versions.electron)
      const report = { electron, pagePreventsDefault: block, results, control }
      fs.writeFileSync(testInfo.outputPath('result.json'), JSON.stringify(report, null, 2))
      console.log(JSON.stringify(report, null, 2))
      expect(control.menuItemFired).toEqual(['toggle-sidebar'])
    } finally {
      await server.close()
    }
  })
