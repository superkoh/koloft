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
import { startEchoServer } from './helpers/fixtureServer'
import { FILLED_AND_EMPTIED } from '../../src/main/agentSecret'
import { PASSED_ON } from '../../src/main/discord/secretAsks'

test.setTimeout(120_000)
test.afterEach(({ env }) => killFakeRemote(env))

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

function nowhereInDiscord(fake: FakeDiscord, typed: string): void {
  const said = JSON.stringify([fake.posted, fake.edits, fake.callbacks])
  expect(said).not.toContain(typed)
}

test.describe('Discord secrets: the owner gives a session a password or sign-in address from Discord, which Koloft passes on and Discord never shows', () => {
  test('sudo’s password helper posts a card with the command in the butler’s channel, naming the session and its workspace; the owner’s button opens a form, and what is typed there reaches sudo and nothing else', async ({
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
      await type(
        page,
        tab,
        `/sh "$(dirname "$(command -v koloft)")/koloft-askpass" 'Password:' && echo got-it`
      )
      const card = await secretCard(fake, /^🔑 \*\*.+ · ws-a\*\* asks for your sudo password/)
      expect(card.content).toContain('sudo asked: Password:')
      const typed = 'hunter2-sudo "x" \\'
      await enter(fake, card, typed)
      await expect.poll(() => terminalText(page, tab)).toContain('got-it')
      expect(await terminalText(page, tab)).toContain(typed)
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
      server.route('/auth/callback', (_q, res) => {
        res.writeHead(200)
        res.end('signed in')
      })
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

  for (const agent of [{ label: 'Claude' as const }, ...OTHER_AGENTS_ON_THE_MACHINE]) {
    test(`koloft secret url, run in a ${agent.label} session on another machine, names that machine to the owner and opens the pasted 127.0.0.1 address there over ssh, not on this Mac`, async ({
      env
    }) => {
      test.setTimeout(240_000)
      seedBinding(env)
      if ('install' in agent) agent.install(env)
      const fake = await startFakeDiscord(env)
      const server = await startEchoServer()
      const { app, page } = await launchWithRemote(env)
      try {
        server.route('/auth/callback', (_q, res) => {
          res.writeHead(200)
          res.end('signed in')
        })
        await expect.poll(() => fake.identifies).toBe(1)
        await waitConductorStarted(env, CONDUCTOR_STARTS_MS)
        await addRemoteWorkspace(page, env)
        if ('install' in agent) {
          await newSessionInWith(page, REMOTE_WS_NAME, agent.label)
          await agent.bound?.(page)
        } else await startSessionIn(page, REMOTE_WS_NAME, { remote: true })
        await openSessionTerminal(app, page)
        await runIn(
          page,
          panelTerm(page),
          'koloft secret url "https://auth.example.test/authorize?client=r"'
        )
        const card = await secretCard(fake, /needs the address a sign-in ends on/)
        expect(card.content).toContain(`Koloft opens it on ${REMOTE_HOST}.`)
        const pasted = server.url('/auth/callback?code=c-2&state=s-2')
        await enter(fake, card, pasted)
        await expect
          .poll(() => server.requestsFor('/auth/callback').map((r) => r.search))
          .toEqual(['?code=c-2&state=s-2'])
        expect(
          sshCommands(env).filter((c) => c.includes('curl') && c.includes(pasted))
        ).toHaveLength(1)
        await expect(panelTerm(page)).toContainText(
          `Koloft opened the address on ${REMOTE_HOST}; it answered 200.`,
          { timeout: 30_000 }
        )
      } finally {
        await quitAndClose(app)
        await fake.close()
        await server.close()
      }
    })
  }

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
