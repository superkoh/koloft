import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { guestByUrl } from './helpers/browser'
import { installCodex, seedSettings, type E2EEnv } from './helpers/env'
import {
  addRemoteWorkspace,
  killFakeRemote,
  launchWithRemote,
  REMOTE_WS_NAME,
  remoteDir,
  writeExec
} from './helpers/remote'
import {
  centerTerm,
  newSessionInWith,
  sendShortcut,
  startSessionIn,
  termIds,
  terminalText,
  waitBooted,
  wsRows
} from './helpers/p1'

const KOLOFT_SHIM_WAITS_UP_TO_10S_PLUS_ROOM_MS = 30_000
const REMOTE_REQUESTS_RIDE_THE_MIRROR_PULL_MS = 60_000
const EXIT_MARK = /\[fake-(?:claude|codex)\] koloft exit=(\d+)/g
const LIVE_SCREEN = /^http:\/\/127\.0\.0\.1:\d+\/[0-9a-f]+\/$/
const SETTINGS_ICON_CENTRE = 'tap -x 50 -y 60 --udid FAKE-IPHONE-17'
const MIDDLE_OF_A_402_BY_874_SCREEN = 'tap -x 201 -y 437 --udid FAKE-IPHONE-17'
const FAKE_FRAME_WIDTH = 40

function installFakeSimulator(env: E2EEnv): string {
  const fixture = path.join(__dirname, 'fixtures', 'fake-simulator.js')
  for (const tool of ['xcrun', 'axe'])
    writeExec(
      path.join(env.fakeBin, tool),
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} ${tool} "$@"\n`
    )
  return path.join(env.home, 'fake-simulator-calls.txt')
}

function simulatorCalls(file: string): string[] {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n') : []
}

async function newestTab(page: Page): Promise<string> {
  const ids = await termIds(page)
  return ids[ids.length - 1]
}

async function koloft(
  page: Page,
  tabId: string,
  args: string,
  timeout = KOLOFT_SHIM_WAITS_UP_TO_10S_PLUS_ROOM_MS
): Promise<{ exit: string; said: string }> {
  const marks = async (): Promise<RegExpMatchArray[]> => [
    ...(await terminalText(page, tabId)).matchAll(EXIT_MARK)
  ]
  const before = (await marks()).length
  await page.evaluate(
    ([id, line]) => window.api.terminal.write(id, line),
    [tabId, `/koloft ${args}\r`]
  )
  await expect.poll(async () => (await marks()).length, { timeout }).toBe(before + 1)
  const text = await terminalText(page, tabId)
  const all = await marks()
  const from = before ? (all[before - 1].index ?? 0) + all[before - 1][0].length : 0
  return { exit: all[before][1], said: text.slice(from, all[before].index).replace(/\s+/g, ' ') }
}

async function untilReady(page: Page, tabId: string, timeout?: number): Promise<void> {
  await expect
    .poll(async () => (await koloft(page, tabId, 'phone status', timeout)).said, {
      timeout: 60_000
    })
    .toMatch(/The iPhone is ready\. Its screen is 402×874/)
}

async function liveScreen(app: ElectronApplication): Promise<Page> {
  const guest = await guestByUrl(app, LIVE_SCREEN)
  await expect
    .poll(() => guest.evaluate(() => document.querySelector('canvas')?.width), { timeout: 20_000 })
    .toBe(FAKE_FRAME_WIDTH)
  return guest
}

test.afterEach(({ env }) => killFakeRemote(env))

test.describe('koloft phone: a session drives a phone emulator whose live screen is in its Workbench', () => {
  test('PH-01: in a local Claude session, start ios opens the live screen in the Workbench; the AI reads the screen, taps by ref, saves a screenshot; a click on the live screen taps the phone; stop shuts it down', async ({
    env
  }) => {
    test.setTimeout(180_000)
    const calls = installFakeSimulator(env)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      const tab = await newestTab(page)

      const started = await koloft(page, tab, 'phone start ios')
      expect(started.exit).toBe('0')
      expect(started.said).toMatch(
        /Starting the iPhone; its live screen opens in this session's Workbench/
      )
      await untilReady(page, tab)
      const guest = await liveScreen(app)
      await expect(guest.locator('#note')).toHaveText(/Click to tap/)

      const snapshot = await koloft(page, tab, 'phone snapshot')
      expect(snapshot.said).toContain('@e1 [button] "Settings" at 50 60')
      expect((await koloft(page, tab, 'phone tap @e1')).exit).toBe('0')
      expect(simulatorCalls(calls)).toContain(`axe ${SETTINGS_ICON_CENTRE}`)

      expect((await koloft(page, tab, 'phone screenshot shots/home.png')).said).toMatch(
        /Saved the screenshot to .*shots\/home\.png \(1×1 pixels\)/
      )
      expect(fs.existsSync(path.join(env.workspaces.a, 'shots', 'home.png'))).toBe(true)

      await guest.locator('canvas').click()
      await expect
        .poll(() => simulatorCalls(calls))
        .toContain(`axe ${MIDDLE_OF_A_402_BY_874_SCREEN}`)

      expect((await koloft(page, tab, 'phone stop')).said).toContain('Stopped the iPhone.')
      expect(simulatorCalls(calls)).toContain('xcrun simctl shutdown FAKE-IPHONE-17')
      expect((await koloft(page, tab, 'phone status')).said).toContain('No phone is running.')
    } finally {
      await quitAndClose(app)
    }
  })

  test('PH-02: a Codex session drives the phone the same way, through koloft', async ({ env }) => {
    test.setTimeout(180_000)
    const calls = installFakeSimulator(env)
    installCodex(env)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await newSessionInWith(page, 'ws-a', 'Codex')
      await expect(wsRows(page, 'ws-a')).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
      const tab = await newestTab(page)

      expect((await koloft(page, tab, 'phone start ios')).exit).toBe('0')
      await untilReady(page, tab)
      await liveScreen(app)
      expect((await koloft(page, tab, 'phone snapshot')).said).toContain('@e1 [button] "Settings"')
      expect((await koloft(page, tab, 'phone tap @e1')).exit).toBe('0')
      expect(simulatorCalls(calls)).toContain(`axe ${SETTINGS_ICON_CENTRE}`)
    } finally {
      await quitAndClose(app)
    }
  })

  test('PH-03: a remote (ssh) Claude session drives the phone on the Mac, its live screen opens in the Workbench, and its screenshot lands on the remote machine', async ({
    env
  }) => {
    test.setTimeout(300_000)
    const calls = installFakeSimulator(env)
    seedSettings(env, { hintsOff: true })
    const { app, page } = await launchWithRemote(env)
    try {
      await addRemoteWorkspace(page, env)
      await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
      const tab = await newestTab(page)
      const slow = REMOTE_REQUESTS_RIDE_THE_MIRROR_PULL_MS

      expect((await koloft(page, tab, 'phone start ios', slow)).exit).toBe('0')
      await untilReady(page, tab, slow)
      await liveScreen(app)
      expect((await koloft(page, tab, 'phone tap 50 60', slow)).exit).toBe('0')
      expect(simulatorCalls(calls)).toContain(`axe ${SETTINGS_ICON_CENTRE}`)
      expect((await koloft(page, tab, 'phone screenshot home.png', slow)).exit).toBe('0')
      expect(fs.existsSync(path.join(remoteDir(env), 'home.png'))).toBe(true)
      expect((await koloft(page, tab, 'phone install App.app', slow)).said).toMatch(
        /this session runs on another machine/
      )
    } finally {
      await quitAndClose(app)
    }
  })

  test("PH-04: only one phone runs: another session's start is refused and names the session that has it, and closing that session's tab shuts the phone down", async ({
    env
  }) => {
    test.setTimeout(180_000)
    const calls = installFakeSimulator(env)
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      const owner = await newestTab(page)
      expect((await koloft(page, owner, 'phone start ios')).exit).toBe('0')
      await untilReady(page, owner)

      await startSessionIn(page, 'ws-b')
      const other = await newestTab(page)
      const refused = await koloft(page, other, 'phone start ios')
      expect(refused.exit).toBe('1')
      expect(refused.said).toMatch(
        /another session .*has the iPhone, and only one phone runs at a time/
      )
      expect((await koloft(page, other, 'phone snapshot')).exit).toBe('1')

      await wsRows(page, 'ws-a').first().click()
      await centerTerm(page).click()
      await sendShortcut(app, 'shortcut:close-tab')
      await expect
        .poll(() => simulatorCalls(calls))
        .toContain('xcrun simctl shutdown FAKE-IPHONE-17')
      expect((await koloft(page, other, 'phone status')).said).toContain('No phone is running.')
    } finally {
      await quitAndClose(app)
    }
  })

  test('PH-05: on a Mac without Xcode, start ios says how to get it and starts nothing', async ({
    env
  }) => {
    test.setTimeout(120_000)
    installFakeSimulator(env)
    fs.writeFileSync(path.join(env.home, 'fake-xcode-missing'), '')
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await startSessionIn(page, 'ws-a')
      const tab = await newestTab(page)
      const refused = await koloft(page, tab, 'phone start ios')
      expect(refused.exit).toBe('1')
      expect(refused.said).toContain('iOS needs Xcode. Install Xcode from the App Store')
      expect((await koloft(page, tab, 'phone status')).said).toContain('No phone is running.')
    } finally {
      await quitAndClose(app)
    }
  })
})
