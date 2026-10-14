import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { guestByUrl } from './helpers/browser'
import { seedSettings } from './helpers/env'
import { startSessionIn, termIds, terminalText, waitBooted } from './helpers/p1'
import { ANDROID_PACKAGES } from '../../src/main/phone/androidSdk'

const SDK = process.env.KOLOFT_SMOKE_ANDROID_SDK ?? ''
const NEEDS_SDK =
  "set KOLOFT_SMOKE_ANDROID_SDK (an Android SDK folder holding emulator/, platform-tools/ and system-images/android-36/google_apis/arm64-v8a/, as Koloft's own download lays it out)"
const EXIT_MARK = /\[fake-claude\] koloft exit=(\d+)/g
const A_COLD_BOOT_AND_THE_HELPER_APP_MS = 4 * 60_000

function lendSdk(userData: string): void {
  const phone = path.join(userData, 'phone')
  fs.mkdirSync(phone, { recursive: true })
  fs.symlinkSync(SDK, path.join(phone, 'android-sdk'))
  for (const p of ANDROID_PACKAGES) fs.writeFileSync(path.join(SDK, `.koloft-${p.name}-ready`), '')
}

async function koloft(page: Page, tabId: string, args: string): Promise<string> {
  const marks = async (): Promise<number> =>
    [...(await terminalText(page, tabId)).matchAll(EXIT_MARK)].length
  const before = await marks()
  await page.evaluate(
    ([id, line]) => window.api.terminal.write(id, line),
    [tabId, `/koloft ${args}\r`]
  )
  await expect.poll(marks, { timeout: 30_000 }).toBe(before + 1)
  const text = await terminalText(page, tabId)
  return text.slice(text.lastIndexOf(`/koloft ${args}`)).replace(/\s+/g, ' ')
}

test.describe('koloft phone with the real Android emulator', () => {
  test.skip(!SDK, NEEDS_SDK)

  test('start android boots the emulator with no window, the AI reads the screen, presses Home and takes a 1080×2400 screenshot, the live screen streams into the Workbench, and stop ends the emulator', async ({
    env
  }) => {
    test.setTimeout(8 * 60_000)
    lendSdk(env.userData)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      const ids = await termIds(page)
      const tab = ids[ids.length - 1]

      expect(await koloft(page, tab, 'phone start android')).toMatch(/exit=0/)
      await expect
        .poll(() => koloft(page, tab, 'phone status'), {
          timeout: A_COLD_BOOT_AND_THE_HELPER_APP_MS,
          intervals: [5_000]
        })
        .toMatch(/The Android phone is ready\. Its screen is 1080×2400/)

      expect(await koloft(page, tab, 'phone snapshot')).toMatch(/@e1 \[/)
      expect(await koloft(page, tab, 'phone key home')).toMatch(/Pressed home\..*exit=0/)
      expect(await koloft(page, tab, 'phone screenshot home.png')).toMatch(/\(1080×2400 pixels\)/)

      const guest = await guestByUrl(app, /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+\/$/)
      await expect
        .poll(() => guest.evaluate(() => document.querySelector('canvas')?.width), {
          timeout: 30_000
        })
        .toBe(540)

      expect(await koloft(page, tab, 'phone stop')).toMatch(/Stopped the Android phone\./)
      const log = fs.readFileSync(path.join(env.userData, 'phone', 'android-emulator.log'), 'utf8')
      expect(log).toMatch(/Started GRPC server at 127\.0\.0\.1:\d+, security: Local, auth: \+token/)
    } finally {
      await quitAndClose(app)
    }
  })
})
