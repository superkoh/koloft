import fs from 'fs'
import path from 'path'
import type { ElectronApplication, Page } from '@playwright/test'
import {
  test,
  expect,
  expectNoToastAtAnyMomentOfAWindow,
  launchApp,
  osOutlets,
  pendingAttention,
  pretendWindowFocused,
  quitAndClose
} from './helpers/app'
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
import { startFakeDiscord, type FakeDiscord, type PostFailure } from './helpers/fakeDiscord'
import { guestByUrl } from './helpers/browser'
import { startEchoServer } from './helpers/fixtureServer'

test.setTimeout(150_000)

const OWNER = { id: '555', username: 'letian' }
const CHANNEL = '222'
const CONDUCTOR_STARTS_MS = 60_000
const SUDO_BOX = '.term-wrap .secret-modal'
const SECRET_BAR = '[role="alertdialog"][aria-label="Secret ask"]'
const NOTHING_RAISES_IT_LATER_MS = 5_000
const POST_REFUSED_TOAST = /^Koloft could not post to #koloft-all in Discord: Discord answered 40/

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

function presenceFile(env: E2EEnv, where: 'active' | 'idle'): string {
  const file = path.join(env.home, 'presence.txt')
  fs.writeFileSync(file, where)
  env.launchEnv.KOLOFT_TEST_PRESENCE_FILE = file
  return file
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

function askSudo(page: Page, tab: string): Promise<void> {
  return type(
    page,
    tab,
    `/sh "$(dirname "$(command -v koloft)")/koloft-askpass" 'Password:' && echo got-it`
  )
}

async function marksAsking(page: Page): Promise<string[]> {
  return (await pendingAttention(page)).filter((m) => m.kind === 'approval').map((m) => m.tabId)
}

async function approvalNotices(app: ElectronApplication): Promise<string[]> {
  return (await osOutlets(app)).notifications.map((n) => n.body).filter((b) => /approval/.test(b))
}

async function postFailed(fake: FakeDiscord, how: PostFailure): Promise<void> {
  await expect
    .poll(() => fake.failedPosts.filter((p) => p.how === how).length, { timeout: 30_000 })
    .toBeGreaterThan(0)
}

async function aliveTabs(page: Page): Promise<string[]> {
  const all = await page.evaluate(() => window.api.sessions.list())
  return all.filter((s) => s.alive).map((s) => s.tabId)
}

test.describe('today, with no Discord at all, a session asking for a password while the owner is away', () => {
  test('raises no attention mark and no notification, though the box shows in the session and the row reads as asking', async ({
    env
  }) => {
    seedSettings(env, { hintsOff: true })
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const tab = await sessionTab(page, env)
      await askSudo(page, tab)
      await expect(page.locator(SUDO_BOX)).toBeVisible({ timeout: 30_000 })
      await expect(page.locator(`.ws .ws-tab[data-tab-id="${tab}"]`)).toHaveClass(/st-approval/)
      await page.waitForTimeout(NOTHING_RAISES_IT_LATER_MS)
      expect(await marksAsking(page)).toEqual([])
      expect(await approvalNotices(app)).toEqual([])
      await page.locator(`${SUDO_BOX} input`).fill('pw')
      await page.keyboard.press('Enter')
      await expect.poll(() => terminalText(page, tab)).toContain('pw\ngot-it')
    } finally {
      await quitAndClose(app)
    }
  })

  test('control: the same ask with the owner at the Mac raises the mark and a notification', async ({
    env
  }) => {
    seedSettings(env, { hintsOff: true })
    presenceFile(env, 'active')
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      const tab = await sessionTab(page, env)
      await askSudo(page, tab)
      await expect(page.locator(SUDO_BOX)).toBeVisible({ timeout: 30_000 })
      await expect.poll(() => marksAsking(page)).toEqual([tab])
      await expect.poll(async () => (await approvalNotices(app)).length).toBeGreaterThan(0)
    } finally {
      await quitAndClose(app)
    }
  })
})

test.describe('today, when Discord does not take a secret card', () => {
  for (const how of ['unreachable', 'forbidden', 'gone'] as const) {
    test(`a sudo card that fails as ${how} raises no attention mark and no notification, the box stays in the session until the owner answers there, and the owner coming back raises nothing either`, async ({
      env
    }) => {
      seedBinding(env)
      const presence = presenceFile(env, 'idle')
      const fake = await startFakeDiscord(env)
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        await expect.poll(() => fake.identifies).toBe(1)
        await waitConductorStarted(env, CONDUCTOR_STARTS_MS)
        const tab = await sessionTab(page, env)
        fake.failPostsIn[CHANNEL] = how
        await askSudo(page, tab)
        await postFailed(fake, how)
        if (how === 'unreachable') await expectNoToastAtAnyMomentOfAWindow(page)
        else await expect(page.locator('.toast')).toHaveText(POST_REFUSED_TOAST)
        await expect(page.locator(SUDO_BOX)).toBeVisible()
        await expect(page.locator(`.ws .ws-tab[data-tab-id="${tab}"]`)).toHaveClass(/st-approval/)
        expect(fake.posted.filter((p) => /asks for your sudo password/.test(p.content))).toEqual([])
        expect(await marksAsking(page)).toEqual([])
        expect(await approvalNotices(app)).toEqual([])

        fs.writeFileSync(presence, 'active')
        await pretendWindowFocused(app)
        await page.waitForTimeout(NOTHING_RAISES_IT_LATER_MS)
        expect(await marksAsking(page)).toEqual([])
        await expect(page.locator(SUDO_BOX)).toBeVisible()
        await page.locator(`${SUDO_BOX} input`).fill('pw-back')
        await page.keyboard.press('Enter')
        await expect.poll(() => terminalText(page, tab)).toContain('pw-back\ngot-it')
      } finally {
        await quitAndClose(app)
        await fake.close()
      }
    })
  }

  test('a page-tap card whose picture and card Discord refuses raises no attention mark, and the ask waits in the session’s Workbench', async ({
    env
  }) => {
    seedBinding(env)
    const fake = await startFakeDiscord(env)
    const server = await startEchoServer()
    const app = await launchApp(env)
    try {
      const url = server.page('/check', '<!doctype html><title>check</title><div id="box">x</div>')
      const page = await app.firstWindow()
      await waitBooted(page)
      await expect.poll(() => fake.identifies).toBe(1)
      await waitConductorStarted(env, CONDUCTOR_STARTS_MS)
      const tab = await sessionTab(page, env)
      await type(page, tab, `/koloft open ${url}`)
      const guest = await guestByUrl(app, '/check')
      await expect(guest.locator('#box')).toBeVisible()
      fake.failPostsIn[CHANNEL] = 'forbidden'
      await type(page, tab, '/koloft page tap "#box" -- "Tick the box."')
      await postFailed(fake, 'forbidden')
      await expect(page.locator(SECRET_BAR)).toBeVisible()
      await page.waitForTimeout(NOTHING_RAISES_IT_LATER_MS)
      expect(await marksAsking(page)).toEqual([])
      expect(await approvalNotices(app)).toEqual([])
    } finally {
      await quitAndClose(app)
      await fake.close()
      await server.close()
    }
  })

  const OTHER_AGENTS_ON_THIS_MAC = [
    { label: 'Codex' as const, install: (env: E2EEnv) => installCodex(env) },
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

  async function secretUrlFailsSilently(
    app: ElectronApplication,
    page: Page,
    fake: FakeDiscord
  ): Promise<void> {
    await openSessionTerminal(app, page)
    const shell = (await page.locator('.wb-panel .wb-term:visible').getAttribute('data-pty'))!
    fake.failPostsIn[CHANNEL] = 'forbidden'
    await type(page, shell, 'koloft secret url "https://auth.example.test/authorize?client=x"')
    await postFailed(fake, 'forbidden')
    await expect(page.locator(SECRET_BAR)).toBeVisible()
    await page.waitForTimeout(NOTHING_RAISES_IT_LATER_MS)
    expect(await marksAsking(page)).toEqual([])
    expect(await approvalNotices(app)).toEqual([])
  }

  for (const agent of OTHER_AGENTS_ON_THIS_MAC) {
    test(`in a ${agent.label} session on this Mac, a refused sign-in card raises no attention mark either`, async ({
      env
    }) => {
      seedBinding(env)
      agent.install(env)
      const fake = await startFakeDiscord(env)
      const app = await launchApp(env)
      try {
        const page = await app.firstWindow()
        await waitBooted(page)
        await expect.poll(() => fake.identifies).toBe(1)
        await waitConductorStarted(env, CONDUCTOR_STARTS_MS)
        if (agent.label === 'Antigravity') {
          await newSessionInWith(page, 'ws-a', agent.label)
          await runIn(page, centerTerm(page), 'first words')
          await expect(wsRows(page, 'ws-a')).toHaveClass(/\bst-waiting\b/, { timeout: 60_000 })
        } else await startSessionIn(page, 'ws-a', { method: agent.label })
        await secretUrlFailsSilently(app, page, fake)
      } finally {
        await quitAndClose(app)
        await fake.close()
      }
    })
  }

  test.describe('on another machine', () => {
    test.afterEach(({ env }) => killFakeRemote(env))

    for (const agent of [{ label: 'Claude' as const }, ...OTHER_AGENTS_ON_THE_MACHINE]) {
      test(`in a ${agent.label} session on another machine, a refused sign-in card raises no attention mark either`, async ({
        env
      }) => {
        test.setTimeout(240_000)
        const other = 'install' in agent ? agent : undefined
        seedBinding(env)
        other?.install(env)
        const fake = await startFakeDiscord(env)
        const { app, page } = await launchWithRemote(env)
        try {
          await expect.poll(() => fake.identifies).toBe(1)
          await waitConductorStarted(env, CONDUCTOR_STARTS_MS)
          await addRemoteWorkspace(page, env)
          if (other) {
            await newSessionInWith(page, REMOTE_WS_NAME, other.label)
            await other.bound?.(page)
          } else await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
          await secretUrlFailsSilently(app, page, fake)
        } finally {
          await quitAndClose(app)
          await fake.close()
        }
      })
    }
  })
})

test.describe('today, when Discord refuses what the butler posts', () => {
  async function butler(env: E2EEnv, fake: FakeDiscord) {
    const app = await launchApp(env)
    const page = await app.firstWindow()
    await waitBooted(page)
    await expect.poll(() => fake.identifies).toBe(1)
    await waitConductorStarted(env, CONDUCTOR_STARTS_MS)
    await expect.poll(async () => (await aliveTabs(page)).length).toBe(1)
    const [tab] = await aliveTabs(page)
    return { app, page, tab }
  }

  test('its question card fails, but its question still raises the attention mark at the Mac', async ({
    env
  }) => {
    seedBinding(env)
    const fake = await startFakeDiscord(env)
    const { app, page, tab } = await butler(env, fake)
    try {
      fake.failPostsIn[CHANNEL] = 'forbidden'
      fake.say(OWNER, '/ask Which colour?|Red|Green')
      await postFailed(fake, 'forbidden')
      await expect.poll(() => marksAsking(page), { timeout: 30_000 }).toEqual([tab])
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('its reply to the owner fails, and its finished turn raises no mark at the Mac', async ({
    env
  }) => {
    seedBinding(env)
    const fake = await startFakeDiscord(env)
    const { app, page, tab } = await butler(env, fake)
    try {
      fake.failPostsIn[CHANNEL] = 'forbidden'
      fake.say(OWNER, 'hello there')
      await expect
        .poll(() => fake.failedPosts.map((p) => p.content).join('\n'), { timeout: 30_000 })
        .toContain('hello there')
      await page.waitForTimeout(NOTHING_RAISES_IT_LATER_MS)
      expect((await pendingAttention(page)).filter((m) => m.tabId === tab)).toEqual([])
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('its koloft discord send, the way the away digest and the morning report reach the owner, fails back to the butler only', async ({
    env
  }) => {
    seedBinding(env)
    const fake = await startFakeDiscord(env)
    const { app, page, tab } = await butler(env, fake)
    try {
      fake.failPostsIn[CHANNEL] = 'forbidden'
      await type(page, tab, '/koloft discord send -- "Three sessions finished."')
      await expect
        .poll(() => terminalText(page, tab), { timeout: 30_000 })
        .toMatch(/koloft exit=[1-9]/)
      expect(await terminalText(page, tab)).toContain('Discord answered 403')
      expect(fake.posted.filter((p) => p.content.includes('Three sessions'))).toEqual([])
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })
})
