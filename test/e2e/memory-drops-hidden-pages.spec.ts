import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { koloftReadMemoryPressure, memoryPressure, seedSettings } from './helpers/env'
import {
  centerTerm,
  newSessionInWith,
  runIn,
  startSessionIn,
  switchToRow,
  terminalText,
  waitBooted,
  wsRows
} from './helpers/p1'
import { BROWSER, cdpEndpointOf, connectCdp, guestByUrl, guestContents } from './helpers/browser'
import { hostResolverSwitch, startEchoServer, type FixtureServer } from './helpers/fixtureServer'
import { wbFrozenTabs, wbTabByTitle } from './helpers/workbench'
import {
  OTHER_AGENTS_ON_THE_MACHINE,
  REMOTE_WS_NAME,
  addRemoteWorkspace,
  killFakeRemote,
  launchWithRemote
} from './helpers/remote'

const TWO_READINGS_FIVE_SECONDS_APART_PLUS_ROOM_MS = 40_000
const ONE_MIRROR_PULL_LATE_PLUS_TWO_READINGS_MS = 60_000
const KOLOFT_ON_THE_MACHINE_WAITS_UP_TO_30S_PLUS_ROOM_MS = 45_000
const PAGE_HOST_THAT_IS_NOT_THE_MAC = 'remote-page.test'
const SLOW_ENOUGH_TO_SEE_THE_LOADING_BAR_MS = 2000
const SECRET_BAR = '[role="alertdialog"][aria-label="Secret ask"]'

let server: FixtureServer

test.beforeAll(async () => {
  server = await startEchoServer()
})

test.afterAll(async () => {
  await server?.close()
})

function pageNamed(name: string, body = ''): string {
  return server.page(`/${name}`, `<!doctype html><title>${name}</title><p>${name}</p>${body}`)
}

async function openAndShow(page: Page, name: string, body = ''): Promise<void> {
  await runIn(page, centerTerm(page), `/open ${pageNamed(name, body)}`)
  await wbTabByTitle(page, name).click()
  await expect.poll(() => server.count(`/${name}`), { timeout: 30_000 }).toBeGreaterThan(0)
}

async function pagesAlive(app: ElectronApplication): Promise<string[]> {
  return (await guestContents(app))
    .map((g) => /^https?:\/\/[^/]+\/([^?#]*)/.exec(g.url)?.[1] ?? '')
    .filter(Boolean)
    .sort()
}

test.describe('when memory turns critical, Koloft lets go of the Workbench web pages nobody can see', () => {
  test('the pages of a session whose turn is still running stay, go once the turn is over, and on return the address bar shows the page loading again', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(300_000)
    const slow = server.route('/mid-turn', (_q, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/html' })
        res.end('<!doctype html><title>mid-turn</title><p>mid-turn</p>')
      }, SLOW_ENOUGH_TO_SEE_THE_LOADING_BAR_MS)
    })
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    const busyRow = wsRows(page, 'ws-a').first()
    const busyTab = (await busyRow.getAttribute('data-tab-id'))!
    await runIn(page, centerTerm(page), `/open ${slow}`)
    await wbTabByTitle(page, 'mid-turn').click()
    await expect((await guestByUrl(app, '/mid-turn')).locator('p')).toHaveText('mid-turn')
    await runIn(page, centerTerm(page), '/hold')
    await expect(busyRow).toHaveClass(/\bst-working\b/, { timeout: 30_000 })

    await startSessionIn(page, 'ws-b')
    await openAndShow(page, 'unused')
    await openAndShow(page, 'on-screen')
    memoryPressure(env, 4)
    await expect
      .poll(() => pagesAlive(app), { timeout: TWO_READINGS_FIVE_SECONDS_APART_PLUS_ROOM_MS })
      .toEqual(['mid-turn', 'on-screen'])

    await page.evaluate((id) => window.api.terminal.write(id, '\x1b'), busyTab)
    await expect(busyRow).toHaveClass(/\bst-waiting\b/, { timeout: 30_000 })
    await expect
      .poll(() => pagesAlive(app), { timeout: TWO_READINGS_FIVE_SECONDS_APART_PLUS_ROOM_MS })
      .toEqual(['on-screen'])

    await switchToRow(page, busyRow)
    await expect(page.locator(BROWSER.progress)).toBeVisible()
    await expect((await guestByUrl(app, '/mid-turn')).locator('p')).toHaveText('mid-turn')
  })

  test('at warning nothing goes; at critical every hidden page goes — another tab of the shown session, another session’s — the one on screen stays, each comes back by itself when the owner returns to it, and a page hidden later, while memory is still critical, goes too', async ({
    app,
    page,
    env
  }) => {
    test.setTimeout(300_000)
    await waitBooted(page)
    await startSessionIn(page, 'ws-a')
    await openAndShow(page, 'other-session')
    await startSessionIn(page, 'ws-b')
    await openAndShow(page, 'hidden-tab')
    await openAndShow(page, 'on-screen')
    const everyPage = ['hidden-tab', 'on-screen', 'other-session']
    await expect.poll(() => pagesAlive(app)).toEqual(everyPage)

    memoryPressure(env, 2)
    await expect
      .poll(() => koloftReadMemoryPressure(env, 2), {
        timeout: TWO_READINGS_FIVE_SECONDS_APART_PLUS_ROOM_MS
      })
      .toBe(true)
    expect(await pagesAlive(app)).toEqual(everyPage)

    memoryPressure(env, 4)
    await expect
      .poll(() => pagesAlive(app), { timeout: TWO_READINGS_FIVE_SECONDS_APART_PLUS_ROOM_MS })
      .toEqual(['on-screen'])
    await expect(wbFrozenTabs(page)).toHaveCount(1)
    await expect(wbFrozenTabs(page)).toContainText('hidden-tab')
    expect(server.count('/hidden-tab')).toBe(1)
    expect(server.count('/other-session')).toBe(1)

    await wbTabByTitle(page, 'hidden-tab').click()
    await expect.poll(() => server.count('/hidden-tab'), { timeout: 30_000 }).toBe(2)
    await expect((await guestByUrl(app, '/hidden-tab')).locator('p')).toHaveText('hidden-tab')
    await expect
      .poll(() => pagesAlive(app), { timeout: TWO_READINGS_FIVE_SECONDS_APART_PLUS_ROOM_MS })
      .toEqual(['hidden-tab'])

    await switchToRow(page, wsRows(page, 'ws-a').first())
    await expect.poll(() => server.count('/other-session'), { timeout: 30_000 }).toBe(2)
    await expect((await guestByUrl(app, '/other-session')).locator('p')).toHaveText('other-session')
    await expect(page.locator(BROWSER.emptyState)).toHaveCount(0)
    await expect(wbFrozenTabs(page)).toHaveCount(0)
  })

  test('a hidden page stays when an agent is connected to its session’s browser, or its session waits for the owner to fill in a field on a page, while a hidden page nobody uses goes in the same moment', async ({
    env
  }) => {
    test.setTimeout(300_000)
    seedSettings(env, { hintsOff: true })
    const presence = path.join(env.home, 'presence.txt')
    fs.writeFileSync(presence, 'active')
    env.launchEnv.KOLOFT_TEST_PRESENCE_FILE = presence
    const app = await launchApp(env)
    const page = await app.firstWindow()
    await waitBooted(page)
    let agent: Awaited<ReturnType<typeof connectCdp>> | undefined
    try {
      await startSessionIn(page, 'ws-a')
      await openAndShow(page, 'beside-the-asked')
      await openAndShow(page, 'asked', '<form action="/asked-done"><input type="password" id="pw">')
      await runIn(page, centerTerm(page), '/koloft secret page "#pw"')
      await expect(page.locator(SECRET_BAR)).toBeVisible({ timeout: 30_000 })

      await startSessionIn(page, 'ws-b')
      agent = await connectCdp(page, await cdpEndpointOf(env))
      const driven = await agent.contexts()[0].newPage()
      await driven.goto(pageNamed('driven'))
      await expect(page.locator(BROWSER.drivenTab)).toHaveCount(1, { timeout: 30_000 })

      await startSessionIn(page, 'ws-a')
      await openAndShow(page, 'unused')
      await openAndShow(page, 'on-screen')
      await expect
        .poll(() => pagesAlive(app))
        .toEqual(['asked', 'beside-the-asked', 'driven', 'on-screen', 'unused'])

      memoryPressure(env, 4)
      await expect
        .poll(() => pagesAlive(app), { timeout: TWO_READINGS_FIVE_SECONDS_APART_PLUS_ROOM_MS })
        .toEqual(['asked', 'beside-the-asked', 'driven', 'on-screen'])
      expect(await driven.title()).toBe('driven')
    } finally {
      await agent?.close().catch(() => {})
      await quitAndClose(app)
    }
  })
})

async function koloftExits(page: Page, tabId: string): Promise<string[]> {
  return [
    ...(await terminalText(page, tabId)).matchAll(/\[fake-(?:codex|muse|agy)\] koloft exit=(\d+)/g)
  ].map((m) => m[1])
}

async function agentOpens(page: Page, tabId: string, name: string): Promise<void> {
  const url = pageNamed(name).replace('127.0.0.1', PAGE_HOST_THAT_IS_NOT_THE_MAC)
  const before = (await koloftExits(page, tabId)).length
  await page.evaluate(
    ([tab, line]) => window.api.terminal.write(tab, line + '\r'),
    [tabId, `/koloft open ${url}`]
  )
  await expect
    .poll(async () => (await koloftExits(page, tabId)).length, {
      timeout: KOLOFT_ON_THE_MACHINE_WAITS_UP_TO_30S_PLUS_ROOM_MS
    })
    .toBe(before + 1)
  expect((await koloftExits(page, tabId))[before]).toBe('0')
  await expect.poll(() => server.count(`/${name}`), { timeout: 30_000 }).toBeGreaterThan(0)
}

for (const agent of OTHER_AGENTS_ON_THE_MACHINE)
  test.describe(`a ${agent.label} tab on a machine reached over SSH, when memory turns critical`, () => {
    test.afterEach(({ env }) => killFakeRemote(env))

    test(`the pages ${agent.label} on the machine opened go once nobody can see them, the one on screen stays, and each loads again by itself when the owner comes back to it`, async ({
      env
    }) => {
      test.setTimeout(300_000)
      agent.install(env)
      seedSettings(env, { hintsOff: true })
      env.extraArgs.push(hostResolverSwitch([PAGE_HOST_THAT_IS_NOT_THE_MAC]))
      const hidden = `${agent.label.toLowerCase()}-hidden`
      const shown = `${agent.label.toLowerCase()}-shown`
      const { app, page } = await launchWithRemote(env)
      try {
        await addRemoteWorkspace(page, env)
        await newSessionInWith(page, REMOTE_WS_NAME, agent.label)
        await agent.bound?.(page)
        const remoteRow = wsRows(page, REMOTE_WS_NAME).first()
        await expect(remoteRow).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
        const remoteTab = (await remoteRow.getAttribute('data-tab-id'))!
        await switchToRow(page, remoteRow)

        await agentOpens(page, remoteTab, hidden)
        await agentOpens(page, remoteTab, shown)
        await wbTabByTitle(page, shown).click()
        await expect.poll(() => pagesAlive(app), { timeout: 30_000 }).toEqual([hidden, shown])

        memoryPressure(env, 4)
        await expect
          .poll(() => pagesAlive(app), { timeout: ONE_MIRROR_PULL_LATE_PLUS_TWO_READINGS_MS })
          .toEqual([shown])
        await expect(wbFrozenTabs(page)).toContainText(hidden)

        await startSessionIn(page, 'ws-a', { method: 'Claude' })
        await expect
          .poll(() => pagesAlive(app), { timeout: TWO_READINGS_FIVE_SECONDS_APART_PLUS_ROOM_MS })
          .toEqual([])
        expect(server.count(`/${shown}`)).toBe(1)

        await switchToRow(page, remoteRow)
        await expect.poll(() => server.count(`/${shown}`), { timeout: 30_000 }).toBe(2)
        await expect((await guestByUrl(app, `/${shown}`)).locator('p')).toHaveText(shown)
        await wbTabByTitle(page, hidden).click()
        await expect.poll(() => server.count(`/${hidden}`), { timeout: 30_000 }).toBe(2)
        await expect((await guestByUrl(app, `/${hidden}`)).locator('p')).toHaveText(hidden)
      } finally {
        await quitAndClose(app)
      }
    })
  })
