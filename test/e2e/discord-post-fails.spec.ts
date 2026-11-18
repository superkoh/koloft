import type { ElectronApplication, Page } from '@playwright/test'
import { test, expect, launchApp, osOutlets, pendingAttention, quitAndClose } from './helpers/app'
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

async function approvalNotices(app: ElectronApplication): Promise<number> {
  return (await osOutlets(app)).notifications.filter((n) => /approval/.test(n.body)).length
}

async function markedAtTheMac(app: ElectronApplication, page: Page): Promise<void> {
  await expect.poll(async () => (await marksAsking(page)).length, { timeout: 30_000 }).toBe(1)
  await expect.poll(() => approvalNotices(app)).toBeGreaterThan(0)
}

async function postFailed(fake: FakeDiscord, how: PostFailure): Promise<void> {
  await expect
    .poll(() => fake.failedPosts.filter((p) => p.how === how).length, { timeout: 30_000 })
    .toBeGreaterThan(0)
}

async function answerTheSudoBox(page: Page, tab: string, typed: string): Promise<void> {
  await page.locator(`${SUDO_BOX} input`).fill(typed)
  await page.keyboard.press('Enter')
  await expect.poll(() => terminalText(page, tab)).toContain(`${typed}\ngot-it`)
  await expect.poll(() => marksAsking(page)).toEqual([])
}

test.describe('a session’s password ask that cannot reach the owner on Discord is marked at the Mac as if the owner were there', () => {
  test('with no Discord set up, an ask made while the owner is away raises the attention mark, a notification and an Inbox card that sends the owner to the session’s tab, and the answer in the box clears them', async ({
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
      await markedAtTheMac(app, page)
      expect(await marksAsking(page)).toEqual([tab])
      await page.locator('.ibx-entry').click()
      const card = page.locator('.inbox-page .ibx-item', {
        has: page.locator('.ibx-what', { hasText: /is waiting for you in its tab/ })
      })
      await card.getByText('Open session', { exact: true }).click()
      await expect(page.locator('.inbox-page')).toHaveCount(0)
      await expect(page.locator(SUDO_BOX)).toBeVisible()
      await answerTheSudoBox(page, tab, 'pw')
    } finally {
      await quitAndClose(app)
    }
  })

  for (const how of ['unreachable', 'forbidden', 'gone'] as const) {
    test(`a sudo card Discord does not take (${how}) raises the mark and a notification, and the answer in the box clears them`, async ({
      env
    }) => {
      seedBinding(env)
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
        await markedAtTheMac(app, page)
        expect(await marksAsking(page)).toEqual([tab])
        await expect(page.locator(SUDO_BOX)).toBeVisible()
        await answerTheSudoBox(page, tab, 'pw-back')
      } finally {
        await quitAndClose(app)
        await fake.close()
      }
    })
  }

  test('a page-tap card whose picture and card Discord both refuse raises the mark, while the ask waits in the session’s Workbench', async ({
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
      await markedAtTheMac(app, page)
      await expect(page.locator(SECRET_BAR)).toBeVisible()
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

  async function refusedSignInCardIsMarked(
    app: ElectronApplication,
    page: Page,
    fake: FakeDiscord
  ): Promise<void> {
    await openSessionTerminal(app, page)
    const shell = (await page.locator('.wb-panel .wb-term:visible').getAttribute('data-pty'))!
    fake.failPostsIn[CHANNEL] = 'forbidden'
    await type(page, shell, 'koloft secret url "https://auth.example.test/authorize?client=x"')
    await postFailed(fake, 'forbidden')
    await markedAtTheMac(app, page)
    await expect(page.locator(SECRET_BAR)).toBeVisible()
  }

  for (const agent of OTHER_AGENTS_ON_THIS_MAC) {
    test(`in a ${agent.label} session on this Mac, a sign-in card Discord refuses raises the mark`, async ({
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
        await refusedSignInCardIsMarked(app, page, fake)
      } finally {
        await quitAndClose(app)
        await fake.close()
      }
    })
  }

  test.describe('on another machine', () => {
    test.afterEach(({ env }) => killFakeRemote(env))

    for (const agent of [{ label: 'Claude' as const }, ...OTHER_AGENTS_ON_THE_MACHINE]) {
      test(`in a ${agent.label} session on another machine, a sign-in card Discord refuses raises the mark`, async ({
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
          await refusedSignInCardIsMarked(app, page, fake)
        } finally {
          await quitAndClose(app)
          await fake.close()
        }
      })
    }
  })
})

test('a question card of the butler’s that Discord refuses still leaves its question marked at the Mac', async ({
  env
}) => {
  seedBinding(env)
  const fake = await startFakeDiscord(env)
  const app = await launchApp(env)
  try {
    const page = await app.firstWindow()
    await waitBooted(page)
    await expect.poll(() => fake.identifies).toBe(1)
    await waitConductorStarted(env, CONDUCTOR_STARTS_MS)
    fake.failPostsIn[CHANNEL] = 'forbidden'
    fake.say(OWNER, '/ask Which colour?|Red|Green')
    await postFailed(fake, 'forbidden')
    await expect.poll(async () => (await marksAsking(page)).length, { timeout: 30_000 }).toBe(1)
  } finally {
    await quitAndClose(app)
    await fake.close()
  }
})
