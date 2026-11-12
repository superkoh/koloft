import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import {
  installAgy,
  installCodex,
  installMuse,
  seedSettings,
  trustInAgy,
  trustInMuse,
  type E2EEnv
} from './helpers/env'
import {
  centerTerm,
  newSessionInWith,
  openSessionTerminal,
  panelTerm,
  runIn,
  startSessionIn,
  terminalText,
  waitBooted,
  waitConductorStarted,
  waitForCalls,
  wsRows
} from './helpers/p1'
import {
  addRemoteWorkspace,
  killFakeRemote,
  launchWithRemote,
  OTHER_AGENTS_ON_THE_MACHINE,
  REMOTE_WS_NAME
} from './helpers/remote'
import {
  OPEN_A_FORM,
  startFakeDiscord,
  type FakeDiscord,
  type FakePost
} from './helpers/fakeDiscord'
import { guestByUrl } from './helpers/browser'
import { startEchoServer, type FixtureServer } from './helpers/fixtureServer'
import { DONE_AT_THE_MAC, TAPS_PASSED } from '../../src/main/agentPageTap'
import { PASSED, TAPPING } from '../../src/main/discord/secretAsks'

test.setTimeout(150_000)

const OWNER = { id: '555', username: 'letian' }
const CHANNEL = '222'
const CONDUCTOR_STARTS_MS = 60_000
const CARD_HEADER = /^👆 \*\*.+\*\* asks you to tap a web page/
const SECRET_BAR = '[role="alertdialog"][aria-label="Secret ask"]'
const PAGE_ZOOM = 1.5

const HOLDER = { width: 300, height: 150 }
const FRAME = { x: 75, y: 45, width: 150, height: 60 }

function seedBinding(env: E2EEnv): void {
  seedSettings(env, {
    hintsOff: true,
    assist: { backend: 'claude' },
    discord: {
      userId: OWNER.id,
      userName: OWNER.username,
      channel: { guildId: '111', channelId: CHANNEL, name: 'koloft-all' }
    }
  })
}

function servePageWithAFrameFromAnotherSite(
  server: FixtureServer,
  frameUrl = server.localhostUrl('/frame')
): string {
  server.page(
    '/frame',
    '<!doctype html><style>html,body{margin:0;height:100%;background:rgb(0,90,255)}</style>' +
      '<script>let n=0;addEventListener("click",function(e){n++;parent.postMessage({n:n,trusted:e.isTrusted},"*")})</script>'
  )
  return server.page(
    '/check',
    '<!doctype html><title>check</title><style>body{margin:0;background:#fff}' +
      `#holder{position:absolute;left:10px;top:10px;width:${HOLDER.width}px;height:${HOLDER.height}px;background:#fff}` +
      `#holder iframe{position:absolute;left:${FRAME.x}px;top:${FRAME.y}px;width:${FRAME.width}px;height:${FRAME.height}px;border:0}</style>` +
      `<div id="holder"><iframe src="${frameUrl}"></iframe></div>` +
      '<script>addEventListener("message",function(e){document.title="taps:"+e.data.n+":"+e.data.trusted})</script>'
  )
}

async function sessionTab(page: Page, env: E2EEnv): Promise<string> {
  await startSessionIn(page, 'ws-a')
  const sessionId = (await waitForCalls(env, 1))[0].sessionId
  const all = await page.evaluate(() => window.api.sessions.list())
  return all.find((s) => s.sessionId === sessionId)!.tabId
}

function type(page: Page, tab: string, line: string): Promise<void> {
  return page.evaluate(([id, l]) => window.api.terminal.write(id, l + '\r'), [tab, line])
}

function zoomPage(app: ElectronApplication, urlPart: string, zoom: number): Promise<void> {
  return app.evaluate(
    ({ webContents }, [part, factor]) => {
      for (const wc of webContents.getAllWebContents())
        if (wc.getURL().includes(part as string)) wc.setZoomFactor(factor as number)
    },
    [urlPart, zoom] as const
  )
}

async function colorAt(
  app: ElectronApplication,
  png: Buffer,
  at: { x: number; y: number }
): Promise<[number, number, number]> {
  return app.evaluate(
    ({ nativeImage }, [b64, fx, fy]) => {
      const img = nativeImage.createFromBuffer(Buffer.from(b64 as string, 'base64'))
      const { width, height } = img.getSize()
      const bmp = img.toBitmap()
      const i =
        (Math.floor((fy as number) * height) * width + Math.floor((fx as number) * width)) * 4
      return [bmp[i + 2], bmp[i + 1], bmp[i]] as [number, number, number]
    },
    [png.toString('base64'), at.x / HOLDER.width, at.y / HOLDER.height] as const
  )
}

function cards(fake: FakeDiscord): FakePost[] {
  return fake.posted.filter((p) => p.channelId === CHANNEL && CARD_HEADER.test(p.content))
}

function pictures(fake: FakeDiscord): FakePost[] {
  return fake.posted.filter(
    (p) => p.channelId === CHANNEL && p.files.some((f) => f.name === 'page.png')
  )
}

const bare = (s: string): string => s.replace(/\s+/g, '')

const editsOf = (fake: FakeDiscord, card: FakePost): string =>
  fake.edits
    .filter((e) => e.id === card.id)
    .map((e) => e.content)
    .join('\n')

async function tapsOneSquareInTheFrameThenSaysItPassed(
  fake: FakeDiscord,
  guest: Page
): Promise<void> {
  await expect.poll(() => cards(fake).length, { timeout: 30_000 }).toBe(1)
  const card = cards(fake)[0]
  fake.press(OWNER, card.buttons![0], card.channelId)
  await expect
    .poll(() => fake.callbacks.find((c) => c.type === OPEN_A_FORM)?.data.custom_id)
    .toBe(card.buttons![0].id)
  fake.submit(OWNER, card.buttons![0].id, 'a1 G4', card.channelId)
  await expect.poll(() => fake.callbacks.map((c) => c.data.content)).toContain(TAPPING)
  await expect.poll(() => guest.title(), { timeout: 20_000 }).toBe('taps:1:true')

  await expect.poll(() => cards(fake).length, { timeout: 30_000 }).toBe(2)
  expect(pictures(fake)).toHaveLength(2)
  const next = cards(fake)[1]
  expect(next.content).toContain('Tapped A1, G4.')
  await expect.poll(() => editsOf(fake, card)).toContain('Tapped A1, G4.')

  const passed = next.buttons!.find((b) => b.label === 'It passed')!
  fake.press(OWNER, passed, next.channelId)
  await expect.poll(() => editsOf(fake, next)).toContain(PASSED)
}

test.describe('koloft page tap: the owner taps a part of a web page from Discord, through a picture with a grid, and Koloft clicks there for real', () => {
  test('away from the Mac, a part of a zoomed page whose session is not on screen goes to the butler’s channel as a picture that shows the frame from another site in its place, then a card; squares typed in its box become real clicks inside that frame, a new picture and card follow, and "It passed" ends the command', async ({
    env
  }) => {
    seedBinding(env)
    const fake = await startFakeDiscord(env)
    const server = await startEchoServer()
    const app = await launchApp(env)
    try {
      const url = servePageWithAFrameFromAnotherSite(server)
      const page = await app.firstWindow()
      await waitBooted(page)
      await expect.poll(() => fake.identifies).toBe(1)
      await waitConductorStarted(env, CONDUCTOR_STARTS_MS)
      const tab = await sessionTab(page, env)
      await type(page, tab, `/koloft open ${url}`)
      const guest = await guestByUrl(app, '/check')
      await expect(guest.locator('#holder iframe')).toBeVisible()
      await zoomPage(app, '/check', PAGE_ZOOM)
      await startSessionIn(page, 'ws-b')
      await type(page, tab, '/koloft page tap "#holder" -- "Tick the box."')

      await expect.poll(() => cards(fake).length, { timeout: 30_000 }).toBe(1)
      const card = cards(fake)[0]
      expect(card.content).toMatch(/^👆 \*\*.+ · ws-a\*\*/)
      expect(card.content).toContain('Tick the box.')
      const first = pictures(fake)
      expect(first).toHaveLength(1)
      expect(fake.posted.indexOf(first[0])).toBeLessThan(fake.posted.indexOf(card))
      const png = first[0].files[0].data
      const inFrame = await colorAt(app, png, { x: 160, y: 90 })
      expect(inFrame[2]).toBeGreaterThan(200)
      expect(inFrame[0]).toBeLessThan(60)
      const besideFrame = await colorAt(app, png, { x: 40, y: 130 })
      expect(Math.min(...besideFrame)).toBeGreaterThan(200)

      await tapsOneSquareInTheFrameThenSaysItPassed(fake, guest)
      await expect
        .poll(async () => bare(await terminalText(page, tab)), { timeout: 20_000 })
        .toContain(bare(TAPS_PASSED))
    } finally {
      await quitAndClose(app)
      await fake.close()
      await server.close()
    }
  })

  test('while the owner is at the Mac, the ask shows only in the session’s Workbench over the page, nothing goes to Discord, and Done ends the command', async ({
    env
  }) => {
    seedBinding(env)
    const presence = path.join(env.home, 'presence.txt')
    fs.writeFileSync(presence, 'active')
    env.launchEnv.KOLOFT_TEST_PRESENCE_FILE = presence
    const fake = await startFakeDiscord(env)
    const server = await startEchoServer()
    const app = await launchApp(env)
    try {
      const url = servePageWithAFrameFromAnotherSite(server)
      const page = await app.firstWindow()
      await waitBooted(page)
      await expect.poll(() => fake.identifies).toBe(1)
      await waitConductorStarted(env, CONDUCTOR_STARTS_MS)
      const tab = await sessionTab(page, env)
      await type(page, tab, `/koloft open ${url}`)
      const guest = await guestByUrl(app, '/check')
      await expect(guest.locator('#holder iframe')).toBeVisible()
      await type(page, tab, '/koloft page tap "#holder iframe" -- "Tick the box."')
      const bar = page.locator(SECRET_BAR)
      await expect(bar).toContainText('Tick the box.')
      await bar.getByRole('button', { name: 'Done' }).click()
      await expect
        .poll(async () => bare(await terminalText(page, tab)), { timeout: 20_000 })
        .toContain(bare(DONE_AT_THE_MAC))
      expect(cards(fake)).toEqual([])
      expect(pictures(fake)).toEqual([])
    } finally {
      await quitAndClose(app)
      await fake.close()
      await server.close()
    }
  })

  const OTHER_AGENTS_ON_THIS_MAC = [
    {
      label: 'Codex' as const,
      install: (env: E2EEnv) => installCodex(env)
    },
    {
      label: 'Muse' as const,
      install: (env: E2EEnv) => {
        installMuse(env)
        trustInMuse(env, env.workspaces.a)
      }
    },
    {
      label: 'Antigravity' as const,
      install: (env: E2EEnv) => {
        installAgy(env)
        trustInAgy(env, env.workspaces.a)
      }
    }
  ]

  for (const agent of OTHER_AGENTS_ON_THIS_MAC) {
    test(`run in a ${agent.label} session on this Mac, it finds the page in that session’s Workbench and the owner taps it from Discord`, async ({
      env
    }) => {
      seedBinding(env)
      agent.install(env)
      const fake = await startFakeDiscord(env)
      const server = await startEchoServer()
      const app = await launchApp(env)
      try {
        const url = servePageWithAFrameFromAnotherSite(server)
        const page = await app.firstWindow()
        await waitBooted(page)
        await expect.poll(() => fake.identifies).toBe(1)
        await waitConductorStarted(env, CONDUCTOR_STARTS_MS)
        if (agent.label === 'Antigravity') {
          await newSessionInWith(page, 'ws-a', agent.label)
          await runIn(page, centerTerm(page), 'first words')
          await expect(wsRows(page, 'ws-a')).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
        } else await startSessionIn(page, 'ws-a', { method: agent.label })
        await openSessionTerminal(app, page)
        const shell = (await page.locator('.wb-panel .wb-term:visible').getAttribute('data-pty'))!
        await type(page, shell, `koloft open ${url}`)
        const guest = await guestByUrl(app, '/check', { timeout: 30_000 })
        await expect(guest.locator('#holder iframe')).toBeVisible()
        await type(page, shell, 'koloft page tap "#holder" -- "Tick the box."')
        await tapsOneSquareInTheFrameThenSaysItPassed(fake, guest)
        await expect
          .poll(async () => bare(await terminalText(page, shell)), { timeout: 30_000 })
          .toContain(bare(TAPS_PASSED))
      } finally {
        await quitAndClose(app)
        await fake.close()
        await server.close()
      }
    })
  }

  test.describe('on another machine', () => {
    test.afterEach(({ env }) => killFakeRemote(env))
    const PAGE_SITE = 'check-page.test'
    const FRAME_SITE = 'check-frame.test'

    for (const agent of [{ label: 'Claude' as const }, ...OTHER_AGENTS_ON_THE_MACHINE]) {
      test(`run in a ${agent.label} session on another machine, it finds the page in that session’s Workbench and the owner taps it from Discord`, async ({
        env
      }) => {
        test.setTimeout(240_000)
        const other = 'install' in agent ? agent : undefined
        seedBinding(env)
        other?.install(env)
        env.extraArgs.push(
          `--host-resolver-rules=MAP ${PAGE_SITE} 127.0.0.1,MAP ${FRAME_SITE} 127.0.0.1`
        )
        const fake = await startFakeDiscord(env)
        const server = await startEchoServer()
        const { app, page } = await launchWithRemote(env)
        try {
          servePageWithAFrameFromAnotherSite(server, server.hostUrl(FRAME_SITE, '/frame'))
          const url = server.hostUrl(PAGE_SITE, '/check')
          await expect.poll(() => fake.identifies).toBe(1)
          await waitConductorStarted(env, CONDUCTOR_STARTS_MS)
          await addRemoteWorkspace(page, env)
          if (other) {
            await newSessionInWith(page, REMOTE_WS_NAME, other.label)
            await other.bound?.(page)
          } else await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
          await openSessionTerminal(app, page)
          const shell = (await page.locator('.wb-panel .wb-term:visible').getAttribute('data-pty'))!
          await runIn(page, panelTerm(page), `koloft open ${url}`)
          const guest = await guestByUrl(app, '/check', { timeout: 30_000 })
          await expect(guest.locator('#holder iframe')).toBeVisible()
          await type(page, shell, 'koloft page tap "#holder" -- "Tick the box."')
          await tapsOneSquareInTheFrameThenSaysItPassed(fake, guest)
          await expect
            .poll(async () => bare(await terminalText(page, shell)), { timeout: 30_000 })
            .toContain(bare(TAPS_PASSED))
        } finally {
          await quitAndClose(app)
          await fake.close()
          await server.close()
        }
      })
    }
  })
})
