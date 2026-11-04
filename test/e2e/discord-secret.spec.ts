import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp, quitAndClose } from './helpers/app'
import { seedSettings, type E2EEnv } from './helpers/env'
import {
  newSessionInWith,
  openSessionTerminal,
  panelTerm,
  runIn,
  startSessionIn,
  terminalText,
  waitBooted,
  waitConductorStarted,
  waitForCalls
} from './helpers/p1'
import {
  addRemoteWorkspace,
  killFakeRemote,
  launchWithRemote,
  OTHER_AGENTS_ON_THE_MACHINE,
  REMOTE_HOST,
  REMOTE_WS_NAME,
  sshCommands
} from './helpers/remote'
import {
  OPEN_A_FORM,
  startFakeDiscord,
  type FakeDiscord,
  type FakePost
} from './helpers/fakeDiscord'
import { guestByUrl } from './helpers/browser'
import { startEchoServer, type FixtureServer } from './helpers/fixtureServer'
import { FILLED_AND_EMPTIED } from '../../src/main/agentSecret'
import { ANSWERED_IN_KOLOFT, NO_LONGER_WAITING, PASSED_ON } from '../../src/main/discord/secretAsks'

test.setTimeout(120_000)

const OWNER = { id: '555', username: 'letian' }
const CHANNEL = '222'
const CONDUCTOR_STARTS_MS = 60_000

function seedBinding(env: E2EEnv): void {
  seedSettings(env, {
    hintsOff: true,
    assist: { on: true, backend: 'claude' },
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

const SUDO_BOX = '.term-wrap .secret-modal'
const SECRET_BAR = '[role="alertdialog"][aria-label="Secret ask"]'

function askSudo(page: Page, tab: string): Promise<void> {
  return type(
    page,
    tab,
    `/sh "$(dirname "$(command -v koloft)")/koloft-askpass" 'Password:' && echo got-it`
  )
}

async function secretCard(fake: FakeDiscord, header: RegExp): Promise<FakePost> {
  const card = (): FakePost | undefined =>
    fake.posted.find((p) => p.channelId === CHANNEL && header.test(p.content))
  await expect.poll(card, { timeout: CONDUCTOR_STARTS_MS }).toBeTruthy()
  return card()!
}

async function enter(fake: FakeDiscord, card: FakePost, typed: string): Promise<void> {
  fake.press(OWNER, card.buttons![0], card.channelId)
  await expect
    .poll(() => fake.callbacks.find((c) => c.type === OPEN_A_FORM)?.data.custom_id)
    .toBe(card.buttons![0].id)
  fake.submit(OWNER, card.buttons![0].id, typed, card.channelId)
  await expect.poll(() => fake.callbacks.map((c) => c.data.content)).toContain(PASSED_ON)
}

function answerSignIn(server: FixtureServer): void {
  server.route('/auth/callback', (_q, res) => {
    res.writeHead(200)
    res.end('signed in')
  })
}

function nowhereInDiscord(fake: FakeDiscord, typed: string): void {
  const said = JSON.stringify([fake.posted, fake.edits, fake.callbacks])
  expect(said).not.toContain(typed)
}

test.describe('Discord secrets: the owner gives a session a password or sign-in address from Discord, which Koloft passes on and Discord never shows', () => {
  test('sudo’s password helper posts a card with the command in the butler’s channel, naming the session and its workspace; the owner’s button opens a form, and what is typed there reaches sudo and nothing else, and the box Koloft shows in the session meanwhile goes', async ({
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
      await askSudo(page, tab)
      const card = await secretCard(fake, /^🔑 \*\*.+ · ws-a\*\* asks for your sudo password/)
      expect(card.content).toContain('sudo asked: Password:')
      await expect(page.locator(SUDO_BOX)).toBeVisible()
      const typed = 'hunter2-sudo "x" \\'
      await enter(fake, card, typed)
      await expect.poll(() => terminalText(page, tab)).toContain(`${typed}\ngot-it`)
      await expect(page.locator(SUDO_BOX)).toHaveCount(0)
      await expect
        .poll(() =>
          fake.edits
            .filter((e) => e.id === card.id)
            .map((e) => e.content)
            .join('\n')
        )
        .toContain('✅ Passed on.')
      nowhereInDiscord(fake, typed)
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('answered in the Koloft box first, the sudo card in Discord says so and loses its button, and a press on it opens no form', async ({
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
      await askSudo(page, tab)
      const card = await secretCard(fake, /asks for your sudo password/)
      const typed = 'hunter2-in-koloft'
      await page.locator(`${SUDO_BOX} input`).fill(typed)
      await page.locator(`${SUDO_BOX} .btn-primary`).click()
      await expect.poll(() => terminalText(page, tab)).toContain(`${typed}\ngot-it`)
      const edited = (): FakePost | undefined => fake.edits.filter((e) => e.id === card.id).at(-1)
      await expect.poll(() => edited()?.content).toContain(ANSWERED_IN_KOLOFT)
      expect(edited()?.buttons ?? []).toEqual([])
      fake.press(OWNER, card.buttons![0], card.channelId)
      await expect
        .poll(() => fake.callbacks.map((c) => c.data.content))
        .toContain(NO_LONGER_WAITING)
      expect(fake.callbacks.some((c) => c.type === OPEN_A_FORM)).toBe(false)
      nowhereInDiscord(fake, typed)
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('while the owner is at the Mac, sudo asks only in the Koloft box and posts no card to Discord', async ({
    env
  }) => {
    seedBinding(env)
    const presence = path.join(env.home, 'presence.txt')
    fs.writeFileSync(presence, 'active')
    env.launchEnv.KOLOFT_TEST_PRESENCE_FILE = presence
    const fake = await startFakeDiscord(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await expect.poll(() => fake.identifies).toBe(1)
      await waitConductorStarted(env, CONDUCTOR_STARTS_MS)
      const tab = await sessionTab(page, env)
      await askSudo(page, tab)
      await page.locator(`${SUDO_BOX} input`).fill('pw-at-the-mac')
      await page.keyboard.press('Enter')
      await expect.poll(() => terminalText(page, tab)).toContain('pw-at-the-mac\ngot-it')
      expect(fake.posted.filter((p) => /asks for your sudo password/.test(p.content))).toEqual([])
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })

  test('koloft secret page names the page’s site and the field to the owner in the butler’s channel, fills what the owner typed into it, submits the form, and empties a field the page kept', async ({
    env
  }) => {
    seedBinding(env)
    const fake = await startFakeDiscord(env)
    const server = await startEchoServer()
    const app = await launchApp(env)
    try {
      const login = server.page(
        '/login',
        '<!doctype html><title>login</title><form id="f"><label for="pw">Password</label><input type="password" id="pw"></form>' +
          '<script>document.getElementById("f").addEventListener("submit",function(e){e.preventDefault();document.title="submitted:"+document.getElementById("pw").value})</script>'
      )
      const page = await app.firstWindow()
      await waitBooted(page)
      await expect.poll(() => fake.identifies).toBe(1)
      await waitConductorStarted(env, CONDUCTOR_STARTS_MS)
      const tab = await sessionTab(page, env)
      await type(page, tab, `/koloft open ${login}`)
      const guest = await guestByUrl(app, '/login')
      await expect(guest.locator('#pw')).toBeVisible()
      await type(page, tab, '/koloft secret page "#pw"')
      const card = await secretCard(
        fake,
        /^🔑 \*\*.+ · ws-a\*\* asks you to fill in a field on a web page/
      )
      expect(card.content).toContain(`Page: ${server.origin}`)
      expect(card.content).toContain('Field: Password')
      const typed = 'hunter2-page'
      await enter(fake, card, typed)
      await expect.poll(() => guest.title()).toBe(`submitted:${typed}`)
      const unwrapped = (s: string): string => s.replace(/\s+/g, '')
      await expect
        .poll(async () => unwrapped(await terminalText(page, tab)))
        .toContain(unwrapped(FILLED_AND_EMPTIED))
      expect(await guest.locator('#pw').inputValue()).toBe('')
      nowhereInDiscord(fake, typed)
    } finally {
      await quitAndClose(app)
      await fake.close()
      await server.close()
    }
  })

  test('koloft secret url shows the owner the sign-in address in the butler’s channel and opens the 127.0.0.1 address the owner pastes on the session’s machine', async ({
    env
  }) => {
    seedBinding(env)
    const fake = await startFakeDiscord(env)
    const server = await startEchoServer()
    const app = await launchApp(env)
    try {
      answerSignIn(server)
      const page = await app.firstWindow()
      await waitBooted(page)
      await expect.poll(() => fake.identifies).toBe(1)
      await waitConductorStarted(env, CONDUCTOR_STARTS_MS)
      const tab = await sessionTab(page, env)
      await type(page, tab, '/koloft secret url "https://auth.example.test/authorize?client=x"')
      const card = await secretCard(
        fake,
        /^🔑 \*\*.+ · ws-a\*\* needs the address a sign-in ends on/
      )
      expect(card.content).toContain('https://auth.example.test/authorize?client=x')
      const pasted = server.url('/auth/callback?code=c-1&state=s-1')
      await enter(fake, card, pasted)
      await expect
        .poll(() => server.requestsFor('/auth/callback').map((r) => r.search))
        .toEqual(['?code=c-1&state=s-1'])
      await expect.poll(() => terminalText(page, tab)).toContain('answered 200')
    } finally {
      await quitAndClose(app)
      await fake.close()
      await server.close()
    }
  })

  test.describe('on another machine', () => {
    test.afterEach(({ env }) => killFakeRemote(env))

    for (const agent of [{ label: 'Claude' as const }, ...OTHER_AGENTS_ON_THE_MACHINE]) {
      test(`koloft secret url, run in a ${agent.label} session on another machine, names that machine to the owner and opens the pasted 127.0.0.1 address there over ssh, not on this Mac`, async ({
        env
      }) => {
        test.setTimeout(240_000)
        const other = 'install' in agent ? agent : undefined
        seedBinding(env)
        other?.install(env)
        const fake = await startFakeDiscord(env)
        const server = await startEchoServer()
        const { app, page } = await launchWithRemote(env)
        try {
          answerSignIn(server)
          await expect.poll(() => fake.identifies).toBe(1)
          await waitConductorStarted(env, CONDUCTOR_STARTS_MS)
          await addRemoteWorkspace(page, env)
          if (other) {
            await newSessionInWith(page, REMOTE_WS_NAME, other.label)
            await other.bound?.(page)
          } else await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
          await openSessionTerminal(app, page)
          const shell = (await page.locator('.wb-panel .wb-term:visible').getAttribute('data-pty'))!
          await runIn(
            page,
            panelTerm(page),
            'koloft secret url "https://auth.example.test/authorize?client=r"'
          )
          const card = await secretCard(fake, /needs the address a sign-in ends on/)
          expect(card.content).toContain(`Koloft opens it on ${REMOTE_HOST}.`)
          await expect(page.locator(SECRET_BAR)).toContainText('finish this sign-in here')
          const pasted = server.url('/auth/callback?code=c-2&state=s-2')
          await enter(fake, card, pasted)
          await expect(page.locator(SECRET_BAR)).toHaveCount(0)
          await expect
            .poll(() => server.requestsFor('/auth/callback').map((r) => r.search))
            .toEqual(['?code=c-2&state=s-2'])
          expect(
            sshCommands(env).filter((c) => c.includes('curl') && c.includes(pasted))
          ).toHaveLength(1)
          const bare = (s: string): string => s.replace(/\s+/g, '')
          await expect
            .poll(async () => bare(await terminalText(page, shell)), { timeout: 30_000 })
            .toContain(bare(`Koloft opened the address on ${REMOTE_HOST}; it answered 200.`))
        } finally {
          await quitAndClose(app)
          await fake.close()
          await server.close()
        }
      })
    }
  })

  test('the butler’s own secret card in its channel names only the butler', async ({ env }) => {
    seedBinding(env)
    const fake = await startFakeDiscord(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      await waitBooted(page)
      await expect.poll(() => fake.identifies).toBe(1)
      await waitConductorStarted(env, CONDUCTOR_STARTS_MS)
      fake.say(OWNER, '/koloft secret url "https://auth.example.test/authorize?client=b"')
      const card = await secretCard(fake, /^🔑 \*\*Alfred\*\* needs the address a sign-in ends on/)
      expect(card.content).toContain('https://auth.example.test/authorize?client=b')
    } finally {
      await quitAndClose(app)
      await fake.close()
    }
  })
})
