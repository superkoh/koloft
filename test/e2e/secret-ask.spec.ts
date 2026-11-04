import fs from 'fs'
import path from 'path'
import type { Page } from '@playwright/test'
import { test, expect, launchApp, pendingAttention, quitAndClose } from './helpers/app'
import type { E2EEnv } from './helpers/env'
import { startSessionIn, terminalText, waitForCalls } from './helpers/p1'
import { guestByUrl } from './helpers/browser'
import { startEchoServer } from './helpers/fixtureServer'
import { OWNER_DECLINED, OWNER_FILLED } from '../../src/main/agentSecret'

test.setTimeout(120_000)

const SIGN_IN_HOST = 'koloft-a.test'
const SECRET_BAR = '[role="alertdialog"][aria-label="Secret ask"]'
const SUDO_BOX = '.term-wrap .secret-modal'

function ownerAtTheMac(env: E2EEnv): void {
  const presence = path.join(env.home, 'presence.txt')
  fs.writeFileSync(presence, 'active')
  env.launchEnv.KOLOFT_TEST_PRESENCE_FILE = presence
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

const unwrapped = (s: string): string => s.replace(/\s+/g, '')

async function askSudo(page: Page, tab: string): Promise<void> {
  await type(
    page,
    tab,
    `/sh "$(dirname "$(command -v koloft)")/koloft-askpass" 'Password:' && echo got-it`
  )
  await expect(page.locator(SUDO_BOX)).toBeVisible({ timeout: 30_000 })
}

test.describe('Koloft asks the owner for a password in the session’s own tab, with no Discord bound', () => {
  test('sudo’s password helper shows a box over that session’s terminal, which holds the keys, marks the row and the bell as needing the owner, and passes what is typed to sudo alone; Esc turns it down', async ({
    env
  }) => {
    ownerAtTheMac(env)
    const app = await launchApp(env)
    try {
      const page = await app.firstWindow()
      const tab = await sessionTab(page, env)
      await askSudo(page, tab)
      const row = page.locator(`.ws-tab[data-tab-id="${tab}"]`)
      await expect(row).toHaveClass(/\bst-approval\b/)
      await expect
        .poll(async () => (await pendingAttention(page)).find((e) => e.tabId === tab)?.kind)
        .toBe('approval')
      await expect(page.locator(SUDO_BOX)).toContainText('sudo asks: Password:')
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label')))
        .toBe('Your sudo password')
      const typed = 'hunter2-box "x" \\'
      await page.keyboard.type(typed)
      await page.keyboard.press('Enter')
      await expect(page.locator(SUDO_BOX)).toHaveCount(0)
      await expect.poll(() => terminalText(page, tab)).toContain(`${typed}\ngot-it`)
      await expect(row).not.toHaveClass(/\bst-approval\b/)
      expect((await pendingAttention(page)).some((e) => e.kind === 'approval')).toBe(false)

      await askSudo(page, tab)
      await page.keyboard.press('Escape')
      await expect
        .poll(async () => unwrapped(await terminalText(page, tab)))
        .toContain(unwrapped(OWNER_DECLINED))
      await expect(page.locator(SUDO_BOX)).toHaveCount(0)
    } finally {
      await quitAndClose(app)
    }
  })

  test('koloft secret page brings the page forward in the session’s Workbench with a bar above it; the owner types into the page itself, and once it moves on the session hears the owner filled it in', async ({
    env
  }) => {
    ownerAtTheMac(env)
    const server = await startEchoServer()
    const app = await launchApp(env)
    try {
      const login = server.page(
        '/login',
        '<!doctype html><title>login</title><form id="f" action="/done"><label for="pw">Password</label><input type="password" id="pw" name="pw"><button id="go">Sign in</button></form>'
      )
      server.page('/done', '<!doctype html><title>done</title>')
      const page = await app.firstWindow()
      const tab = await sessionTab(page, env)
      await type(page, tab, `/koloft open ${login}`)
      const guest = await guestByUrl(app, '/login')
      await expect(guest.locator('#pw')).toBeVisible()
      await type(page, tab, '/koloft secret page "#pw"')
      await expect(page.locator(SECRET_BAR)).toContainText('needs your Password on this page')
      await expect(page.locator(`.ws-tab[data-tab-id="${tab}"]`)).toHaveClass(/\bst-approval\b/)
      await guest.locator('#pw').fill('typed-by-the-owner')
      await guest.locator('#go').click()
      await expect.poll(() => guest.title()).toBe('done')
      await expect
        .poll(async () => unwrapped(await terminalText(page, tab)))
        .toContain(unwrapped(OWNER_FILLED))
      await expect(page.locator(SECRET_BAR)).toHaveCount(0)
      expect(await terminalText(page, tab)).not.toContain('typed-by-the-owner')
    } finally {
      await quitAndClose(app)
      await server.close()
    }
  })

  test('koloft secret url opens the sign-in in the session’s Workbench with a bar above it; once it lands on its 127.0.0.1 address the session hears it finished, without the address and its code', async ({
    env
  }) => {
    ownerAtTheMac(env)
    const server = await startEchoServer()
    const cli = await startEchoServer()
    env.extraArgs.push(`--host-resolver-rules=MAP ${SIGN_IN_HOST} 127.0.0.1`)
    const app = await launchApp(env)
    try {
      cli.route('/auth/callback', (_q, res) => {
        res.writeHead(200)
        res.end('signed in')
      })
      const callback = `http://localhost:${cli.port}/auth/callback?code=c-8`
      server.page(
        '/authorize',
        `<!doctype html><title>sign in</title><a id="go" href="${callback}">Continue</a>`
      )
      const page = await app.firstWindow()
      const tab = await sessionTab(page, env)
      await type(page, tab, `/koloft secret url "${server.hostUrl(SIGN_IN_HOST, '/authorize')}"`)
      const signIn = await guestByUrl(app, '/authorize')
      await expect(page.locator(SECRET_BAR)).toContainText('finish this sign-in here')
      await signIn.locator('#go').click()
      await expect
        .poll(() => cli.requestsFor('/auth/callback').map((r) => r.search))
        .toEqual(['?code=c-8'])
      await expect
        .poll(() => terminalText(page, tab))
        .toContain('finished the sign-in in this session')
      await expect(page.locator(SECRET_BAR)).toHaveCount(0)
      expect(await terminalText(page, tab)).not.toContain('c-8')
    } finally {
      await quitAndClose(app)
      await server.close()
      await cli.close()
    }
  })
})
